// Click SHOP API — колбэки Prepare (action=0) и Complete (action=1).
// Click вызывает эти endpoint'ы СО СВОИХ серверов (form-urlencoded).
// Подпись: md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id
//              + [merchant_prepare_id при action=1] + amount + action + sign_time)
// Суммы Click передаёт в СУМАХ (в отличие от Payme — тийины).
// Docs: https://docs.click.uz/ (click-llc/click-integration-php)

const express = require('express');
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const orders = require('../lib/orders');

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
  if (rental.status === 'cancelled') {
    return res.json({ ...base, error: E.CANCELLED, error_note: 'Order cancelled' });
  }
  // К оплате допускается ТОЛЬКО pending_payment: active/completed/overdue —
  // уже оплаченные жизненные стадии, повторная оплата по ним запрещена.
  if (rental.status !== 'pending_payment') {
    return res.json({ ...base, error: E.ALREADY_PAID, error_note: 'Already paid' });
  }
  if (Math.round(Number(p.amount)) !== Math.round(Number(rental.total_price))) {
    return res.json({ ...base, error: E.AMOUNT, error_note: 'Incorrect amount' });
  }

  // Идемпотентность: повторный Prepare с тем же click_trans_id возвращает
  // ту же строку, а не создаёт дубль (на click_trans_id уникальный индекс).
  const { data: existing } = await supabase.from('click_transactions')
    .select('*').eq('click_trans_id', String(p.click_trans_id)).maybeSingle();
  if (existing) {
    if (existing.state === ST_CANCELLED) {
      return res.json({ ...base, error: E.CANCELLED, error_note: 'Transaction cancelled' });
    }
    return res.json({
      click_trans_id: p.click_trans_id,
      merchant_trans_id: p.merchant_trans_id,
      merchant_prepare_id: existing.prepare_id,
      error: E.OK,
      error_note: 'Success',
    });
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

  // merchant_prepare_id — ЧИСЛО (bigint identity), Click ждёт именно integer,
  // uuid строки он может не принять / порезать.
  return res.json({
    click_trans_id: p.click_trans_id,
    merchant_trans_id: p.merchant_trans_id,
    merchant_prepare_id: tx.prepare_id,
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

  // Ищем по числовому prepare_id (его мы вернули в Prepare)
  const { data: tx } = await supabase.from('click_transactions')
    .select('*').eq('prepare_id', Number(p.merchant_prepare_id) || -1).maybeSingle();
  if (!tx) {
    return res.json({ ...base, error: E.TX_NOT_FOUND, error_note: 'Transaction not found' });
  }
  // Сверяем, что Complete пришёл по той же аренде, что и Prepare
  if (String(tx.merchant_trans_id) !== String(p.merchant_trans_id)) {
    return res.json({ ...base, error: E.BAD_PARAMS, error_note: 'merchant_trans_id mismatch' });
  }
  if (tx.state === ST_CANCELLED) {
    return res.json({ ...base, error: E.CANCELLED, error_note: 'Transaction cancelled' });
  }

  // Click сообщил об ошибке/отмене на своей стороне
  if (Number(p.error) < 0) {
    await supabase.from('click_transactions')
      .update({ state: ST_CANCELLED, cancel_time: Date.now() }).eq('id', tx.id);
    await supabase.from('rentals').update({ status: 'cancelled' }).eq('id', tx.merchant_trans_id);
    return res.json({ ...base, merchant_confirm_id: tx.prepare_id, error: Number(p.error), error_note: 'Cancelled by Click' });
  }
  if (Math.round(Number(p.amount)) !== Math.round(Number(tx.amount))) {
    return res.json({ ...base, error: E.AMOUNT, error_note: 'Incorrect amount' });
  }
  if (tx.state === ST_CONFIRMED) {
    return res.json({
      click_trans_id: p.click_trans_id, merchant_trans_id: p.merchant_trans_id,
      merchant_confirm_id: tx.prepare_id, error: E.OK, error_note: 'Already confirmed',
    });
  }

  // Подтверждаем оплату — как в Payme performTransaction
  const confirmTime = Date.now();
  await supabase.from('click_transactions')
    .update({ state: ST_CONFIRMED, confirm_time: confirmTime }).eq('id', tx.id);

  // Подтверждаем заказ: аренда/покупка, из бокса/с доставкой — вся логика в lib/orders
  await orders.confirmPayment(tx.merchant_trans_id, {
    method: 'click',
    paymentId: String(tx.click_trans_id),
    amountSum: Math.round(Number(tx.amount)),
  });

  return res.json({
    click_trans_id: p.click_trans_id,
    merchant_trans_id: p.merchant_trans_id,
    merchant_confirm_id: tx.prepare_id,
    error: E.OK,
    error_note: 'Success',
  });
});

// --- Return URL: страница, куда Click возвращает клиента после оплаты ---
// Приложение всё равно определяет оплату опросом /payment-status и само закрывает
// встроенный браузер; эта страница нужна как валидная точка возврата для Click.
router.get('/return', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Taketool — оплата</title>
<style>
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#fff;
       display:flex;min-height:100vh;align-items:center;justify-content:center;color:#1a1a1a}
  .c{text-align:center;padding:28px;max-width:340px}
  .ok{width:72px;height:72px;border-radius:50%;background:#E02020;margin:0 auto 20px;
      display:flex;align-items:center;justify-content:center}
  .ok svg{width:38px;height:38px}
  h1{font-size:20px;margin:0 0 8px} p{color:#666;font-size:14px;line-height:1.5;margin:0}
</style></head>
<body><div class="c">
  <div class="ok"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"
       stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></div>
  <h1>Оплата обработана</h1>
  <p id="hint">Возвращаем вас в приложение <b>Taketool</b>…</p>
  <p><a id="btn" href="taketool://payment" style="display:inline-block;margin-top:14px;
     padding:12px 22px;background:#E02020;color:#fff;border-radius:10px;
     text-decoration:none;font-weight:600">Открыть Taketool</a></p>
</div>
<script>
  // Пытаемся вернуть пользователя в приложение сами (deep link).
  // Если приложение не поставлено/схема не сработала — остаётся кнопка.
  setTimeout(function () { window.location.href = 'taketool://payment'; }, 400);
  setTimeout(function () {
    document.getElementById('hint').textContent =
      'Вернитесь в приложение Taketool — статус аренды обновится автоматически.';
  }, 2500);
</script>
</body></html>`);
});

module.exports = router;
