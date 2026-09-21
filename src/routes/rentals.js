const express = require('express');
const supabase = require('../lib/supabase');
const kerong = require('../lib/kerong');
const clickMapi = require('../lib/click_mapi');
const orders = require('../lib/orders');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

const { getPricing, calculatePrice } = orders;

const ACTIVE_STATUSES = ['active', 'overdue', 'pending_delivery'];
const RENTAL_SELECT = `
  *,
  tools (
    id, name, category, brand, photo_url, day_price, sale_price, sale_stock,
    cells ( cell_number, qr_code, boxes ( id, name, address ) )
  ),
  pickup_cell:cells!rentals_pickup_cell_id_fkey ( id, cell_number, boxes ( id, name, address ) )
`;

// Собираем ответ с платёжной ссылкой (Payme — checkout, Click — счёт в Click Up + ссылка)
async function paymentResponse(res, rental, tool, provider, userId, message) {
  const totalPrice = rental.total_price;
  if (provider === 'click') {
    const { data: usr } = await supabase.from('users').select('phone').eq('id', userId).single();
    const inv = await clickMapi.createInvoice({ phone: usr?.phone, amount: totalPrice, merchantTransId: rental.id });
    if (inv && Number(inv.error_code) === 0 && inv.invoice_id) {
      return res.json({
        rental, tool_name: tool?.name, total_price: totalPrice, provider: 'click',
        click_invoice: true, invoice_id: inv.invoice_id,
        payment_url: buildClickUrl(rental.id, totalPrice),
        message: 'Счёт отправлен в приложение Click. Откройте Click и подтвердите оплату.',
      });
    }
    console.error('click invoice failed:', inv);
    return res.json({
      rental, tool_name: tool?.name, total_price: totalPrice, provider: 'click',
      click_invoice: false, payment_url: buildClickUrl(rental.id, totalPrice),
      message: 'Счёт не удалось отправить в Click — откроем страницу оплаты.',
    });
  }
  return res.json({
    rental, tool_name: tool?.name, total_price: totalPrice, provider: 'payme',
    payment_url: buildPaymeUrl(rental.id, totalPrice), message,
  });
}

// Разбор и валидация блока доставки из тела запроса
async function parseDelivery(body, fallbackPhone) {
  const d = body.delivery || {};
  const address = String(d.address || '').trim();
  if (address.length < 5) return { error: 'Укажите адрес доставки' };
  const phone = String(d.phone || fallbackPhone || '').trim();
  if (phone.length < 9) return { error: 'Укажите телефон получателя' };
  const slot = await orders.resolveSlot(d.slot);
  if (slot.error) return { error: slot.error };
  return {
    fields: {
      delivery_address: address,
      delivery_entrance: d.entrance ? String(d.entrance).slice(0, 20) : null,
      delivery_floor: d.floor ? String(d.floor).slice(0, 20) : null,
      delivery_apt: d.apt ? String(d.apt).slice(0, 20) : null,
      delivery_lat: typeof d.lat === 'number' ? d.lat : null,
      delivery_lng: typeof d.lng === 'number' ? d.lng : null,
      delivery_slot_start: slot.start,
      delivery_slot_end: slot.end,
      delivery_slot_label: slot.label,
      recipient_phone: phone,
      delivery_comment: d.comment ? String(d.comment).slice(0, 500) : null,
    },
  };
}

