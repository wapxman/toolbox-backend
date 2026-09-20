// Общая логика заказов (Taketool 1.1: магазин + доставка).
// Таблица rentals — это и есть заказы: kind = rent | buy | courier_return,
// fulfillment = pickup (из бокса) | delivery (курьером по Ташкенту).
//
// Жизненный цикл:
//   pending_payment → (оплата) →
//     pickup+rent  → active (замок открыт)            → completed при возврате
//     pickup+buy   → completed (замок открыт, tools.status = sold)
//     delivery/*   → pending_delivery (delivery_status paid → packed → dispatched → delivered)
//                    rent: delivered → active, срок идёт с момента передачи
//                    buy:  delivered → completed, инструмент sold
//     courier_return → pending_delivery → picked_up: родительская аренда completed
//   cancelled — клиентом до dispatched или админом; возврат денег — вручную в кассе.

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

function calculatePrice(dayPrice, days, pricing = DEFAULT_PRICING) {
  if (days >= 7) return Math.round(days * dayPrice * (1 - pricing.discount7_pct / 100));
  if (days >= 3) return Math.round(days * dayPrice * (1 - pricing.discount3_pct / 100));
  return days * dayPrice;
}

// --- Интервалы доставки ---
// Дата в Ташкенте (YYYY-MM-DD) со смещением дней
function tashkentDate(offsetDays = 0) {
  const d = new Date(Date.now() + 5 * 3600_000 + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}
function slotStart(date, hhmm) { return new Date(`${date}T${hhmm}:00${TZ_OFFSET}`); }

// Список доступных интервалов на ближайшие дни для приложения
async function availableSlots() {
  const s = await getDelivery();
  const out = [];
  const labels = ['Сегодня', 'Завтра', 'Послезавтра'];
  for (let i = 0; i < (s.days_ahead || 2); i++) {
    const date = tashkentDate(i);
    for (const sl of s.slots || []) {
      const start = slotStart(date, sl.start);
      const available = start.getTime() - Date.now() >= (s.same_day_min_hours || 2) * 3600_000;
      out.push({
        date, start: sl.start, end: sl.end,
        label: `${labels[i] || date}, ${sl.start}–${sl.end}`,
        available,
      });
    }
  }
  return out;
}

// Валидация выбранного интервала; вернёт {start,end,label} либо {error}
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

// --- Загрузка заказа с инструментом/ячейкой/боксом ---
async function loadRental(id) {
  if (!id || !/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const { data } = await supabase
    .from('rentals')
    .select('*, tools(id, name, cell_id, cells(cell_number, kerong_lock_number, boxes(*)))')
    .eq('id', id)
    .single();
  return data || null;
}

async function openCellFor(rental) {
  const cell = rental?.tools?.cells;
  const zoneId = cell?.boxes?.kerong_zone_id || 1;
  const lockNumber = cell?.kerong_lock_number ?? (cell?.cell_number != null ? cell.cell_number - 1 : null);
  if (lockNumber == null) throw new Error('Нет номера замка');
  await kerong.openLock(zoneId, lockNumber);
}

async function notifyUser(userId, rentalId, type, title, message) {
  if (!userId) return;
  try {
    await supabase.from('notifications').insert({ user_id: userId, rental_id: rentalId, type, title, message });
  } catch (e) { console.error('notify user failed', e.message); }
}

// Telegram-уведомление операторам (env ADMIN_TG_TOKEN + ADMIN_TG_CHAT). Без env — тихо.
async function notifyAdmin(text) {
  const token = process.env.ADMIN_TG_TOKEN, chat = process.env.ADMIN_TG_CHAT;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

// --- Подтверждение оплаты (вызывают Payme PerformTransaction и Click Complete) ---
async function confirmPayment(rentalId, { method, paymentId, amountSum }) {
  const rental = await loadRental(rentalId);
  if (!rental) return null;
  const now = new Date();

  await supabase.from('transactions').insert({
    rental_id: rentalId,
    user_id: rental.user_id,
    amount: Math.round(Number(amountSum)),
    type: 'payment',
    payment_method: method,
    payment_id: String(paymentId),
    status: 'success',
  });

  const paidText = `Оплачено ${fmt(amountSum)} сум через ${method === 'click' ? 'Click' : 'Payme'}.`;

  // 1) Вызов курьера для возврата арендованного инструмента
  if (rental.kind === 'courier_return') {
    await supabase.from('rentals').update({
      status: 'pending_delivery', delivery_status: 'paid', paid_at: now.toISOString(),
    }).eq('id', rentalId);
    if (rental.parent_rental_id) {
      await supabase.from('rentals').update({ return_method: 'courier' }).eq('id', rental.parent_rental_id);
    }
    await notifyUser(rental.user_id, rentalId, 'payment', 'Курьер вызван',
      `${paidText} Курьер заберёт инструмент: ${rental.delivery_slot_label || 'в выбранное время'}.`);
    notifyAdmin(`🔁 <b>Возврат курьером</b> №${rental.order_number}\n${rental.tools?.name}\n${addressLine(rental)}\n${rental.delivery_slot_label || ''}\n☎ ${rental.recipient_phone || ''}`);
    return rental;
  }

  // 2) Доставка (аренда или покупка): ждём курьера, ячейку резервируем
  if (rental.fulfillment === 'delivery') {
    await supabase.from('rentals').update({
      status: 'pending_delivery', delivery_status: 'paid', paid_at: now.toISOString(),
    }).eq('id', rentalId);
    if (rental.tools?.cell_id) {
      await supabase.from('cells').update({ status: 'occupied' }).eq('id', rental.tools.cell_id);
    }
    await notifyUser(rental.user_id, rentalId, 'payment', 'Заказ оплачен',
      `${paidText} Курьер привезёт ${rental.tools?.name}: ${rental.delivery_slot_label || 'в выбранное время'}.`);
    notifyAdmin(`🚚 <b>Новый заказ с доставкой</b> №${rental.order_number}\n${describe(rental)}\n${fmt(rental.total_price)} сум\n${addressLine(rental)}\n${rental.delivery_slot_label || ''}\n☎ ${rental.recipient_phone || ''}${rental.delivery_comment ? '\n💬 ' + rental.delivery_comment : ''}`);
    return rental;
  }

  // 3) Покупка из бокса: ячейка открывается, инструмент продан
  if (rental.kind === 'buy') {
    await supabase.from('rentals').update({
      status: 'completed', paid_at: now.toISOString(), actual_end: now.toISOString(),
      started_at: now.toISOString(), expected_end: now.toISOString(),
      delivery_status: 'delivered', delivered_at: now.toISOString(),
    }).eq('id', rentalId);
    await supabase.from('tools').update({ status: 'sold' }).eq('id', rental.tool_id);
    if (rental.tools?.cell_id) {
      await supabase.from('cells').update({ status: 'free' }).eq('id', rental.tools.cell_id);
    }
    try { await openCellFor(rental); } catch (e) { console.error('buy pickup: lock open failed', e.message); }
    await notifyUser(rental.user_id, rentalId, 'payment', 'Покупка оплачена',
      `${paidText} Ячейка ${rental.tools?.cells?.cell_number ?? ''} открыта — заберите ${rental.tools?.name}. Спасибо за покупку!`);
    notifyAdmin(`🛒 <b>Покупка из бокса</b> №${rental.order_number}\n${rental.tools?.name} — ${fmt(rental.total_price)} сум`);
    return rental;
  }

  // 4) Аренда из бокса — как раньше: активируем и открываем замок
  const expectedEnd = new Date(now);
  expectedEnd.setDate(expectedEnd.getDate() + (rental.days || 1));
  await supabase.from('rentals').update({
    status: 'active', paid_at: now.toISOString(),
    started_at: now.toISOString(), expected_end: expectedEnd.toISOString(),
  }).eq('id', rentalId);
  if (rental.tools?.cell_id) {
    await supabase.from('cells').update({ status: 'occupied' }).eq('id', rental.tools.cell_id);
  }
  try { await openCellFor(rental); } catch (e) { console.error('rent pickup: lock open failed', e.message); }
  await notifyUser(rental.user_id, rentalId, 'payment', 'Оплата прошла',
    `${paidText} Замок открыт — заберите инструмент!`);
  return rental;
}

// Отмена неоплаченного/ещё не отправленного заказа. Возвращает {ok} или {error}.
async function cancelOrder(rental, by = 'user') {
  if (!rental) return { error: 'Заказ не найден' };
  if (rental.status === 'cancelled') return { ok: true };
  const paid = rental.status === 'pending_delivery';
  if (rental.status === 'pending_payment') {
    await supabase.from('rentals').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', rental.id);
    return { ok: true };
  }
  if (!paid) return { error: 'Этот заказ уже нельзя отменить' };
  if (['dispatched', 'delivered', 'picked_up'].includes(rental.delivery_status)) {
    return { error: 'Курьер уже в пути — отмена невозможна, свяжитесь с поддержкой' };
  }
  await supabase.from('rentals').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', rental.id);
  if (rental.kind !== 'courier_return' && rental.tools?.cell_id) {
    await supabase.from('cells').update({ status: 'free' }).eq('id', rental.tools.cell_id);
  }
  if (rental.kind === 'courier_return' && rental.parent_rental_id) {
    await supabase.from('rentals').update({ return_method: null }).eq('id', rental.parent_rental_id);
  }
  await notifyUser(rental.user_id, rental.id, 'info', 'Заказ отменён',
    `Заказ №${rental.order_number} отменён. Деньги вернутся тем же способом оплаты в течение 1–3 дней.`);
  notifyAdmin(`❌ <b>Отмена заказа</b> №${rental.order_number} (${by})\n${describe(rental)}\nНужен возврат ${fmt(rental.total_price)} сум в кассе ${rental.payment_provider}`);
  return { ok: true, refund_required: true };
}

module.exports = {
  getPricing, getDelivery, calculatePrice, availableSlots, resolveSlot,
  loadRental, openCellFor, notifyUser, notifyAdmin, confirmPayment, cancelOrder,
  describe, addressLine, fmt,
};
