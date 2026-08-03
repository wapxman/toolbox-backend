/**
 * Click Merchant API v2 — создание инвойса (счёта).
 * При создании инвойса пользователю в приложение Click Up прилетает уведомление
 * с суммой (Payme-подобный UX), он выбирает карту и оплачивает. Само подтверждение
 * оплаты Click присылает нам через SHOP API колбэки Prepare/Complete (см. routes/click.js),
 * merchant_trans_id = наш rental_id.
 *
 * Авторизация (выверена живьём 2026-08-04):
 *   Header  Auth: {merchant_user_id}:{digest}:{timestamp}
 *   digest = sha1(timestamp + SECRET_KEY), timestamp = unix seconds.
 * Base: https://api.click.uz/v2/merchant
 */
const crypto = require('crypto');

const API_BASE = 'https://api.click.uz/v2/merchant';

function authHeader() {
  const userId = process.env.CLICK_MERCHANT_USER_ID || '';
  const secret = process.env.CLICK_SECRET_KEY || '';
  const ts = Math.floor(Date.now() / 1000).toString();
  const digest = crypto.createHash('sha1').update(ts + secret).digest('hex');
  return `${userId}:${digest}:${ts}`;
}

// Click ждёт номер в формате 998XXXXXXXXX (только цифры, без +).
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

// POST /invoice/create → { invoice_id, error_code, error_note }
async function createInvoice({ phone, amount, merchantTransId }) {
  const body = {
    service_id: Number(process.env.CLICK_SERVICE_ID),
    amount: Number(amount),
    phone_number: normalizePhone(phone),
    merchant_trans_id: String(merchantTransId),
  };
  const res = await fetch(`${API_BASE}/invoice/create`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Auth: authHeader(),
    },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({ error_code: -999, error_note: 'Bad response' }));
}

// GET /invoice/status/{service_id}/{invoice_id}
async function invoiceStatus(invoiceId) {
  const res = await fetch(
    `${API_BASE}/invoice/status/${process.env.CLICK_SERVICE_ID}/${invoiceId}`,
    { headers: { Accept: 'application/json', Auth: authHeader() } }
  );
  return res.json().catch(() => ({ error_code: -999 }));
}

module.exports = { createInvoice, invoiceStatus, normalizePhone };