// POST /api/rentals — создать заказ: аренда или покупка, из бокса или с доставкой.
// body: { tool_id, kind: rent|buy, days, fulfillment: pickup|delivery, provider, delivery{...} }
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const tool_id = body.tool_id;
    const kind = body.kind === 'buy' ? 'buy' : 'rent';
    const fulfillment = body.fulfillment === 'delivery' ? 'delivery' : 'pickup';
    const provider = body.provider === 'click' ? 'click' : 'payme';
    const days = kind === 'rent' ? Number(body.days) : 0;

    if (!tool_id) return res.status(400).json({ error: 'Укажите инструмент' });
    if (kind === 'rent' && (!days || days < 1 || days > 30)) {
      return res.status(400).json({ error: 'Укажите количество дней (1-30)' });
    }

    // Согласие с офертой: чекбокс в приложении обязателен, редакция — только действующая
    const terms = await orders.getTerms();
    if (String(body.terms_version || '') !== String(terms.version)) {
      return res.status(400).json({ error: 'Подтвердите согласие с действующей редакцией оферты', terms });
    }

    // Неоплаченный штраф за просрочку блокирует новые аренды (п. 4 оферты)
    if (kind === 'rent') {
      const pens = await orders.unpaidPenalties(req.userId);
      if (pens.length) {
        const sum = pens.reduce((a, p) => a + (p.total_price || 0), 0);
        return res.status(402).json({
          error: `У вас неоплаченный штраф за просрочку: ${orders.fmt(sum)} сум. Оплатите его в разделе «Заказы», после этого аренда снова доступна.`,
          penalty_id: pens[0].id, penalty_total: sum,
        });
      }
    }

    if (kind === 'rent') {
      const { count: activeCount } = await supabase
        .from('rentals')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', req.userId)
        .eq('kind', 'rent')
        .in('status', ACTIVE_STATUSES);
      if (activeCount >= 3) {
        return res.status(400).json({ error: 'Максимум 3 активных аренды одновременно' });
      }
    }

    const { data: tool, error: toolErr } = await supabase
      .from('tools')
      .select('*, cells(*, boxes(*))')
      .eq('id', tool_id)
      .single();
    if (toolErr || !tool) return res.status(404).json({ error: 'Инструмент не найден' });
    if (tool.status && tool.status !== 'available') {
      return res.status(400).json({ error: 'Инструмент больше не доступен' });
    }
    if (kind === 'rent' && tool.cells?.status !== 'free') {
      return res.status(400).json({ error: 'Инструмент уже занят' });
    }
    // Покупка — новая единица со склада: арендный экземпляр может быть занят, важен остаток
    if (kind === 'buy' && !(tool.sale_price > 0)) {
      return res.status(400).json({ error: 'Этот инструмент не продаётся' });
    }
    if (kind === 'buy' && !(Number(tool.sale_stock || 0) > 0)) {
      return res.status(400).json({ error: 'Нет в наличии — остаток на складе закончился' });
    }

    // Цена
    const pricing = await getPricing();
    const itemsPrice = kind === 'buy' ? tool.sale_price : days * tool.day_price;
    const discount = kind === 'buy' ? 0 : itemsPrice - calculatePrice(tool.day_price, days, pricing);
    let deliveryFee = 0;
    let deliveryFields = {};
    if (fulfillment === 'delivery') {
      const { data: usr } = await supabase.from('users').select('phone').eq('id', req.userId).single();
      const parsed = await parseDelivery(body, usr?.phone);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      deliveryFields = parsed.fields;
      deliveryFee = (await orders.getDelivery()).fee || 0;
    }
    const totalPrice = itemsPrice - discount + deliveryFee;

    // started_at/expected_end предварительные: для доставки пересчитаются при передаче
    const startedAt = new Date();
    const expectedEnd = new Date(startedAt);
    expectedEnd.setDate(expectedEnd.getDate() + (days || 0));

    const { data: rental, error: rentalErr } = await supabase
      .from('rentals')
      .insert({
        user_id: req.userId,
        tool_id,
        kind,
        fulfillment,
        days: days || 0,
        started_at: startedAt.toISOString(),
        expected_end: expectedEnd.toISOString(),
        status: 'pending_payment',
        items_price: itemsPrice,
        discount,
        delivery_fee: deliveryFee,
        total_price: totalPrice,
        payment_provider: provider,
        terms_version: String(terms.version),
        ...deliveryFields,
      })
      .select()
      .single();
    if (rentalErr) throw rentalErr;

    // Журнал согласий: кто, когда, какая редакция, по какому заказу
    await supabase.from('consents').insert({
      user_id: req.userId, rental_id: rental.id, terms_version: String(terms.version),
      terms_date: terms.date || null, terms_url: terms.url || null,
      ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64),
      user_agent: (req.headers['user-agent'] || '').toString().slice(0, 200),
      app_version: (req.headers['x-app-version'] || '').toString().slice(0, 32) || null,
    });
    await supabase.from('users').update({ terms_accepted_at: new Date().toISOString() }).eq('id', req.userId);

    // Ячейку/остаток НЕ резервируем до оплаты (см. orders.confirmPayment).
    return paymentResponse(res, rental, tool, provider, req.userId,
      kind === 'buy' ? 'Заказ создан. Оплатите покупку.' : 'Аренда создана. Оплатите, чтобы открыть замок.');
  } catch (err) {
    console.error('create rental error:', err);
    res.status(500).json({ error: 'Ошибка создания заказа' });
  }
});

