// Слой уведомлений: транзакционный outbox + доставка по каналам.
//
// ЗАЧЕМ ТАК. Раньше уведомления были обычным side-effect'ом внутри обработчика:
// клиенту — INSERT в notifications, операторам — fetch() к Telegram БЕЗ await.
// Два следствия, оба кусали молча:
//   1) На Vercel функция отвечает кассе и засыпает. Незаконченный fetch умирает
//      вместе с ней — заказ оплачен, а в группе тишина.
//   2) supabase-js не бросает исключений, он возвращает { error }. Старый
//      notifyUser оборачивал INSERT в try/catch и поэтому НИКОГДА не узнавал
//      о промахе: catch не срабатывал, ошибка молча терялась.
//
// Теперь любое уведомление сперва ПИШЕТСЯ В БАЗУ (notification_outbox) — дешёвый
// надёжный INSERT в той же транзакционной области, что и смена статуса заказа, —
// и только потом доставляется. Доставку пробуем сразу (обычный случай: оператор
// видит заказ через секунду), а если канал лежит — строка остаётся pending и её
// добирает крон /api/cron/notifications с растущей задержкой. Потерять
// уведомление теперь можно только вместе с базой.
//
// Повторы безопасны: dedupe_key уникален, поэтому касса, дёрнувшая
// PerformTransaction дважды, не приведёт к двойному сообщению в группе.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const supabase = require('./supabase');

const MAX_ATTEMPTS = 6;
// Задержка перед попыткой №2, №3, … Дальше — dead.
const BACKOFF_MINUTES = [1, 5, 15, 60, 360];
const SEND_TIMEOUT_MS = 4_000;
// Сколько строк разбирает сам обработчик. Нарочно мало: один запрос создаёт 1–2
// уведомления, и его задача — отдать их, а не разгребать чужой backlog. Иначе
// колбэк кассы начал бы ждать доставку всей очереди (10 строк × 4 с таймаута).
// Накопившееся добирает крон с limit 50.
const INLINE_BATCH = 3;
const STALE_SENDING_SECONDS = 120;

// --- Экранирование для Telegram -------------------------------------------
// parse_mode=HTML отвечает 400 «can't parse entities», если в тексте есть сырые
// < > &. В сообщения попадают название инструмента, адрес и КОММЕНТАРИЙ КЛИЕНТА —
// то есть произвольный ввод. Один знак «<» в комментарии к доставке раньше
// убивал уведомление о заказе целиком.
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// Тэг-шаблон: html`<b>Покупка</b> №${n}` — разметка шаблона остаётся как есть,
// а всё подставленное экранируется. Безопасно по построению: забыть esc() нельзя.
const html = (strings, ...vals) =>
  strings.reduce((out, s, i) => out + s + (i < vals.length ? esc(vals[i]) : ''), '');

// --- Конфигурация ---------------------------------------------------------
// Раньше notifyAdmin при пустых env просто выходил, и о том, что уведомлений нет,
// полгода никто не знал. Теперь: строка всё равно ложится в outbox (ничего не
// теряется), доставка честно падает, а состояние видно в GET /health.
function configReport() {
  const missing = ['ADMIN_TG_TOKEN', 'ADMIN_TG_CHAT'].filter((k) => !process.env[k]);
  return {
    telegram: missing.length ? 'misconfigured' : 'configured',
    missing,
    // disabled — пушей просто ещё нет (это не авария);
    // broken — переменная задана, но прочитать её не удалось, вот это уже авария.
    push: fcmCredentials() ? 'configured' : (process.env.FCM_SERVICE_ACCOUNT ? 'broken' : 'disabled'),
  };
}

if (configReport().missing.length) {
  console.warn('[outbox] Telegram операторам ОТКЛЮЧЁН: нет env', configReport().missing.join(', '));
}

// --- FCM: доступ -----------------------------------------------------------
// Ключ сервис-аккаунта Firebase. В env Vercel храним base64: в исходном JSON
// private_key содержит \n, которые легко испортить при копировании через веб-форму.
// Принимаем и сырой JSON — на случай локальной отладки.
function fcmCredentials() {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(text);
    if (!j.client_email || !j.private_key || !j.project_id) return null;
    return j;
  } catch {
    return null;
  }
}

