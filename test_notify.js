// Проверка слоя уведомлений (lib/notify): outbox, повторы, идемпотентность,
// экранирование. Гоняет по ЖИВОЙ базе, поэтому за собой убирает.
//
//   node test_notify.js              — без Telegram, только база и логика
//   TG_TEST_CHAT=3319695 node test_notify.js   — ещё и реальная отправка
//
// Telegram-тесты шлют в TG_TEST_CHAT, а НЕ в рабочую группу операторов:
// засорять группу тестами нельзя.

require('dotenv').config();
const crypto = require('crypto');
const supabase = require('./src/lib/supabase');

const TEST_CHAT = process.env.TG_TEST_CHAT || null;
const TEST_TOKEN = process.env.ADMIN_TG_TOKEN || null;
// Отправку проверяем только если дали и токен, и тестовый чат.
const liveTelegram = Boolean(TEST_CHAT && TEST_TOKEN);
if (liveTelegram) process.env.ADMIN_TG_CHAT = TEST_CHAT;

const notify = require('./src/lib/notify');

let passed = 0, failed = 0;
const created = [];   // dedupe_key созданных строк — удалим в конце
const notifIds = [];  // id созданных уведомлений клиента

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const row = async (dedupeKey) => (await supabase
  .from('notification_outbox').select('*').eq('dedupe_key', dedupeKey).maybeSingle()).data;

const key = (tag) => {
  const k = `test.${tag}:${crypto.randomUUID()}`;
  created.push(k);
  return k;
};

