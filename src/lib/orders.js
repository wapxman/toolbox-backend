// Общая логика заказов (Taketool 1.1: магазин + доставка).
// Таблица rentals — это и есть заказы: kind = rent | buy | courier_return,
// fulfillment = pickup (из бокса) | delivery (курьером по Ташкенту).
//
// ПРОДАЖА — это НОВЫЕ единицы со склада (tools.sale_stock), а не арендный экземпляр
// из ячейки. Остаток списывается в момент подтверждения оплаты, возвращается при отмене.
//
// Жизненный цикл (status / delivery_status):
//   pending_payment ──(оплата)──►
//     rent + pickup   : active                (замок открыт сразу)      → completed при возврате в бокс
//     rent + delivery : pending_delivery/paid → packed → dispatched → delivered ⇒ active (срок с delivered_at)
//     buy  + pickup   : pending_delivery/paid → ready (админ положил новую единицу в ячейку)
//                       → клиент открывает ячейку из приложения ⇒ completed/delivered
//     buy  + delivery : pending_delivery/paid → packed → dispatched → delivered ⇒ completed
//     courier_return  : pending_delivery/paid → dispatched → picked_up ⇒ completed,
//                       родительская аренда completed, restock_pending (инструмент вне бокса)
//   cancelled — клиентом до dispatched/ready или админом; после оплаты refund_status = pending,
//               админ возвращает деньги в кассе и ставит done.

const supabase = require('./supabase');
const kerong = require('./kerong');
// Уведомления идут через outbox (lib/notify): сперва строка в базе, потом доставка
// с повторами. html`…` экранирует подставленное — в сообщения попадает ввод клиента.
const { notifyUser, notifyAdmin, html } = require('./notify');
const wheel = require('./wheel');

const TZ_OFFSET = '+05:00'; // Ташкент

// --- Настройки (app_settings), кэш 60 сек ---
const DEFAULT_PRICING = { discount3_pct: 20, discount7_pct: 35, overdue_multiplier: 1.5 };
const DEFAULT_DELIVERY = {
  fee: 50000,
  city: 'Ташкент',
  slots: [{ start: '10:00', end: '14:00' }, { start: '14:00', end: '18:00' }, { start: '18:00', end: '22:00' }],
  same_day_min_hours: 2,
  days_ahead: 2,
};
const DEFAULT_SUPPORT = { phone: '+998935236060', telegram: null, email: 'support@taketool.uz' };
const DEFAULT_TERMS = { version: '2026-09-21', date: '2026-09-21', url: 'https://www.taketool.uz/terms.html', title: 'Пользовательское соглашение (публичная оферта)' };
const cache = {};
async function getSetting(key, defaults) {
  const c = cache[key];
  if (c && Date.now() - c.ts < 60_000) return c.value;
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
    cache[key] = { value: { ...defaults, ...(data?.value || {}) }, ts: Date.now() };
  } catch {
    cache[key] = { value: defaults, ts: Date.now() };
  }
  return cache[key].value;
}
const getPricing = () => getSetting('pricing', DEFAULT_PRICING);
const getDelivery = () => getSetting('delivery', DEFAULT_DELIVERY);
const getSupport = () => getSetting('support', DEFAULT_SUPPORT);
const getTerms = () => getSetting('terms', DEFAULT_TERMS);

function calculatePrice(dayPrice, days, pricing = DEFAULT_PRICING) {
  if (days >= 7) return Math.round(days * dayPrice * (1 - pricing.discount7_pct / 100));
  if (days >= 3) return Math.round(days * dayPrice * (1 - pricing.discount3_pct / 100));
  return days * dayPrice;
}

// Штраф за просрочку на текущий момент (0, если срок не вышел)
async function overdueFeeFor(rental, at = new Date()) {
  const expectedEnd = new Date(rental.expected_end);
  if (at <= expectedEnd) return 0;
  const { overdue_multiplier } = await getPricing();
  const overdueDays = Math.ceil((at - expectedEnd) / 86_400_000);
  const base = (rental.items_price != null ? rental.items_price - (rental.discount || 0) : rental.total_price);
  return Math.round(overdueDays * (base / (rental.days || 1)) * overdue_multiplier);
}