// Ссылка на оплату Payme: base64(m=MERCHANT_ID;ac.rental_id=ID;a=СУММА_В_ТИЙИНАХ)
function buildPaymeUrl(rentalId, priceSum) {
  const merchantId = process.env.PAYME_MERCHANT_ID;
  if (!merchantId) return null;
  const base = process.env.PAYME_CHECKOUT_URL || 'https://checkout.paycom.uz';
  const payload = `m=${merchantId};ac.rental_id=${rentalId};a=${priceSum * 100}`;
  return `${base}/${Buffer.from(payload).toString('base64')}`;
}

// Ссылка на оплату Click (сумма в СУМАХ, transaction_param = rental_id)
function buildClickUrl(rentalId, priceSum) {
  const serviceId = process.env.CLICK_SERVICE_ID;
  const merchantId = process.env.CLICK_MERCHANT_ID;
  if (!serviceId || !merchantId) return null;
  const params = new URLSearchParams({
    service_id: serviceId,
    merchant_id: merchantId,
    amount: String(priceSum),
    transaction_param: rentalId,
  });
  if (process.env.CLICK_RETURN_URL) params.set('return_url', process.env.CLICK_RETURN_URL);
  return `https://my.click.uz/services/pay?${params.toString()}`;
}

// GET /api/rentals/:id/payment-status — поллинг оплаты из приложения
router.get('/:id/payment-status', async (req, res) => {
  try {
    const { data: rental, error } = await supabase
      .from('rentals')
      .select('id, status, total_price, payment_provider, kind, fulfillment, delivery_status, delivery_slot_label')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();
    if (error || !rental) return res.status(404).json({ error: 'Заказ не найден' });

    const paid = !['pending_payment', 'cancelled'].includes(rental.status);
    res.json({
      rental_id: rental.id,
      status: rental.status,
      kind: rental.kind,
      fulfillment: rental.fulfillment,
      delivery_slot_label: rental.delivery_slot_label,
      provider: rental.payment_provider || 'payme',
      paid,
      payment_url: rental.status === 'pending_payment'
        ? (rental.payment_provider === 'click'
            ? buildClickUrl(rental.id, rental.total_price)
            : buildPaymeUrl(rental.id, rental.total_price))
        : null,
    });
  } catch (err) {
    console.error('payment-status error:', err);
    res.status(500).json({ error: 'Ошибка проверки оплаты' });
  }
});

// GET /api/rentals/active — активные аренды и заказы в доставке (кроме дочерних возвратов)
router.get('/active', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rentals')
      .select(RENTAL_SELECT)
      .eq('user_id', req.userId)
      .or(`status.in.(${ACTIVE_STATUSES.join(',')}),and(kind.eq.penalty,status.eq.pending_payment)`)
      .neq('kind', 'courier_return')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('active rentals error:', err);
    res.status(500).json({ error: 'Ошибка загрузки заказов' });
  }
});

// GET /api/rentals/history — завершённые и отменённые заказы
router.get('/history', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rentals')
      .select(RENTAL_SELECT)
      .eq('user_id', req.userId)
      .in('status', ['completed', 'cancelled'])
      .neq('kind', 'courier_return')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('rental history error:', err);
    res.status(500).json({ error: 'Ошибка загрузки истории' });
  }
});

