// Click SHOP API — колбэки Prepare (action=0) и Complete (action=1).
// Click вызывает эти endpoint'ы СО СВОИХ серверов (form-urlencoded).
// Подпись: md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id
//              + [merchant_prepare_id при action=1] + amount + action + sign_time)
// Суммы Click передаёт в СУМАХ (в отличие от Payme — тийины).
// Docs: https://docs.click.uz/ (click-llc/click-integration-php)

const express = require('express');
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const kerong = require('../lib/kerong');

const router = express.Router();
// Click шлёт application/x-www-form-urlencoded
router.use(express.urlencoded({ extended: true }));

// Коды ошибок Click
const E = {
  OK: 0, SIGN: -1, AMOUNT: -2, ACTION: -3, ALREADY_PAID: -4,
  NOT_FOUND: -5, TX_NOT_FOUND: -6, UPDATE_FAIL: -7, BAD_PARAMS: -8, CANCELLED: -9,
};

const ACTION_PREPARE = '0';
const ACTION_COMPLETE = '1';

// Состояния click_transactions
const ST_PREPARED = 1;
const ST_CONFIRMED = 2;
const ST_CANCELLED = -1;

function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }

function verifySign(p) {
  const secret = process.env.CLICK_SECRET_KEY || '';
  const prepareId = String(p.action) === ACTION_COMPLETE ? (p.merchant_prepare_id ?? '') : '';
  const raw = `${p.click_trans_id}${p.service_id}${secret}${p.merchant_trans_id}` +
    `${prepareId}${p.amount}${p.action}${p.sign_time}`;
  return !!secret && md5(raw) === p.sign_string;
}

function isUuid(s) { return /^[0-9a-f-]{36}$/i.test(String(s || '')); }

async function getRental(id) {
  if (!isUuid(id)) return null;
  const { data } = await supabase
    .from('rentals')
    .select('*, tools(name, cell_id, cells(cell_number, kerong_lock_number, boxes(*)))')
    .eq('id', id).single();
  return data || null;
}

// --- Prepare (action=0): резервируем платёж ---
router.post('/prepare', async (req, res) => {
  const p = req.body || {};
  const base = { click_trans_id: p.click_trans_id, merchant_trans_id: p.merchant_trans_id };

  if (!p.click_trans_id || !p.service_id || !p.merchant_trans_id ||
      p.amount == null || p.action == null || !p.sign_time || !p.sign_string) {
    return res.json({ ...base, error: E.BAD_PARAMS, error_note: 'Missing parameters' });
  }
  if (String(p.action) !== ACTION_PREPARE) {
    return res.json({ ...base, error: E.ACTION, error_note: 'Action not found' });
  }
  if (!verifySign(p)) {
    return res.json({ ...base, error: E.SIGN, error_note: 'SIGN CHECK FAILED' });
  }

  const rental = await getRental(p.merchant_trans_id);
  if (!rental) {
    return res.json({ ...base, error: E.NOT_FOUND, error_note: 'Order not found' });
  }
  if (rental.status === 'active') {
    return res.json({ ...base, error: E.ALREADY_PAID, error_note: 'Already paid' });
  }
  if (rental.status === 'cancelled') {
    return res.json({ ...base, error: E.CANCELLED, error_note: 'Order cancelled' });
  }
  if (Math.round(Number(p.amount)) !== Math.round(Number(rental.total_price))) {
    return res.json({ ...base, error: E.AMOUNT, error_note: 'Incorrect amount' });
  }

  const { data: tx, error } = await supabase.from('click_transactions').insert({
    click_trans_id: String(p.click_trans_id),
    click_paydoc_id: p.click_paydoc_id ? String(p.click_paydoc_id) : null,
    merchant_trans_id: rental.id,
    amount: Math.round(Number(p.amount)),
    state: ST_PREPARED,
    sign_time: p.sign_time,
    prepare_time: Date.now(),
  }).select().single();

  if (error || !tx) {
    return res.json({ ...base, error: E.UPDATE_FAIL, error_note: 'Failed to create transaction' });
  }

  return res.json({
    click_trans_id: p.click_trans_id,
    merchant_trans_id: p.merchant_trans_id,
    merchant_prepare_id: tx.id,
    error: E.OK,
    error_note: 'Success',
  });
});