// FCM HTTP v1 требует OAuth-токен. Берём его по flow «JWT bearer»: подписываем
// ассершн приватным ключом сервис-аккаунта и меняем на access_token. Токен живёт
// час — держим в памяти процесса, чтобы не ходить за ним на каждое уведомление.
let fcmAccess = null;
async function fcmAccessToken(creds) {
  if (fcmAccess && fcmAccess.expiresAt - Date.now() > 60_000) return fcmAccess.value;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }, creds.private_key, { algorithm: 'RS256' });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new Error(`fcm oauth ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  }
  fcmAccess = { value: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  return fcmAccess.value;
}

// --- Ошибки ---------------------------------------------------------------
// Постоянная ошибка — повторять бессмысленно (бота выгнали из группы, битая
// разметка, нет такого чата). Такие строки отправляем в dead сразу, не тратя
// шесть попыток и шесть часов.
class PermanentError extends Error {}

// --- Каналы ---------------------------------------------------------------
const channels = {
  // Операторам в рабочую группу Telegram.
  async telegram(payload) {
    const token = process.env.ADMIN_TG_TOKEN;
    const chat = process.env.ADMIN_TG_CHAT;
    if (!token || !chat) throw new Error('нет ADMIN_TG_TOKEN / ADMIN_TG_CHAT');

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: payload.text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (res.ok) return;
    const body = await res.text().catch(() => '');
    // 429 — слишком часто, Telegram сам говорит, через сколько можно; 5xx — у них
    // проблемы. И то и другое лечится повтором.
    if (res.status === 429 || res.status >= 500) throw new Error(`telegram ${res.status}: ${body}`);
    // 400 (битая разметка), 403 (бота выгнали) — повтор не поможет.
    throw new PermanentError(`telegram ${res.status}: ${body}`);
  },

  // Клиенту — пушем на телефон, на все его устройства.
  async push(payload) {
    const creds = fcmCredentials();
    if (!creds) throw new Error('нет FCM_SERVICE_ACCOUNT');

    const { data: devices, error } = await supabase
      .from('device_tokens').select('token, platform').eq('user_id', payload.user_id);
    if (error) throw new Error(`device_tokens: ${error.message}`);
    // Телефонов не зарегистрировано — доставлять некуда, это не ошибка.
    if (!devices?.length) return;

    const access = await fcmAccessToken(creds);
    const url = `https://fcm.googleapis.com/v1/projects/${creds.project_id}/messages:send`;
    let delivered = 0;
    const stale = [];
    const errors = [];

    for (const d of devices) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: d.token,
            notification: { title: payload.title, body: payload.message },
            // Данные — чтобы приложение по тапу открыло нужный заказ.
            data: {
              type: String(payload.type || 'info'),
              rental_id: String(payload.rental_id || ''),
            },
            android: { priority: 'high', notification: { channel_id: 'taketool_orders' } },
            apns: { payload: { aps: { sound: 'default' } } },
          },
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (res.ok) { delivered++; continue; }

      const body = await res.text().catch(() => '');
      // Токен мёртв: приложение удалили или переустановили. Чистим — иначе он
      // вечно отнимал бы попытки и ронял доставку на живые устройства.
      if (res.status === 404 || (res.status === 400 && /registration token|INVALID_ARGUMENT|not a valid FCM/i.test(body))) {
        stale.push(d.token);
        continue;
      }
      errors.push(`${d.platform} ${res.status}: ${body.slice(0, 120)}`);
    }

    if (stale.length) await supabase.from('device_tokens').delete().in('token', stale);
    // Дошло хоть куда-то, либо все токены оказались мёртвыми и вычищены — считаем
    // доставленным. Повторять есть смысл только если живые устройства не ответили.
    if (delivered || !errors.length) return;
    throw new Error(errors.join(' | '));
  },

  // Клиенту — в «колокольчик» приложения.
  async in_app(payload) {
    const { error } = await supabase.from('notifications').insert({
      user_id: payload.user_id,
      rental_id: payload.rental_id,
      type: payload.type,
      title: payload.title,
      message: payload.message,
    });
    // supabase-js не бросает — проверяем руками, иначе промах опять станет невидимым.
    if (!error) return;
    // 23503 — нет такого user_id/rental_id: данные не появятся, повторять нечего.
    if (error.code === '23503') throw new PermanentError(`notifications insert: ${error.message}`);
    throw new Error(`notifications insert: ${error.message}`);
  },
};

// --- Очередь --------------------------------------------------------------
async function enqueue({ channel, event, dedupeKey, payload }) {
  const { data, error } = await supabase
    .from('notification_outbox')
    .insert({ channel, event, dedupe_key: dedupeKey, payload })
    .select('id')
    .maybeSingle();

  if (!error) return { id: data?.id };
  // 23505 — такой dedupe_key уже лежит в очереди. Это не сбой, а ровно то, чего
  // мы хотели от повторного вызова кассы.
  if (error.code === '23505') return { duplicate: true };
  console.error('[outbox] enqueue failed:', event, error.message);
  return { error: error.message };
}

