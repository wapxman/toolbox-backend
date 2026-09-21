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
    `По аренде №${rental.order_number} начислен штраф ${fmt(fee)} сум (п. 4 оферты). Оплатите его в разделе «Заказы» — до оплаты новые аренды недоступны.`);
  notifyAdmin(`⚠️ <b>Штраф за просрочку</b> №${pen.order_number} — ${fmt(fee)} сум по аренде №${rental.order_number} (${rental.tools?.name || ''})`);
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
  const lockNumber = cell?.kerong_lock_number ?? (cell?.cell_number != null ? cell.cell_number - 1 : null);
  if (lockNumber == null) throw new Error('Нет номера замка');
  await kerong.openLock(zoneId, lockNumber);
}
// Ячейка заказа: для покупки с самовывозом — pickup_cell, иначе ячейка арендного экземпляра
function cellOf(rental) {
  if (rental.kind === 'buy') return rental.pickup_cell || null;
  return rental.tools?.cells || null;
}
async function openCellFor(rental) { await openLock(cellOf(rental)); }

async function notifyUser(userId, rentalId, type, title, message) {
  if (!userId) return;
  try {
    await supabase.from('notifications').insert({ user_id: userId, rental_id: rentalId, type, title, message });
  } catch (e) { console.error('notify user failed', e.message); }
}

// Telegram операторам (env ADMIN_TG_TOKEN + ADMIN_TG_CHAT). Без env — тихо.
async function notifyAdmin(text) {
  const token = process.env.ADMIN_TG_TOKEN, chat = process.env.ADMIN_TG_CHAT;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('notify admin failed', e.message); }
}

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

// --- Склад новых единиц ---
// Списать одну единицу; вернёт true, если остаток был > 0.
async function takeStock(toolId) {
  const { data: t } = await supabase.from('tools').select('sale_stock').eq('id', toolId).single();
  const stock = Number(t?.sale_stock || 0);
  if (stock <= 0) return false;
  const { data } = await supabase.from('tools').update({ sale_stock: stock - 1 })
    .eq('id', toolId).eq('sale_stock', stock).select('id'); // optimistic lock
  if (!data || !data.length) return takeStock(toolId);        // гонка — повторим
  return true;
}
async function returnStock(toolId) {
  const { data: t } = await supabase.from('tools').select('sale_stock').eq('id', toolId).single();
  await supabase.from('tools').update({ sale_stock: Number(t?.sale_stock || 0) + 1 }).eq('id', toolId);
}