// --- Complete (action=1): подтверждаем оплату, открываем замок ---
router.post('/complete', async (req, res) => {
  const p = req.body || {};
  const base = { click_trans_id: p.click_trans_id, merchant_trans_id: p.merchant_trans_id };

  if (!p.click_trans_id || !p.service_id || !p.merchant_trans_id || !p.merchant_prepare_id ||
      p.amount == null || p.action == null || !p.sign_time || !p.sign_string) {
    return res.json({ ...base, error: E.BAD_PARAMS, error_note: 'Missing parameters' });
  }
  if (String(p.action) !== ACTION_COMPLETE) {
    return res.json({ ...base, error: E.ACTION, error_note: 'Action not found' });
  }
  if (!verifySign(p)) {
    return res.json({ ...base, error: E.SIGN, error_note: 'SIGN CHECK FAILED' });
  }

  const { data: tx } = await supabase.from('click_transactions')
    .select('*').eq('id', p.merchant_prepare_id).single();
  if (!tx) {
    return res.json({ ...base, error: E.TX_NOT_FOUND, error_note: 'Transaction not found' });
  }
  if (tx.state === ST_CANCELLED) {
    return res.json({ ...base, error: E.CANCELLED, error_note: 'Transaction cancelled' });
  }

  // Click сообщил об ошибке/отмене на своей стороне
  if (Number(p.error) < 0) {
    await supabase.from('click_transactions')
      .update({ state: ST_CANCELLED, cancel_time: Date.now() }).eq('id', tx.id);
    await supabase.from('rentals').update({ status: 'cancelled' }).eq('id', tx.merchant_trans_id);
    return res.json({ ...base, merchant_confirm_id: tx.id, error: Number(p.error), error_note: 'Cancelled by Click' });
  }
  if (Math.round(Number(p.amount)) !== Math.round(Number(tx.amount))) {
    return res.json({ ...base, error: E.AMOUNT, error_note: 'Incorrect amount' });
  }
  if (tx.state === ST_CONFIRMED) {
    return res.json({
      click_trans_id: p.click_trans_id, merchant_trans_id: p.merchant_trans_id,
      merchant_confirm_id: tx.id, error: E.OK, error_note: 'Already confirmed',
    });
  }

  // Подтверждаем оплату — как в Payme performTransaction
  const confirmTime = Date.now();
  await supabase.from('click_transactions')
    .update({ state: ST_CONFIRMED, confirm_time: confirmTime }).eq('id', tx.id);

  const rental = await getRental(tx.merchant_trans_id);
  const startedAt = new Date();
  const expectedEnd = new Date(startedAt);
  expectedEnd.setDate(expectedEnd.getDate() + (rental?.days || 1));
  await supabase.from('rentals').update({
    status: 'active',
    started_at: startedAt.toISOString(),
    expected_end: expectedEnd.toISOString(),
  }).eq('id', tx.merchant_trans_id);

  if (rental?.tools?.cell_id) {
    await supabase.from('cells').update({ status: 'occupied' }).eq('id', rental.tools.cell_id);
  }

  await supabase.from('transactions').insert({
    rental_id: tx.merchant_trans_id,
    user_id: rental?.user_id,
    amount: Math.round(Number(tx.amount)),
    type: 'payment',
    payment_method: 'click',
    payment_id: String(tx.click_trans_id),
    status: 'success',
  });

  // Открываем замок (ошибка замка не должна ронять подтверждение оплаты)
  try {
    const cell = rental?.tools?.cells;
    const zoneId = cell?.boxes?.kerong_zone_id || 1;
    const lockNumber = cell?.kerong_lock_number ?? (cell?.cell_number != null ? cell.cell_number - 1 : null);
    if (lockNumber != null) await kerong.openLock(zoneId, lockNumber);
  } catch (e) {
    console.error('click complete: lock open failed', e.message);
  }

  if (rental?.user_id) {
    await supabase.from('notifications').insert({
      user_id: rental.user_id,
      rental_id: tx.merchant_trans_id,
      type: 'payment',
      title: 'Оплата прошла',
      message: `Оплачено ${Math.round(Number(tx.amount)).toLocaleString('ru-RU')} сум через Click. Замок открыт — заберите инструмент!`,
    });
  }

  return res.json({
    click_trans_id: p.click_trans_id,
    merchant_trans_id: p.merchant_trans_id,
    merchant_confirm_id: tx.id,
    error: E.OK,
    error_note: 'Success',
  });
});

module.exports = router;