async function main() {
  console.log(`\nТест уведомлений. Telegram: ${liveTelegram ? 'живой, чат ' + TEST_CHAT : 'выключен (нет TG_TEST_CHAT/ADMIN_TG_TOKEN)'}\n`);

  // Тест зовёт drain(), а он забирает ВСЕ созревшие строки, не только тестовые.
  // Пункты 4–5 нарочно портят токен — настоящее уведомление, попавшее под это,
  // уехало бы в dead. Поэтому на непустой очереди не запускаемся.
  const { data: foreign } = await supabase.from('notification_outbox')
    .select('dedupe_key, event').in('status', ['pending', 'sending'])
    .not('event', 'like', 'test.%').limit(5);
  if (foreign?.length) {
    console.error('В очереди есть НЕтестовые недоставленные уведомления:',
      foreign.map((r) => r.event).join(', '));
    console.error('Сперва разберите очередь (POST /api/admin/notifications/drain), потом тест.');
    process.exit(1);
  }

  // --- 1. Экранирование -----------------------------------------------------
  console.log('1. Экранирование HTML');
  const { html, esc } = notify;
  check('esc закрывает < > &', esc('<b>&x') === '&lt;b&gt;&amp;x', esc('<b>&x'));
  const dangerous = html`<b>Заказ</b> №${7}\n💬 ${'<script>alert(1)</script> 5 > 3 & 4'}`;
  check('разметка шаблона цела', dangerous.includes('<b>Заказ</b>'));
  check('ввод клиента экранирован', !dangerous.includes('<script>') && dangerous.includes('&lt;script&gt;'), dangerous);
  check('амперсанд экранирован', dangerous.includes('&amp; 4'), dangerous);
  check('\\n стал переводом строки', dangerous.includes('\n'));
  check('null не ломает шаблон', html`x${null}y` === 'xy');

  // --- 2. Доставка в Telegram ----------------------------------------------
  console.log('\n2. Telegram: запись в outbox и доставка');
  const k1 = key('telegram');
  const r1 = await notify.notifyAdmin(
    html`🧪 <b>Тест уведомлений Taketool</b>\nЭто проверка очереди, не заказ.\nОпасный ввод: ${'<script> & 5 > 3'}`,
    { event: 'test.telegram', dedupeKey: k1 });
  check('enqueue вернул id', Boolean(r1.id), JSON.stringify(r1));
  const after1 = await row(k1);
  if (liveTelegram) {
    check('строка ушла (status=sent)', after1?.status === 'sent', `${after1?.status} / ${after1?.last_error}`);
    check('попытка одна', after1?.attempts === 1, String(after1?.attempts));
    check('есть sent_at', Boolean(after1?.sent_at));
  } else {
    check('без env строка НЕ потеряна', Boolean(after1), 'строки нет в базе');
    check('а честно помечена на повтор', after1?.status === 'pending', after1?.status);
  }

  // --- 3. Идемпотентность ---------------------------------------------------
  console.log('\n3. Идемпотентность по dedupe_key');
  const k2 = key('dup');
  await notify.notifyAdmin('🧪 тест-дубль 1', { event: 'test.dup', dedupeKey: k2 });
  const r3 = await notify.notifyAdmin('🧪 тест-дубль 2', { event: 'test.dup', dedupeKey: k2 });
  check('повтор распознан', r3.duplicate === true, JSON.stringify(r3));
  const { count: dupCount } = await supabase.from('notification_outbox')
    .select('*', { count: 'exact', head: true }).eq('dedupe_key', k2);
  check('в очереди одна строка', dupCount === 1, String(dupCount));

  // --- 4. Постоянная ошибка → dead сразу -----------------------------------
  console.log('\n4. Постоянная ошибка канала (битый токен) → dead без шести попыток');
  const savedToken = process.env.ADMIN_TG_TOKEN;
  process.env.ADMIN_TG_TOKEN = '123456:ObviouslyWrongTokenForTest';
  if (!process.env.ADMIN_TG_CHAT) process.env.ADMIN_TG_CHAT = TEST_CHAT || '1';
  const k3 = key('permanent');
  await notify.notifyAdmin('🧪 тест битого токена', { event: 'test.permanent', dedupeKey: k3 });
  const after3 = await row(k3);
  check('status=dead', after3?.status === 'dead', `${after3?.status} / ${after3?.last_error}`);
  check('потратили одну попытку', after3?.attempts === 1, String(after3?.attempts));
  check('ошибка записана', Boolean(after3?.last_error), String(after3?.last_error));
  process.env.ADMIN_TG_TOKEN = savedToken;

  // --- 5. Временная ошибка → pending с отложенной попыткой ------------------
  console.log('\n5. Временная ошибка (нет env) → остаётся в очереди с задержкой');
  const savedToken2 = process.env.ADMIN_TG_TOKEN, savedChat = process.env.ADMIN_TG_CHAT;
  delete process.env.ADMIN_TG_TOKEN; delete process.env.ADMIN_TG_CHAT;
  const k4 = key('transient');
  await notify.notifyAdmin('🧪 тест без env', { event: 'test.transient', dedupeKey: k4 });
  const after4 = await row(k4);
  check('вернулась в pending', after4?.status === 'pending', after4?.status);
  const waitMin = after4 ? (new Date(after4.next_attempt_at) - Date.now()) / 60_000 : -1;
  check('следующая попытка через ~1 мин', waitMin > 0.5 && waitMin < 1.5, `${waitMin.toFixed(2)} мин`);
  check('configReport видит нехватку', notify.configReport().missing.length === 2,
    JSON.stringify(notify.configReport()));
  if (savedToken2) process.env.ADMIN_TG_TOKEN = savedToken2;
  if (savedChat) process.env.ADMIN_TG_CHAT = savedChat;

  // --- 6. Канал «в приложение» ---------------------------------------------
  console.log('\n6. Канал in_app: уведомление клиенту');
  const { data: someUser } = await supabase.from('users').select('id').limit(1).maybeSingle();
  if (someUser) {
    const k5 = key('inapp');
    await notify.notifyUser(someUser.id, null, 'info', '🧪 Тест уведомлений',
      'Служебная проверка очереди, можно игнорировать.', { event: 'test.inapp', dedupeKey: k5 });
    const after5 = await row(k5);
    check('доставлено (status=sent)', after5?.status === 'sent', `${after5?.status} / ${after5?.last_error}`);
    const { data: n } = await supabase.from('notifications').select('id, title')
      .eq('user_id', someUser.id).eq('title', '🧪 Тест уведомлений').limit(1).maybeSingle();
    check('запись в notifications есть', Boolean(n));
    if (n) notifIds.push(n.id);
  } else {
    console.log('  — пропуск: в базе нет ни одного пользователя');
  }

  // --- 7. Перезахват зависших строк ----------------------------------------
  console.log('\n7. Строка, зависшая в sending (воркера прибили), забирается заново');
  const k6 = key('stale');
  await supabase.from('notification_outbox').insert({
    channel: 'telegram', event: 'test.stale', dedupe_key: k6,
    payload: { text: '🧪 тест зависшей строки' },
    status: 'sending', attempts: 1,
    locked_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    next_attempt_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  });
  const savedToken3 = process.env.ADMIN_TG_TOKEN;
  delete process.env.ADMIN_TG_TOKEN;  // пусть упадёт — важен сам факт захвата
  await notify.drain({ limit: 50 });
  const after6 = await row(k6);
  check('зависшую строку перезабрали', after6?.attempts === 2, `attempts=${after6?.attempts}`);
  check('и она снова в очереди', after6?.status === 'pending', after6?.status);
  if (savedToken3) process.env.ADMIN_TG_TOKEN = savedToken3;

  // --- 8. Статистика для /health -------------------------------------------
  console.log('\n8. Статистика для /health');
  const st = await notify.stats();
  check('есть queued', typeof st.queued === 'number', JSON.stringify(st));
  check('есть dead_24h', typeof st.dead_24h === 'number');
  check('мёртвые за сутки посчитаны', st.dead_24h >= 1, String(st.dead_24h));
  check('возраст очереди посчитан', typeof st.oldest_queued_age_min === 'number');
  console.log('   ', JSON.stringify(st));

  // --- Уборка ---------------------------------------------------------------
  const { error: delErr } = await supabase.from('notification_outbox').delete().in('dedupe_key', created);
  if (delErr) console.log('  ! не удалось убрать тестовые строки:', delErr.message);
  if (notifIds.length) await supabase.from('notifications').delete().in('id', notifIds);
  console.log(`\nУбрано тестовых строк: ${created.length}, уведомлений: ${notifIds.length}`);

  console.log(`\n${failed ? '❌' : '✅'} пройдено ${passed}, провалено ${failed}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\nТест упал:', e); process.exit(1); });
