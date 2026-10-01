// SMS-модуль
// provider=console — код в консоль (dev-режим, мастер-код работает)
// provider=eskiz   — реальная отправка через Eskiz.uz (договор №1291-2026 от 11.06.2026)
//
// Каждая отправка пишется в таблицу sms_log. Считать отправки по sms_codes нельзя:
// там upsert по номеру (одна строка на телефон) и delete после успешного входа,
// то есть истории не остаётся. Без журнала «клиент не дошёл до регистрации» и
// «SMS ему не доставили» выглядят одинаково — а в августе четыре подряд кода
// одному номеру ушли в REJECTED, и узнали мы об этом только из кабинета Eskiz.

const supabase = require('./supabase');

// Кэш токена Eskiz (живёт 30 дней, перелогиниваемся при 401)
let eskizToken = null;

// Журнал не должен ронять отправку: любая ошибка записи только в консоль.
async function logSms(row) {
  try {
    const { error } = await supabase.from('sms_log').insert(row);
    if (error) console.error('sms_log insert failed:', error.message);
  } catch (e) {
    console.error('sms_log insert failed:', e.message);
  }
}

async function eskizLogin() {
  const email = process.env.ESKIZ_EMAIL;
  const password = process.env.ESKIZ_PASSWORD;
  if (!email || !password) {
    throw new Error('ESKIZ_EMAIL / ESKIZ_PASSWORD не заданы в env');
  }

  const res = await fetch('https://notify.eskiz.uz/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok || !data?.data?.token) {
    throw new Error(`Eskiz login failed: ${res.status} ${JSON.stringify(data)}`);
  }
  eskizToken = data.data.token;
  return eskizToken;
}

async function eskizSend(phone, message, retry = true) {
  if (!eskizToken) await eskizLogin();

  // Eskiz ждёт номер без «+»: 998901234567
  const mobilePhone = phone.replace(/\D/g, '');

  const res = await fetch('https://notify.eskiz.uz/api/message/sms/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${eskizToken}`,
    },
    body: JSON.stringify({
      mobile_phone: mobilePhone,
      message,
      from: process.env.ESKIZ_FROM || '4546',
    }),
  });

  // Токен протух — перелогиниваемся один раз
  if (res.status === 401 && retry) {
    eskizToken = null;
    return eskizSend(phone, message, false);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Eskiz send failed: ${res.status} ${JSON.stringify(data)}`);
  }
  // id сообщения у Eskiz — по нему потом сверяем реальный статус доставки
  return { id: data?.id != null ? String(data.id) : null, status: data?.status || 'waiting' };
}

async function sendSmsCode(phone, code, purpose = 'login_code') {
  const provider = process.env.SMS_PROVIDER || 'console';

  if (provider === 'console') {
    console.log(`\n  ╔══════════════════════════════╗`);
    console.log(`  ║  SMS-код для ${phone}  ║`);
    console.log(`  ║  Код: ${code}                     ║`);
    console.log(`  ╚══════════════════════════════╝\n`);
    await logSms({ phone, purpose, provider, status: 'sent' });
    return true;
  }

  if (provider === 'eskiz') {
    // Текст должен ТОЧНО совпадать с одобренным шаблоном Eskiz (id 79092):
    //   "Kod dlya vhoda v mobilnoe prilozhenie ToolBox: %w Nikomu ne soobshchayte."
    // %w = сам код. Лишняя точка после кода ломала совпадение → Eskiz не доставлял.
    const message = `Kod dlya vhoda v mobilnoe prilozhenie ToolBox: ${code} Nikomu ne soobshchayte.`;
    try {
      const sent = await eskizSend(phone, message);
      await logSms({
        phone, purpose, provider, status: 'sent', provider_message_id: sent.id,
      });
      return true;
    } catch (e) {
      // Отказ шлюза — самое важное событие для журнала, поэтому пишем и бросаем дальше.
      await logSms({ phone, purpose, provider, status: 'failed', error: e.message.slice(0, 500) });
      throw e;
    }
  }

  if (provider === 'playmobile') {
    throw new Error('PlayMobile integration not configured');
  }

  throw new Error(`Unknown SMS provider: ${provider}`);
}

// Сверка статусов доставки. При отправке Eskiz отвечает «waiting» — доставлено
// или отбито оператором становится известно позже, поэтому раз в сутки
// (из cron) подтягиваем реальный статус по id сообщения.
async function refreshSmsStatuses(daysBack = 3) {
  if ((process.env.SMS_PROVIDER || 'console') !== 'eskiz') return { updated: 0, skipped: 'provider' };
  if (!eskizToken) await eskizLogin();

  const fmt = (d) => d.toISOString().slice(0, 16).replace('T', ' ');
  const body = new FormData();
  body.append('start_date', fmt(new Date(Date.now() - daysBack * 86400_000)));
  body.append('end_date', fmt(new Date(Date.now() + 3600_000)));
  body.append('page_size', '500');

  const res = await fetch('https://notify.eskiz.uz/api/message/sms/get-user-messages', {
    method: 'POST', headers: { Authorization: `Bearer ${eskizToken}` }, body,
  });
  const json = await res.json().catch(() => ({}));
  const list = json?.data?.result || json?.data || [];
  if (!Array.isArray(list)) return { updated: 0, skipped: 'bad response' };

  let updated = 0;
  for (const m of list) {
    if (m?.id == null || !m.status) continue;
    const { error, data } = await supabase
      .from('sms_log')
      .update({ status: m.status, checked_at: new Date().toISOString() })
      .eq('provider_message_id', String(m.id))
      .neq('status', m.status)
      .select('id');
    if (!error && data?.length) updated += data.length;
  }
  return { updated, checked: list.length };
}

module.exports = { sendSmsCode, refreshSmsStatuses };
