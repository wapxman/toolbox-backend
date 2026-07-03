// SMS-модуль
// provider=console — код в консоль (dev-режим, мастер-код работает)
// provider=eskiz   — реальная отправка через Eskiz.uz (договор №1291-2026 от 11.06.2026)

// Кэш токена Eskiz (живёт 30 дней, перелогиниваемся при 401)
let eskizToken = null;

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
  return true;
}

async function sendSmsCode(phone, code) {
  const provider = process.env.SMS_PROVIDER || 'console';

  if (provider === 'console') {
    console.log(`\n  ╔══════════════════════════════╗`);
    console.log(`  ║  SMS-код для ${phone}  ║`);
    console.log(`  ║  Код: ${code}                     ║`);
    console.log(`  ╚══════════════════════════════╝\n`);
    return true;
  }

  if (provider === 'eskiz') {
    // Текст должен совпадать с шаблоном, одобренным в кабинете Eskiz
    const message = `Kod dlya vhoda v mobilnoe prilozhenie ToolBox: ${code}. Nikomu ne soobshchayte.`;
    return eskizSend(phone, message);
  }

  if (provider === 'playmobile') {
    throw new Error('PlayMobile integration not configured');
  }

  throw new Error(`Unknown SMS provider: ${provider}`);
}

module.exports = { sendSmsCode };