// --- Подтверждение оплаты (Payme PerformTransaction / Click Complete) ---
async function confirmPayment(rentalId, { method, paymentId, amountSum }) {
  const rental = await loadRental(rentalId);
  if (!rental) return null;
  if (rental.status !== 'pending_payment') return rental; // идемпотентность: уже подтверждали
  const now = new Date();
  const nowIso = now.toISOString();

  await supabase.from('transactions').insert({
    rental_id: rentalId, user_id: rental.user_id,
    amount: Math.round(Number(amountSum)), type: 'payment',
    payment_method: method, payment_id: String(paymentId), status: 'success',
  });
  const paidText = `Оплачено ${fmt(amountSum)} сум через ${method === 'click' ? 'Click' : 'Payme'}.`;
  const name = rental.tools?.name || 'инструмент';

  // 0) Оплата штрафа за просрочку: счёт закрыт, блокировка снята
  if (rental.kind === 'penalty') {
    await supabase.from('rentals').update({ status: 'completed', paid_at: nowIso, actual_end: nowIso }).eq('id', rentalId);
    await notifyUser(rental.user_id, rentalId, 'payment', 'Штраф оплачен',
      `${paidText} Спасибо — новые аренды снова доступны.`);
    return rental;
  }

  // 1) Вызов курьера за арендованным инструментом
  if (rental.kind === 'courier_return') {
    await supabase.from('rentals').update({ status: 'pending_delivery', delivery_status: 'paid', paid_at: nowIso }).eq('id', rentalId);
    if (rental.parent_rental_id) {
      await supabase.from('rentals').update({ return_method: 'courier' }).eq('id', rental.parent_rental_id);
    }
    await notifyUser(rental.user_id, rentalId, 'payment', 'Курьер вызван',
      `${paidText} Курьер заберёт ${name}: ${rental.delivery_slot_label || 'в выбранное время'}.`);
    notifyAdmin(`🔁 <b>Возврат курьером</b> №${rental.order_number}\n${name}\n${addressLine(rental)}\n${rental.delivery_slot_label || ''}\n☎ ${rental.recipient_phone || ''}`);
    return rental;
  }

  // 2) Покупка (новая единица со склада): списываем остаток, ждём сборки/выдачи
  if (rental.kind === 'buy') {
    const ok = await takeStock(rental.tool_id);
    await supabase.from('rentals').update({ status: 'pending_delivery', delivery_status: 'paid', paid_at: nowIso }).eq('id', rentalId);
    if (rental.fulfillment === 'delivery') {
      await notifyUser(rental.user_id, rentalId, 'payment', 'Покупка оплачена',
        `${paidText} Курьер привезёт ${name}: ${rental.delivery_slot_label || 'в выбранное время'}.`);
    } else {
      await notifyUser(rental.user_id, rentalId, 'payment', 'Покупка оплачена',
        `${paidText} Мы положим новый ${name} в ячейку бокса и пришлём уведомление — тогда его можно будет забрать.`);
    }
    notifyAdmin(`🛒 <b>Покупка</b> №${rental.order_number} — ${name}, ${fmt(rental.total_price)} сум\n` +
      (rental.fulfillment === 'delivery'
        ? `🚚 ${addressLine(rental)}\n${rental.delivery_slot_label || ''}\n☎ ${rental.recipient_phone || ''}`
        : `📦 Самовывоз: положить новую единицу в свободную ячейку и нажать «Готов к выдаче»`) +
      (ok ? '' : '\n⚠️ ОСТАТКА НА СКЛАДЕ НЕ БЫЛО — проверьте наличие'));
    return rental;
  }

  // 3) Аренда с доставкой: ждём курьера, ячейку резервируем (экземпляр поедет клиенту)
  if (rental.fulfillment === 'delivery') {
    await supabase.from('rentals').update({ status: 'pending_delivery', delivery_status: 'paid', paid_at: nowIso }).eq('id', rentalId);
    if (rental.tools?.cell_id) await supabase.from('cells').update({ status: 'occupied' }).eq('id', rental.tools.cell_id);
    await notifyUser(rental.user_id, rentalId, 'payment', 'Заказ оплачен',
      `${paidText} Курьер привезёт ${name}: ${rental.delivery_slot_label || 'в выбранное время'}.`);
    notifyAdmin(`🚚 <b>Аренда с доставкой</b> №${rental.order_number}\n${describe(rental)}\n${fmt(rental.total_price)} сум\n${addressLine(rental)}\n${rental.delivery_slot_label || ''}\n☎ ${rental.recipient_phone || ''}${rental.delivery_comment ? '\n💬 ' + rental.delivery_comment : ''}`);
    return rental;
  }

  // 4) Аренда из бокса — активируем и открываем замок
  const expectedEnd = new Date(now);
  expectedEnd.setDate(expectedEnd.getDate() + (rental.days || 1));
  await supabase.from('rentals').update({
    status: 'active', paid_at: nowIso, started_at: nowIso, expected_end: expectedEnd.toISOString(),
  }).eq('id', rentalId);
  if (rental.tools?.cell_id) await supabase.from('cells').update({ status: 'occupied' }).eq('id', rental.tools.cell_id);
  try { await openCellFor(rental); } catch (e) { console.error('rent pickup: lock open failed', e.message); }
  await notifyUser(rental.user_id, rentalId, 'payment', 'Оплата прошла', `${paidText} Замок открыт — заберите инструмент!`);
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

// Отмена заказа. Возвращает {ok, refund_required} или {error}.
async function cancelOrder(rental, by = 'user') {
  if (!rental) return { error: 'Заказ не найден' };
  if (rental.status === 'cancelled') return { ok: true };
  const nowIso = new Date().toISOString();

  if (rental.status === 'pending_payment') {
    if (rental.kind === 'penalty' && by === 'user') return { error: 'Штраф отменить нельзя. По вопросам — в поддержку.' };
    await supabase.from('rentals').update({ status: 'cancelled', cancelled_at: nowIso }).eq('id', rental.id);
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
  await supabase.from('rentals').update({
    status: 'cancelled', cancelled_at: nowIso, refund_status: 'pending', restock_pending: outOfPlace,
  }).eq('id', rental.id);

  if (rental.kind === 'buy') {
    if (!outOfPlace) await returnStock(rental.tool_id); // единица не тронута — сразу на склад
    // ready: единица в ячейке, ячейка занята до «в боксе/на складе» (restocked)
  } else if (rental.kind === 'rent') {
    if (!outOfPlace && rental.tools?.cell_id) await supabase.from('cells').update({ status: 'free' }).eq('id', rental.tools.cell_id);
  } else if (rental.kind === 'courier_return' && rental.parent_rental_id) {
    await supabase.from('rentals').update({ return_method: null }).eq('id', rental.parent_rental_id);
  }

  await notifyUser(rental.user_id, rental.id, 'info', 'Заказ отменён',
    `Заказ №${rental.order_number} отменён. Деньги (${fmt(rental.total_price)} сум) вернутся тем же способом оплаты в течение 1–3 рабочих дней.`);
  notifyAdmin(`❌ <b>Отмена заказа</b> №${rental.order_number} (${by === 'user' ? 'клиент' : 'админ'})\n${describe(rental)}\n💸 Вернуть ${fmt(rental.total_price)} сум в кассе ${rental.payment_provider}${outOfPlace ? '\n📦 Инструмент вне места — вернуть в бокс/на склад' : ''}`);
  return { ok: true, refund_required: true };
}

module.exports = {
  getPricing, getDelivery, getSupport, getTerms, calculatePrice, overdueFeeFor, availableSlots, resolveSlot,
  createPenalty, unpaidPenalties,
  RENTAL_FULL, loadRental, openLock, cellOf, openCellFor, notifyUser, notifyAdmin,
  takeStock, returnStock, confirmPayment, pickupPurchase, cancelOrder,
  describe, addressLine, fmt,
};