// GET /api/rentals/:id — заказ + активный вызов курьера (если есть)
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rentals')
      .select(RENTAL_SELECT)
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Заказ не найден' });

    const { data: ret } = await supabase
      .from('rentals')
      .select('id, status, delivery_status, delivery_slot_label, courier_name, courier_phone, total_price')
      .eq('parent_rental_id', data.id)
      .in('status', ['pending_payment', 'pending_delivery'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    res.json({ ...data, courier_return: ret || null });
  } catch (err) {
    console.error('rental detail error:', err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// POST /api/rentals/:id/pay — оплатить существующий неоплаченный заказ (штраф, повторная попытка).
// body: { provider } — можно сменить кассу.
router.post('/:id/pay', async (req, res) => {
  try {
    const rental = await orders.loadRental(req.params.id);
    if (!rental || rental.user_id !== req.userId) return res.status(404).json({ error: 'Заказ не найден' });
    if (rental.status !== 'pending_payment') return res.status(400).json({ error: 'Заказ уже оплачен или отменён' });
    const provider = req.body?.provider === 'click' ? 'click' : (req.body?.provider === 'payme' ? 'payme' : rental.payment_provider);
    if (provider !== rental.payment_provider) {
      await supabase.from('rentals').update({ payment_provider: provider }).eq('id', rental.id);
      rental.payment_provider = provider;
    }
    return paymentResponse(res, rental, rental.tools, provider, req.userId,
      rental.kind === 'penalty' ? 'Оплатите штраф за просрочку.' : 'Оплатите заказ.');
  } catch (err) {
    console.error('pay error:', err);
    res.status(500).json({ error: 'Ошибка оплаты' });
  }
});

// POST /api/rentals/:id/pickup — покупка с самовывозом: открыть ячейку с готовым заказом
router.post('/:id/pickup', async (req, res) => {
  try {
    const rental = await orders.loadRental(req.params.id);
    if (!rental || rental.user_id !== req.userId) return res.status(404).json({ error: 'Заказ не найден' });
    const r = await orders.pickupPurchase(rental);
    if (r.error) return res.status(r.lock_failed ? 503 : 400).json({ error: r.error, lock_failed: !!r.lock_failed });
    res.json({ ok: true, cell_number: r.cell_number, message: `Ячейка ${r.cell_number ?? ''} открыта — заберите покупку. Спасибо!` });
  } catch (err) {
    console.error('pickup error:', err);
    res.status(500).json({ error: 'Ошибка выдачи' });
  }
});

// POST /api/rentals/:id/cancel — отмена клиентом (до передачи курьеру)
router.post('/:id/cancel', async (req, res) => {
  try {
    const rental = await orders.loadRental(req.params.id);
    if (!rental || rental.user_id !== req.userId) return res.status(404).json({ error: 'Заказ не найден' });
    const r = await orders.cancelOrder(rental, 'user');
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ ok: true, message: r.refund_required
      ? 'Заказ отменён. Деньги вернутся тем же способом оплаты в течение 1–3 дней.'
      : 'Заказ отменён.' });
  } catch (err) {
    console.error('cancel error:', err);
    res.status(500).json({ error: 'Ошибка отмены' });
  }
});

// POST /api/rentals/:id/extend
router.post('/:id/extend', async (req, res) => {
  try {
    const { extra_days } = req.body;
    if (!extra_days || extra_days < 1) {
      return res.status(400).json({ error: 'Укажите количество дополнительных дней' });
    }
    const { data: rental, error: rErr } = await supabase
      .from('rentals')
      .select('*, tools(day_price, name)')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();
    if (rErr || !rental) return res.status(404).json({ error: 'Аренда не найдена' });
    if (rental.kind !== 'rent') return res.status(400).json({ error: 'Продлевать можно только аренду' });
    if (rental.status === 'completed') return res.status(400).json({ error: 'Аренда уже завершена' });
    if (!['active', 'overdue'].includes(rental.status)) {
      return res.status(400).json({ error: 'Аренда не активна — продление невозможно' });
    }

    const newDays = rental.days + extra_days;
    const extraPrice = calculatePrice(rental.tools.day_price, extra_days, await getPricing());
    const newEnd = new Date(rental.expected_end);
    newEnd.setDate(newEnd.getDate() + extra_days);

    const { data: updated, error: uErr } = await supabase
      .from('rentals')
      .update({ days: newDays, expected_end: newEnd.toISOString(), total_price: rental.total_price + extraPrice, status: 'active' })
      .eq('id', req.params.id)
      .select()
      .single();
    if (uErr) throw uErr;

    await orders.notifyUser(req.userId, rental.id, 'payment', 'Аренда продлена',
      `${rental.tools.name} — +${extra_days} дн., доплата ${extraPrice.toLocaleString('ru-RU')} сум`);
    res.json({ rental: updated, extra_price: extraPrice, message: `Аренда продлена на ${extra_days} дн.` });
  } catch (err) {
    console.error('extend error:', err);
    res.status(500).json({ error: 'Ошибка продления' });
  }
});

// POST /api/rentals/:id/return — вернуть инструмент В БОКС (открыть замок)
router.post('/:id/return', async (req, res) => {
  try {
    const { data: rental, error: rErr } = await supabase
      .from('rentals')
      .select('*, tools(cell_id, name, cells(cell_number, kerong_lock_number, boxes(kerong_zone_id)))')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();
    if (rErr || !rental) return res.status(404).json({ error: 'Аренда не найдена' });
    if (rental.kind !== 'rent') return res.status(400).json({ error: 'Это не аренда' });
    if (rental.status === 'completed') return res.status(400).json({ error: 'Уже возвращён' });
    if (!['active', 'overdue'].includes(rental.status)) {
      return res.status(400).json({ error: 'Аренда не активна — возврат невозможен' });
    }
    if (rental.return_method === 'courier') {
      return res.status(400).json({ error: 'Вы уже вызвали курьера за инструментом. Отмените вызов, чтобы сдать в бокс.' });
    }

    const cell = rental.tools.cells;
    const zoneId = cell.boxes.kerong_zone_id || 1;
    const lockNumber = cell.kerong_lock_number ?? (cell.cell_number - 1);
    try {
      await kerong.openLock(zoneId, lockNumber);
    } catch (lockErr) {
      console.error('return: lock open failed', lockErr.message);
      return res.status(503).json({
        error: 'Не удалось открыть замок ячейки. Попробуйте ещё раз через минуту. ' +
               'Если не помогает — обратитесь в поддержку, аренда останется активной.',
        lock_failed: true,
      });
    }

    const now = new Date();
    const overdueFee = await orders.overdueFeeFor(rental, now);

    const { data: updated, error: uErr } = await supabase
      .from('rentals')
      .update({ actual_end: now.toISOString(), status: 'completed', overdue_fee: overdueFee, return_method: 'box' })
      .eq('id', req.params.id)
      .select()
      .single();
    if (uErr) throw uErr;

    await supabase.from('cells').update({ status: 'free' }).eq('id', rental.tools.cell_id);
    const penalty = overdueFee > 0 ? await orders.createPenalty({ ...rental, order_number: updated.order_number }, overdueFee) : null;
    await orders.notifyUser(req.userId, rental.id, 'info',
      overdueFee > 0 ? 'Возвращён со штрафом' : 'Инструмент возвращён',
      overdueFee > 0
        ? `${rental.tools.name} — штраф ${overdueFee.toLocaleString('ru-RU')} сум, счёт выставлен`
        : `${rental.tools.name} — спасибо за использование Taketool!`);

    res.json({
      rental: updated, overdue_fee: overdueFee, lock_opened: true,
      penalty_id: penalty?.id || null, penalty_order_number: penalty?.order_number || null,
      message: overdueFee > 0
        ? `Замок открыт. За просрочку выставлен счёт ${overdueFee.toLocaleString('ru-RU')} сум — оплатите его в разделе «Заказы».`
        : 'Замок открыт. Верните инструмент в ячейку. Спасибо!',
    });
  } catch (err) {
    console.error('return error:', err);
    res.status(500).json({ error: 'Ошибка возврата' });
  }
});

// POST /api/rentals/:id/return-courier — вызвать курьера за инструментом (платно).
// body: { provider, delivery{ address, entrance, floor, apt, phone, comment, slot } }
router.post('/:id/return-courier', async (req, res) => {
  try {
    const { data: rental, error: rErr } = await supabase
      .from('rentals')
      .select('*, tools(id, name, cell_id)')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();
    if (rErr || !rental) return res.status(404).json({ error: 'Аренда не найдена' });
    if (rental.kind !== 'rent' || !['active', 'overdue'].includes(rental.status)) {
      return res.status(400).json({ error: 'Курьера можно вызвать только по активной аренде' });
    }
    const { data: existing } = await supabase
      .from('rentals').select('id').eq('parent_rental_id', rental.id)
      .in('status', ['pending_payment', 'pending_delivery']).limit(1);
    if (existing && existing.length) {
      return res.status(400).json({ error: 'Вызов курьера уже оформлен' });
    }

    const { data: usr } = await supabase.from('users').select('phone').eq('id', req.userId).single();
    const parsed = await parseDelivery(req.body || {}, usr?.phone);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const fee = (await orders.getDelivery()).fee || 0;
    const provider = req.body?.provider === 'click' ? 'click' : 'payme';
    const now = new Date();

    const { data: child, error: cErr } = await supabase
      .from('rentals')
      .insert({
        user_id: req.userId,
        tool_id: rental.tool_id,
        kind: 'courier_return',
        fulfillment: 'delivery',
        parent_rental_id: rental.id,
        days: 0,
        started_at: now.toISOString(),
        expected_end: now.toISOString(),
        status: 'pending_payment',
        items_price: 0,
        discount: 0,
        delivery_fee: fee,
        total_price: fee,
        payment_provider: provider,
        ...parsed.fields,
      })
      .select()
      .single();
    if (cErr) throw cErr;

    return paymentResponse(res, child, rental.tools, provider, req.userId, 'Оплатите вызов курьера.');
  } catch (err) {
    console.error('return-courier error:', err);
    res.status(500).json({ error: 'Ошибка вызова курьера' });
  }
});

module.exports = router;