// --- Интервалы доставки ---
function tashkentDate(offsetDays = 0) {
  const d = new Date(Date.now() + 5 * 3600_000 + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}
function slotStart(date, hhmm) { return new Date(`${date}T${hhmm}:00${TZ_OFFSET}`); }

async function availableSlots() {
  const s = await getDelivery();
  const out = [];
  const labels = ['Сегодня', 'Завтра', 'Послезавтра'];
  for (let i = 0; i < (s.days_ahead || 2); i++) {
    const date = tashkentDate(i);
    for (const sl of s.slots || []) {
      const start = slotStart(date, sl.start);
      const available = start.getTime() - Date.now() >= (s.same_day_min_hours || 2) * 3600_000;
      out.push({ date, start: sl.start, end: sl.end, label: `${labels[i] || date}, ${sl.start}–${sl.end}`, available });
    }
  }
  return out;
}

async function resolveSlot(slot) {
  if (!slot || !slot.date || !slot.start) return { error: 'Выберите интервал доставки' };
  const all = await availableSlots();
  const found = all.find(x => x.date === slot.date && x.start === slot.start);
  if (!found) return { error: 'Такого интервала нет' };
  if (!found.available) return { error: 'Этот интервал уже недоступен, выберите другой' };
  return {
    start: slotStart(found.date, found.start).toISOString(),
    end: slotStart(found.date, found.end).toISOString(),
    label: found.label,
  };
}

// --- Штраф за просрочку: отдельный счёт (kind = penalty) ---
// Создаётся при возврате просроченной аренды. Аренда закрывается по факту возврата,
// счёт висит pending_payment, пока клиент не оплатит. Неоплаченный штраф блокирует новые аренды.
async function createPenalty(rental, fee, provider = 'payme') {
  if (!(fee > 0)) return null;
  const { data: existing } = await supabase.from('rentals').select('id')
    .eq('parent_rental_id', rental.id).eq('kind', 'penalty').limit(1);
  if (existing && existing.length) return existing[0];
  const now = new Date().toISOString();
  const { data: pen, error } = await supabase.from('rentals').insert({
    user_id: rental.user_id, tool_id: rental.tool_id, kind: 'penalty', fulfillment: 'pickup',
    parent_rental_id: rental.id, days: 0, started_at: now, expected_end: now,
    status: 'pending_payment', items_price: fee, discount: 0, delivery_fee: 0, total_price: fee,
    payment_provider: provider === 'click' ? 'click' : 'payme',
  }).select().single();
  if (error) { console.error('createPenalty', error.message); return null; }
  await notifyUser(rental.user_id, pen.id, 'overdue', 'Счёт за просрочку',
    `По аренде №${rental.order_number} начислен штраф ${fmt(fee)} сум (п. 4 оферты). Оплатите его в разделе «Заказы» — до оплаты новые аренды недоступны.`,
    { event: 'penalty.created', dedupeKey: `penalty.created:${pen.id}:user` });
  await notifyAdmin(
    html`⚠️ <b>Штраф за просрочку</b> №${pen.order_number} — ${fmt(fee)} сум по аренде №${rental.order_number} (${rental.tools?.name || ''})`,
    { event: 'penalty.created', dedupeKey: `penalty.created:${pen.id}:ops` });
  return pen;
}

// Неоплаченные штрафы пользователя (для блокировки новых аренд)
async function unpaidPenalties(userId) {
  const { data } = await supabase.from('rentals')
    .select('id, order_number, total_price, parent_rental_id, created_at')
    .eq('user_id', userId).eq('kind', 'penalty').eq('status', 'pending_payment')
    .order('created_at', { ascending: true });
  return data || [];
}

// --- Загрузка заказа с инструментом/ячейкой/боксом ---
const RENTAL_FULL = '*, tools(id, name, cell_id, sale_stock, cells(cell_number, kerong_lock_number, boxes(*))), pickup_cell:cells!rentals_pickup_cell_id_fkey(id, cell_number, kerong_lock_number, boxes(*))';
async function loadRental(id) {
  if (!id || !/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const { data, error } = await supabase.from('rentals').select(RENTAL_FULL).eq('id', id).single();
  if (error) console.error('loadRental', error.message);
  return data || null;
}

async function openLock(cell) {
  const zoneId = cell?.boxes?.kerong_zone_id || 1;
  // ⚠️ Номер замка берём ТОЛЬКО из явного поля. Прежний запасной вариант
  // «номер ячейки минус один» — догадка: стоит нумерации ячеек разойтись с
  // разводкой платы, и откроется чужая ячейка с чужим инструментом. Нет
  // настроенного номера — honest отказ и зов оператора, а не случайный замок.
  const lockNumber = cell?.kerong_lock_number;
  if (lockNumber == null) {
    throw new Error(`Для ячейки ${cell?.cell_number ?? '?'} не задан номер замка (kerong_lock_number)`);
  }
  await kerong.openLock(zoneId, lockNumber);
}
// Ячейка заказа: для покупки с самовывозом — pickup_cell, иначе ячейка арендного экземпляра
function cellOf(rental) {
  if (rental.kind === 'buy') return rental.pickup_cell || null;
  return rental.tools?.cells || null;
}
async function openCellFor(rental) { await openLock(cellOf(rental)); }

const fmt = n => Number(n || 0).toLocaleString('ru-RU');
function describe(r) {
  const what = r.kind === 'buy' ? 'покупка' : r.kind === 'courier_return' ? 'возврат курьером' : `аренда ${r.days} дн.`;
  const how = r.fulfillment === 'delivery' ? 'доставка' : 'из бокса';
  return `${r.tools?.name || 'инструмент'} — ${what}, ${how}`;
}
function addressLine(r) {
  const parts = [r.delivery_address];
  if (r.delivery_entrance) parts.push(`подъезд ${r.delivery_entrance}`);
  if (r.delivery_floor) parts.push(`этаж ${r.delivery_floor}`);
  if (r.delivery_apt) parts.push(`кв. ${r.delivery_apt}`);
  return parts.filter(Boolean).join(', ');
}

// Всё, что нужно курьеру: куда, когда, кому звонить и что просил клиент.
// Один блок на аренду, покупку и вызов курьера — раньше каждое сообщение
// собиралось по-своему, и комментарий клиента («домофон не работает, звоните»)
// попадал ТОЛЬКО в аренду с доставкой. По покупке курьер его не видел.
function deliveryBlock(r) {
  return html`${addressLine(r)}\n${r.delivery_slot_label || ''}\n☎ ${r.recipient_phone || ''}`
    + (r.delivery_comment ? html`\n💬 ${r.delivery_comment}` : '');
}

// --- Склад новых единиц ---
// Списать одну единицу; вернёт true, если остаток был > 0.
async function takeStock(toolId) {
  // ⚠️ Одной операцией в базе. Прежняя версия читала остаток, писала остаток-1
  // и при гонке вызывала себя заново — без ограничения глубины, то есть могла
  // уйти в бесконечный цикл под нагрузкой.
  const { data, error } = await supabase.rpc('stock_take', { tool: toolId });
  if (error) { console.error('takeStock', error.message); return false; }
  return data === true;
}

/** Занять ячейку. Возвращает false, если её уже заняли.
 *
 *  ⚠️ Ячейка занималась безусловным UPDATE: два оплаченных заказа на один
 *  инструмент оба её «занимали» и оба открывали замок — один инструмент
 *  продавался дважды. Теперь занять может только тот, кто застал её свободной.
 */
async function claimCell(cellId) {
  if (!cellId) return false;
  const { data, error } = await supabase.rpc('cell_claim', { cell: cellId });
  if (error) { console.error('claimCell', error.message); return false; }
  return data === true;
}
async function returnStock(toolId) {
  const { error } = await supabase.rpc('stock_return', { tool: toolId });
  if (error) console.error('returnStock', error.message);
}

/** Вернуть складскую единицу по заказу — ровно один раз.
 *
 *  ⚠️ Возврат склада зовут три места: общая отмена, отмена со стороны кассы и
 *  кнопка «вернул в бокс» в админке. По одному заказу они срабатывали дважды,
 *  и остаток рос из воздуха. Отметка ставится атомарно: кто её поставил, тот и
 *  возвращает единицу.
 */
async function returnStockOnce(rental) {
  if (!rental || rental.kind !== 'buy' || !rental.tool_id) return false;
  const { data, error } = await supabase
    .from('rentals')
    .update({ stock_returned: true })
    .eq('id', rental.id)
    .eq('stock_returned', false)
    .select('id');
  if (error) { console.error('returnStockOnce', error.message); return false; }
  if (!data || !data.length) return false; // уже возвращали
  await returnStock(rental.tool_id);
  return true;
}

// --- Подтверждение оплаты (Payme PerformTransaction / Click Complete) ---
async function confirmPayment(rentalId, { method, paymentId, amountSum }) {
  const rental = await loadRental(rentalId);
  if (!rental) return null;
  if (rental.status !== 'pending_payment') return rental; // быстрый выход: уже обработан

  const now = new Date();
  const nowIso = now.toISOString();

  // ⚠️ АТОМАРНЫЙ ЗАХВАТ ПРАВА ОБРАБОТАТЬ ПЛАТЁЖ. Проверка статуса выше — не
  // блокировка: два обработчика кассы (или Payme и Click одновременно) успевали
  // прочитать `pending_payment` оба и оба выполняли выдачу, списание склада и
  // открытие замка. Здесь же условие проверяет сама база одной операцией:
  // кто первым проставил paid_at — тот и обрабатывает, второй уходит ни с чем.
  const { data: claimed, error: claimErr } = await supabase
    .from('rentals')
    .update({ status: 'processing_payment', paid_at: nowIso })
    .eq('id', rentalId)
    .eq('status', 'pending_payment')
    .is('paid_at', null)
    .select('id');
  if (claimErr) throw new Error('не удалось зафиксировать оплату: ' + claimErr.message);
  if (!claimed || !claimed.length) {
    // Гонку проиграли — заказ уже обрабатывает кто-то другой.
    // ⚠️ Платёж всё равно фиксируем в журнале: иначе второй самостоятельный
    // платёж (клиент открыл и Payme, и Click) исчезает из учёта, и вернуть
    // его будет не на основании чего.
    await supabase.from('transactions').insert({
      rental_id: rentalId, user_id: rental.user_id,
      amount: Math.round(Number(amountSum)), type: 'payment',
      payment_method: method, payment_id: String(paymentId), status: 'duplicate',
    });
    await notifyAdmin(
      html`⚠️ <b>Повторный платёж</b> по заказу №${rental.order_number} — ${fmt(amountSum)} сум (${method}). Проверьте необходимость возврата.`,
      { event: 'payment.duplicate', dedupeKey: `payment.duplicate:${rentalId}:${paymentId}` });
    return await loadRental(rentalId);
  }

  await supabase.from('transactions').insert({
    rental_id: rentalId, user_id: rental.user_id,
    amount: Math.round(Number(amountSum)), type: 'payment',
    payment_method: method, payment_id: String(paymentId), status: 'success',
  });
  const paidText = `Оплачено ${fmt(amountSum)} сум через ${method === 'click' ? 'Click' : 'Payme'}.`;
  const name = rental.tools?.name || 'инструмент';
  // Касса может прислать PerformTransaction повторно. Статус выше уже защищает от
  // повторной обработки, а эти ключи — от повторного сообщения, если две попытки
  // кассы придут одновременно и обе пройдут проверку статуса.
  const paidKey = (to) => ({ event: 'order.paid', dedupeKey: `order.paid:${rentalId}:${to}` });

  // 0) Оплата штрафа за просрочку: счёт закрыт, блокировка снята
  if (rental.kind === 'penalty') {
    await supabase.from('rentals').update({ status: 'completed', paid_at: nowIso, actual_end: nowIso }).eq('id', rentalId);
    await notifyUser(rental.user_id, rentalId, 'payment', 'Штраф оплачен',
      `${paidText} Спасибо — новые аренды снова доступны.`, paidKey('user'));
    return rental;
  }

  // 0.1) Оплата продления: только теперь двигаем срок родительской аренды.
  // До оплаты счёт висит отдельным заказом, а аренда живёт со старым сроком —
  // иначе инструментом пользуются дольше оплаченного.
  if (rental.kind === 'extension') {
    const extraDays = Number(rental.days || 0);
    const { data: parent } = await supabase
      .from('rentals')
      .select('id, days, expected_end, status, order_number, tools(name)')
      .eq('id', rental.parent_rental_id)
      .single();

    if (parent) {
      // Отсчитываем от большей из двух дат: если срок уже вышел, продление
      // должно давать дни от сегодня, а не задним числом закрывать просрочку.
      const base = new Date(Math.max(new Date(parent.expected_end).getTime(), now.getTime()));
      const newEnd = new Date(base.getTime() + extraDays * 86400_000);
      await supabase.from('rentals').update({
        days: Number(parent.days || 0) + extraDays,
        expected_end: newEnd.toISOString(),
        // Просрочка снимается только потому, что срок действительно оплачен.
        status: parent.status === 'overdue' ? 'active' : parent.status,
      }).eq('id', parent.id);
    }

    await supabase.from('rentals')
      .update({ status: 'completed', paid_at: nowIso, actual_end: nowIso })
      .eq('id', rentalId);
    await notifyUser(rental.user_id, rental.parent_rental_id || rentalId, 'payment', 'Аренда продлена',
      `${paidText} Срок увеличен на ${extraDays} дн.`, paidKey('user'));
    return await loadRental(rentalId);
  }

  // 1) Вызов курьера за арендованным инструментом
  if (rental.kind === 'courier_return') {
    await supabase.from('rentals').update({ status: 'pending_delivery', delivery_status: 'paid', paid_at: nowIso }).eq('id', rentalId);
    if (rental.parent_rental_id) {
      await supabase.from('rentals').update({ return_method: 'courier' }).eq('id', rental.parent_rental_id);
    }
    await notifyUser(rental.user_id, rentalId, 'payment', 'Курьер вызван',
      `${paidText} Курьер заберёт ${name}: ${rental.delivery_slot_label || 'в выбранное время'}.`, paidKey('user'));
    await notifyAdmin(
      html`🔁 <b>Возврат курьером</b> №${rental.order_number}\n${name}\n` + deliveryBlock(rental),
      paidKey('ops'));
    return rental;
  }

  // 2) Покупка (новая единица со склада): списываем остаток, ждём сборки/выдачи
  if (rental.kind === 'buy') {
    // ⚠️ Нет остатка — заказ не принимаем. Раньше результат takeStock уходил
    // лишь припиской в сообщение оператору: клиент оплачивал товар, которого
    // на складе нет, и узнавал об этом в лучшем случае от менеджера.
    const ok = await takeStock(rental.tool_id);
    if (!ok) {
      await supabase.from('rentals').update({
        status: 'cancelled', cancelled_at: nowIso, refund_status: 'pending',
      }).eq('id', rentalId);
      await returnBonusById(rentalId);
      await notifyUser(rental.user_id, rentalId, 'info', 'Товара не осталось',
        `${paidText} К сожалению, ${name} закончился на складе. Деньги вернём в течение 1–3 рабочих дней.`,
        paidKey('user'));
      await notifyAdmin(
        html`🚨 <b>Оплачен товар без остатка</b> №${rental.order_number} — ${name}, ${fmt(rental.total_price)} сум к возврату`,
        { event: 'order.no_stock', dedupeKey: `order.no_stock:${rentalId}` });
      return await loadRental(rentalId);
    }
    await supabase.from('rentals').update({ status: 'pending_delivery', delivery_status: 'paid', paid_at: nowIso }).eq('id', rentalId);
    if (rental.fulfillment === 'delivery') {
      await notifyUser(rental.user_id, rentalId, 'payment', 'Покупка оплачена',
        `${paidText} Курьер привезёт ${name}: ${rental.delivery_slot_label || 'в выбранное время'}.`, paidKey('user'));
    } else {
      await notifyUser(rental.user_id, rentalId, 'payment', 'Покупка оплачена',
        `${paidText} Мы положим новый ${name} в ячейку бокса и пришлём уведомление — тогда его можно будет забрать.`, paidKey('user'));
    }
    const how = rental.fulfillment === 'delivery'
      ? '🚚 ' + deliveryBlock(rental)
      : '📦 Самовывоз: положить новую единицу в свободную ячейку и нажать «Готов к выдаче»';
    await notifyAdmin(
      html`🛒 <b>Покупка</b> №${rental.order_number} — ${name}, ${fmt(rental.total_price)} сум\n`
      + how
      + (ok ? '' : '\n⚠️ ОСТАТКА НА СКЛАДЕ НЕ БЫЛО — проверьте наличие'),
      paidKey('ops'));
    return rental;
  }

  // 3) Аренда с доставкой: ждём курьера, ячейку резервируем (экземпляр поедет клиенту)
  if (rental.fulfillment === 'delivery') {
    // Тот же захват, что и для самовывоза: экземпляр поедет клиенту, и второй
    // оплаченный заказ не должен получить тот же инструмент.
    if (rental.tools?.cell_id) {
      const got = await claimCell(rental.tools.cell_id);
      if (!got) {
        await supabase.from('rentals').update({
          status: 'cancelled', cancelled_at: nowIso, refund_status: 'pending',
        }).eq('id', rentalId);
        await returnBonusById(rentalId);
        await notifyUser(rental.user_id, rentalId, 'info', 'Инструмент уже занят',
          `${paidText} К сожалению, ${name} забрали раньше. Деньги вернём в течение 1–3 рабочих дней.`,
          paidKey('user'));
        await notifyAdmin(
          html`🚨 <b>Оплачен занятый инструмент</b> №${rental.order_number} — ${name}, деньги к возврату`,
          { event: 'order.cell_taken', dedupeKey: `order.cell_taken:${rentalId}` });
        return await loadRental(rentalId);
      }
    }
    await supabase.from('rentals').update({ status: 'pending_delivery', delivery_status: 'paid', paid_at: nowIso }).eq('id', rentalId);
    await notifyUser(rental.user_id, rentalId, 'payment', 'Заказ оплачен',
      `${paidText} Курьер привезёт ${name}: ${rental.delivery_slot_label || 'в выбранное время'}.`, paidKey('user'));
    await notifyAdmin(
      html`🚚 <b>Аренда с доставкой</b> №${rental.order_number}\n${describe(rental)}\n${fmt(rental.total_price)} сум\n`
      + deliveryBlock(rental),
      paidKey('ops'));
    return rental;
  }

  // 4) Аренда из бокса — активируем и открываем замок.
  // ⚠️ Сначала ПЫТАЕМСЯ занять ячейку, и только если она была свободна,
  // активируем аренду. Экземпляр не резервируется до оплаты (так задумано),
  // поэтому два оплаченных заказа могли достаться одной ячейке: оба получали
  // активную аренду и открытый замок, а инструмент там один.
  if (rental.tools?.cell_id) {
    const got = await claimCell(rental.tools.cell_id);
    if (!got) {
      // Деньги уже приняты. Инструмента нет — заказ отменяем с пометкой на
      // возврат и зовём оператора: это не та ситуация, которую можно замять.
      await supabase.from('rentals').update({
        status: 'cancelled', cancelled_at: nowIso, refund_status: 'pending',
      }).eq('id', rentalId);
      await returnBonusById(rentalId);
      await notifyUser(rental.user_id, rentalId, 'info', 'Инструмент уже занят',
        `${paidText} К сожалению, ${name} забрали раньше. Деньги вернём в течение 1–3 рабочих дней.`,
        paidKey('user'));
      await notifyAdmin(
        html`🚨 <b>Оплачен занятый инструмент</b> №${rental.order_number} — ${name}
` +
        html`${fmt(rental.total_price)} сум к возврату, ячейку занял другой заказ`,
        { event: 'order.cell_taken', dedupeKey: `order.cell_taken:${rentalId}` });
      return await loadRental(rentalId);
    }
  }

  const expectedEnd = new Date(now);
  expectedEnd.setDate(expectedEnd.getDate() + (rental.days || 1));
  await supabase.from('rentals').update({
    status: 'active', paid_at: nowIso, started_at: nowIso, expected_end: expectedEnd.toISOString(),
  }).eq('id', rentalId);
  let lockOpened = true;
  try {
    await openCellFor(rental);
  } catch (e) {
    // Клиент заплатил и стоит у бокса, а замок не открылся. Раньше об этом знал
    // только лог Vercel, куда никто не смотрит, — зовём оператора.
    lockOpened = false;
    console.error('rent pickup: lock open failed', e.message);
    await notifyAdmin(
      html`🚨 <b>Замок не открылся</b> по оплаченной аренде №${rental.order_number}\n${name}, ячейка ${cellOf(rental)?.cell_number || '?'}\n${e.message}\n☎ клиент ждёт у бокса`,
      { event: 'lock.failed', dedupeKey: `lock.failed:${rentalId}` });
  }
  await notifyUser(rental.user_id, rentalId, 'payment', 'Оплата прошла',
    lockOpened
      ? `${paidText} Замок открыт — заберите инструмент!`
      : `${paidText} Замок не открылся — мы уже разбираемся. Нажмите «Открыть ячейку» в заказе через минуту или напишите в поддержку.`,
    paidKey('user'));
  return rental;
}

// Клиент забирает оплаченную покупку из ячейки (delivery_status = ready)
async function pickupPurchase(rental) {
  if (rental.kind !== 'buy' || rental.fulfillment !== 'pickup') return { error: 'Это не покупка с самовывозом' };
  if (rental.status !== 'pending_delivery' || rental.delivery_status !== 'ready') {
    return { error: 'Заказ ещё не готов к выдаче — дождитесь уведомления' };
  }
  try { await openCellFor(rental); } catch (e) {
    return { error: 'Не удалось открыть ячейку. Попробуйте через минуту или напишите в поддержку.', lock_failed: true };
  }
  const nowIso = new Date().toISOString();
  await supabase.from('rentals').update({
    status: 'completed', delivery_status: 'delivered', delivered_at: nowIso, actual_end: nowIso,
  }).eq('id', rental.id);
  if (rental.pickup_cell_id) await supabase.from('cells').update({ status: 'free' }).eq('id', rental.pickup_cell_id);
  await notifyUser(rental.user_id, rental.id, 'info', 'Покупка выдана', `${rental.tools?.name || 'Инструмент'} — спасибо за покупку!`);
  return { ok: true, cell_number: rental.pickup_cell?.cell_number };
}

/** Вернуть на счёт бонус, ушедший в этот заказ.
 *
 *  Живёт рядом с отменой и зовётся из единственного места — самой отмены:
 *  разложи возврат по роутам, и какой-нибудь путь рано или поздно забудут,
 *  а бонус сгорит ни за что.
 *
 *  Сбой возврата не рушит отмену: заказ отменить важнее. Ошибка уходит в лог,
 *  бонус можно вернуть руками — обратное (отменить нельзя, потому что не
 *  вернулся бонус) было бы хуже для человека.
 */
async function returnBonus(rental) {
  if (!rental || !(rental.bonus_applied > 0)) return;
  try {
    await wheel.refund(rental.user_id, rental.id);
  } catch (e) {
    console.error('bonus refund error:', rental.id, e);
  }
}

/** Вернуть бонус по id заказа — для путей отмены, где самого заказа под рукой
 *  нет: крон брошенных, отмена транзакции в Payme и Click.
 *
 *  ⚠️ Эти пути меняют статус напрямую, мимо cancelOrder, и до появления этой
 *  функции бонус у них просто сгорал: заказ отменён, деньги не вернулись.
 *  Повторный вызов безопасен — wheel.refund сверяется с уже возвращённым.
 */
async function returnBonusById(rentalId) {
  if (!rentalId) return;
  try {
    const { data } = await supabase
      .from('rentals')
      .select('id, user_id, bonus_applied')
      .eq('id', rentalId)
      .maybeSingle();
    await returnBonus(data);
  } catch (e) {
    console.error('bonus refund by id error:', rentalId, e);
  }
}

// Отмена заказа. Возвращает {ok, refund_required} или {error}.
async function cancelOrder(rental, by = 'user') {
  if (!rental) return { error: 'Заказ не найден' };
  if (rental.status === 'cancelled') return { ok: true };
  const nowIso = new Date().toISOString();

  if (rental.status === 'pending_payment') {
    if (rental.kind === 'penalty' && by === 'user') return { error: 'Штраф отменить нельзя. По вопросам — в поддержку.' };
    // ⚠️ Отмена пишется ТОЛЬКО если заказ всё ещё в том состоянии, которое мы
    // проверяли. Раньше запись шла по id: пока шла проверка, оплата успевала
    // активировать аренду и открыть замок — а отмена всё равно проходила.
    const { data: done, error: cancelErr } = await supabase
      .from('rentals')
      .update({ status: 'cancelled', cancelled_at: nowIso })
      .eq('id', rental.id)
      .eq('status', 'pending_payment')
      .select('id');
    if (cancelErr) return { error: 'Не удалось отменить заказ' };
    if (!done || !done.length) {
      return { error: 'Заказ изменился — обновите список и попробуйте снова' };
    }
    await returnBonus(rental);
    if (rental.kind === 'penalty') {
      await notifyUser(rental.user_id, rental.id, 'info', 'Штраф списан', `Счёт №${rental.order_number} аннулирован администратором.`);
    }
    return { ok: true, refund_required: false };
  }
  if (rental.status !== 'pending_delivery') return { error: 'Этот заказ уже нельзя отменить' };
  if (['dispatched', 'delivered', 'picked_up'].includes(rental.delivery_status)) {
    return { error: 'Курьер уже в пути — отмена невозможна, свяжитесь с поддержкой' };
  }
  if (by === 'user' && rental.delivery_status === 'ready') {
    return { error: 'Покупка уже лежит в ячейке — для отмены свяжитесь с поддержкой' };
  }

  // Инструмент физически вне полки/ячейки? — ждём, пока сотрудник вернёт его
  const outOfPlace = rental.delivery_status === 'packed' || rental.delivery_status === 'ready';

  // Та же защита: отменяем только то, что ещё в ожидании доставки. Пока шла
  // проверка, сотрудник мог отправить курьера — тогда отменять уже нельзя.
  const { data: done2, error: cancelErr2 } = await supabase
    .from('rentals')
    .update({
      status: 'cancelled', cancelled_at: nowIso, refund_status: 'pending', restock_pending: outOfPlace,
    })
    .eq('id', rental.id)
    .eq('status', 'pending_delivery')
    .eq('delivery_status', rental.delivery_status)
    .select('id');
  if (cancelErr2) return { error: 'Не удалось отменить заказ' };
  if (!done2 || !done2.length) {
    return { error: 'Заказ уже изменился — обновите список и попробуйте снова' };
  }
  await returnBonus(rental);

  if (rental.kind === 'buy') {
    if (!outOfPlace) await returnStockOnce(rental); // единица не тронута — сразу на склад
    // ready: единица в ячейке, ячейка занята до «в боксе/на складе» (restocked)
  } else if (rental.kind === 'rent') {
    if (!outOfPlace && rental.tools?.cell_id) await supabase.from('cells').update({ status: 'free' }).eq('id', rental.tools.cell_id);
  } else if (rental.kind === 'courier_return' && rental.parent_rental_id) {
    await supabase.from('rentals').update({ return_method: null }).eq('id', rental.parent_rental_id);
  }

  await notifyUser(rental.user_id, rental.id, 'info', 'Заказ отменён',
    `Заказ №${rental.order_number} отменён. Деньги (${fmt(rental.total_price)} сум) вернутся тем же способом оплаты в течение 1–3 рабочих дней.`,
    { event: 'order.cancelled', dedupeKey: `order.cancelled:${rental.id}:user` });
  await notifyAdmin(
    html`❌ <b>Отмена заказа</b> №${rental.order_number} (${by === 'user' ? 'клиент' : 'админ'})\n${describe(rental)}\n💸 Вернуть ${fmt(rental.total_price)} сум в кассе ${rental.payment_provider}`
    + (outOfPlace ? '\n📦 Инструмент вне места — вернуть в бокс/на склад' : ''),
    { event: 'order.cancelled', dedupeKey: `order.cancelled:${rental.id}:ops` });
  return { ok: true, refund_required: true };
}

module.exports = {
  getPricing, getDelivery, getSupport, getTerms, calculatePrice, overdueFeeFor, availableSlots, resolveSlot,
  createPenalty, unpaidPenalties,
  RENTAL_FULL, loadRental, openLock, cellOf, openCellFor, notifyUser, notifyAdmin,
  takeStock, returnStock, returnStockOnce, claimCell, confirmPayment, pickupPurchase, cancelOrder, returnBonusById,
  describe, addressLine, fmt,
};