// Отдать одну строку в её канал и записать исход.
async function deliver(row) {
  const send = channels[row.channel];
  try {
    if (!send) throw new PermanentError(`неизвестный канал ${row.channel}`);
    await send(row.payload);
    await supabase.from('notification_outbox')
      .update({ status: 'sent', sent_at: new Date().toISOString(), last_error: null })
      .eq('id', row.id);
    return 'sent';
  } catch (e) {
    const permanent = e instanceof PermanentError;
    const exhausted = row.attempts >= MAX_ATTEMPTS;
    if (permanent || exhausted) {
      await supabase.from('notification_outbox')
        .update({ status: 'dead', last_error: String(e.message).slice(0, 500) })
        .eq('id', row.id);
      // Единственный след, если сам Telegram и есть сломанный канал. Ещё видно в /health.
      console.error(`[outbox] DEAD ${row.event} (${row.channel}, попыток ${row.attempts}): ${e.message}`);
      return 'dead';
    }
    const waitMin = BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)];
    await supabase.from('notification_outbox')
      .update({
        status: 'pending',
        next_attempt_at: new Date(Date.now() + waitMin * 60_000).toISOString(),
        last_error: String(e.message).slice(0, 500),
      })
      .eq('id', row.id);
    console.warn(`[outbox] retry ${row.event} через ${waitMin} мин: ${e.message}`);
    return 'retry';
  }
}

// Разобрать пачку созревших строк. Зовётся и из крона, и сразу после enqueue.
// Строки обрабатываем по очереди: у Telegram лимит ~20 сообщений в минуту на
// группу, параллельный залп только породит 429.
async function drain({ limit = 20 } = {}) {
  const { data: rows, error } = await supabase.rpc('claim_notifications', {
    p_limit: limit,
    p_stale_seconds: STALE_SENDING_SECONDS,
  });
  if (error) {
    console.error('[outbox] claim failed:', error.message);
    return { claimed: 0, sent: 0, retry: 0, dead: 0, error: error.message };
  }

  const out = { claimed: (rows || []).length, sent: 0, retry: 0, dead: 0 };
  for (const row of rows || []) out[await deliver(row)]++;
  return out;
}

// Доставить то, что только что положили. Ошибку наружу не поднимаем: строка уже
// в базе, и если сейчас не вышло — доберёт крон. Падать из-за уведомления в
// обработчике оплаты нельзя: касса примет это за отказ и начнёт повторять платёж.
async function flush() {
  try {
    return await drain({ limit: INLINE_BATCH });
  } catch (e) {
    console.error('[outbox] inline flush failed:', e.message);
    return null;
  }
}

// --- Публичное API --------------------------------------------------------

// Клиенту в приложение. dedupeKey обязателен там, где вызов может повториться
// (колбэк кассы); иначе — уникальный, чтобы одинаковые по тексту уведомления
// не склеились.
async function notifyUser(userId, rentalId, type, title, message, opts = {}) {
  if (!userId) return { skipped: 'нет user_id' };
  const event = opts.event || `user.${type}`;
  const base = opts.dedupeKey || `${event}:${crypto.randomUUID()}`;
  const payload = { user_id: userId, rental_id: rentalId, type, title, message };

  const r = await enqueue({ channel: 'in_app', event, dedupeKey: base, payload });

  // Пуш на телефон — ОТДЕЛЬНОЙ строкой: свои повторы и свой исход, падение
  // Firebase не должно мешать «колокольчику». Ставим в очередь только когда FCM
  // настроен: иначе каждое уведомление плодило бы строку, которая шесть часов
  // ходит по повторам и умирает, а /health из-за этого вечно кричал бы.
  if (opts.push !== false && fcmCredentials()) {
    await enqueue({ channel: 'push', event, dedupeKey: `${base}#push`, payload });
  }

  await flush();
  return r;
}

// Операторам в Telegram. Текст собирать тэг-шаблоном html`…`, иначе любой
// пользовательский ввод в сообщении уронит отправку.
async function notifyAdmin(text, opts = {}) {
  const event = opts.event || 'ops.message';
  const r = await enqueue({
    channel: 'telegram',
    event,
    dedupeKey: opts.dedupeKey || `${event}:${crypto.randomUUID()}`,
    payload: { text },
  });
  await flush();
  return r;
}

// Состояние очереди для /api/admin/health.
// «Мёртвых» считаем за сутки: строка, умершая месяц назад и уже разобранная,
// не должна держать health в degraded вечно.
async function stats() {
  const live = ['pending', 'sending'];
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const [{ count: queued }, { count: dead }, { data: oldest }] = await Promise.all([
    supabase.from('notification_outbox').select('*', { count: 'exact', head: true }).in('status', live),
    supabase.from('notification_outbox').select('*', { count: 'exact', head: true })
      .eq('status', 'dead').gte('created_at', dayAgo),
    supabase.from('notification_outbox').select('created_at, event, last_error')
      .in('status', live).order('created_at', { ascending: true }).limit(1),
  ]);
  const stuck = oldest?.[0] || null;
  return {
    queued: queued || 0,
    dead_24h: dead || 0,
    oldest_queued_at: stuck?.created_at || null,
    oldest_queued_age_min: stuck ? Math.round((Date.now() - new Date(stuck.created_at)) / 60_000) : 0,
    last_error: stuck?.last_error || null,
  };
}

module.exports = {
  notifyUser, notifyAdmin, drain, flush, stats, configReport,
  esc, html, MAX_ATTEMPTS,
};
