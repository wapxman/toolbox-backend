// SMS-модуль
// Пока выводит код в консоль. Когда выберем провайдер (Eskiz/PlayMobile) —
// заменим этот файл, не трогая остальной код.

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
    // TODO: интеграция с Eskiz.uz
    // const response = await fetch('https://notify.eskiz.uz/api/message/sms/send', { ... });
    throw new Error('Eskiz integration not configured');
  }

  if (provider === 'playmobile') {
    // TODO: интеграция с PlayMobile
    throw new Error('PlayMobile integration not configured');
  }

  throw new Error(`Unknown SMS provider: ${provider}`);
}

module.exports = { sendSmsCode };
