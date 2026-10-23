// Колесо Фортуны и бонусный кошелёк.
//
// ⚠️ ПРИЗ ВЫБИРАЕТ СЕРВЕР, А НЕ ТЕЛЕФОН. Если крутить на клиенте и присылать
// результат, достаточно подменить один ответ — и у человека главный приз.
// Телефон получает уже принятое решение и только проигрывает анимацию.
//
// ⚠️ БОНУС — ЭТО СКИДКА, А НЕ ДЕНЬГИ. Его нельзя вывести и нельзя закрыть им
// весь чек: иначе выигрыш 300 000 означает бесплатный инструмент. Потолок
// (max_pay_pct) считается от суммы товаров ПОСЛЕ скидки за срок и НЕ
// распространяется на доставку — она наш прямой расход курьеру.
const supabase = require('./supabase');

const SETTINGS_KEY = 'wheel';

// Значения по умолчанию. Боевые живут в app_settings и правятся из админки,
// чтобы менять шансы без пересборки приложения (решение владельца 13.10.2026).
const DEFAULTS = {
  enabled: true,
  // Сколько процентов чека можно закрыть бонусом. 50 — решение владельца.
  max_pay_pct: 50,
  // Сколько дней живёт выигрыш.
  expires_days: 30,
  // Одна прокрутка на человека, навсегда (решение владельца: второй нет).
  spins_per_user: 1,
  // Правила акции. Их требуют оба магазина: Apple (5.3.2) и Google Play
  // (Gamified Loyalty Programs) хотят видеть фиксированное число победителей,
  // дедлайн участия и срок выдачи приза ВНУТРИ приложения.
  //
  // ⚠️ Это не декорация: лимит и дата реально закрывают акцию. Обещание,
  // которое не исполняется кодом, — это обещание, которого нет.
  winners_limit: 1000,                   // решение владельца 14.10.2026
  ends_at: '2026-12-31T23:59:59+05:00',  // до конца года, время ташкентское
  // weight — доля в розыгрыше. Не процент: сумма может быть любой, сервер
  // делит на общую сумму весов. Так добавление приза не требует пересчёта
  // остальных. weight 0 — приз на колесе показан, но не выпадает.
  prizes: [
    { code: 'bonus_200k',   label: '200 000 сум', kind: 'bonus', amount: 200000, weight: 40 },
    { code: 'bonus_300k',   label: '300 000 сум', kind: 'bonus', amount: 300000, weight: 30 },
    { code: 'bonus_500k',   label: '500 000 сум', kind: 'bonus', amount: 500000, weight: 15 },
    { code: 'bonus_1m',     label: '1 000 000 сум', kind: 'bonus', amount: 1000000, weight: 5 },
    { code: 'item_drill',   label: 'Шуруповёрт',  kind: 'item',  amount: 0, weight: 5 },
    { code: 'item_hammer',  label: 'Перфоратор',  kind: 'item',  amount: 0, weight: 5 },
  ],
};

const cache = { value: null, ts: 0 };
async function getConfig() {
  if (cache.value && Date.now() - cache.ts < 60_000) return cache.value;
  try {
    const { data, error } = await supabase
      .from('app_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle();
    if (error) throw error;
    const value = data?.value ? { ...DEFAULTS, ...data.value } : DEFAULTS;
    cache.value = value;
    cache.ts = Date.now();
    return value;
  } catch (e) {
    // ⚠️ НЕ подставляем умолчания при сбое чтения. Владелец мог выключить
    // акцию или сменить потолок скидки — а умолчания включают её обратно и
    // возвращают прежний тариф. Если настройки когда-то читались, берём
    // последние известные; если нет — честно падаем, а не раздаём призы по
    // значениям из кода.
    console.error('wheel: не прочитал app_settings —', e.message || e);
    if (cache.value) return cache.value;
    throw new Error('Настройки акции недоступны');
  }
}
const dropCache = () => { cache.value = null; cache.ts = 0; };

/** Доступный баланс в сумах. Считает БД (функция wallet_balance), а не мы:
 *  клиент не должен иметь возможности назвать свою цифру. */
async function balanceOf(userId) {
  const { data, error } = await supabase.rpc('wallet_balance', { uid: userId });
  if (error) throw new Error('не удалось посчитать баланс: ' + error.message);
  return Number(data || 0);
}

/** Сколько бонуса реально спишется с заказа.
 *  itemsPrice — сумма товаров ПОСЛЕ скидки за срок, без доставки. */
function applicable(balance, itemsPrice, maxPct) {
  if (!(itemsPrice > 0) || !(balance > 0)) return 0;
  const cap = Math.floor((itemsPrice * maxPct) / 100);
  return Math.max(0, Math.min(balance, cap));
}

/** Разыграть приз по весам. Отдельная чистая функция — её можно проверить
 *  без базы и без сети, и именно она решает, сколько мы отдадим. */
function drawPrize(prizes, rnd = Math.random) {
  const pool = (prizes || []).filter((p) => Number(p.weight) > 0);
  if (!pool.length) return null;
  const total = pool.reduce((s, p) => s + Number(p.weight), 0);
  let x = rnd() * total;
  for (const p of pool) {
    x -= Number(p.weight);
    if (x <= 0) return p;
  }
  return pool[pool.length - 1];
}

/** Раскладка секторов колеса.
 *
 * Дешёвый приз занимает несколько секторов, дорогой — один. Так колесо
 * выглядит богатым (взгляд ведут одиночные редкие сектора), а видимая частота
 * честно совпадает с настоящим шансом: доля секторов пропорциональна весу.
 *
 * ⚠️ Считает СЕРВЕР, а не телефон: веса — внутренняя кухня, наружу они не
 * уходят, поэтому собрать такую раскладку на клиенте нечем.
 *
 * Приз с нулевым весом остаётся на колесе одним сектором: он показан, но не
 * выпадает — так задумано в DEFAULTS, и раскладка этого не меняет.
 */
function layoutSectors(prizes, target = 12) {
  const pool = (prizes || []).filter((p) => p && p.code);
  if (pool.length < 2) return pool.map((p) => p.code);
  // Призов больше, чем секторов — каждому по одному, иначе кто-то исчезнет.
  if (pool.length >= target) return pool.map((p) => p.code);

  const w = pool.map((p) => Math.max(0, Number(p.weight) || 0));
  const totalW = w.reduce((s, x) => s + x, 0);

  const counts = pool.map(() => 1); // минимум один сектор каждому призу
  const left = target - pool.length;
  if (totalW > 0 && left > 0) {
    const share = w.map((x) => (x / totalW) * left);
    share.forEach((s, i) => { counts[i] += Math.floor(s); });
    // Остаток от округления отдаём тем, у кого дробная часть больше.
    const rest = left - share.reduce((s, x) => s + Math.floor(x), 0);
    const byFrac = share
      .map((s, i) => ({ frac: s - Math.floor(s), i }))
      .sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < rest; k++) counts[byFrac[k % byFrac.length].i]++;
  }

  // Расставляем по кругу так, чтобы одинаковые сектора не липли друг к другу:
  // каждый раз берём приз, которого осталось больше всех, но не тот же, что
  // лёг последним — кроме случая, когда других уже не осталось.
  const restCount = counts.slice();
  const out = [];
  for (let k = 0; k < target; k++) {
    let pick = -1;
    let fallback = -1;
    for (let i = 0; i < pool.length; i++) {
      if (restCount[i] <= 0) continue;
      if (fallback < 0 || restCount[i] > restCount[fallback]) fallback = i;
      if (out.length && pool[i].code === out[out.length - 1]) continue;
      if (pick < 0 || restCount[i] > restCount[pick]) pick = i;
    }
    if (pick < 0) pick = fallback;
    if (pick < 0) break; // разложили всё, что было
    out.push(pool[pick].code);
    restCount[pick]--;
  }

  // Круг замкнут: если последний сектор совпал с первым, меняем его местами
  // с подходящим соседом, иначе на стыке получится двойной сектор.
  if (out.length > 2 && out[0] === out[out.length - 1]) {
    for (let i = out.length - 2; i > 0; i--) {
      if (out[i] !== out[0] && out[i] !== out[i - 1]) {
        [out[i], out[out.length - 1]] = [out[out.length - 1], out[i]];
        break;
      }
    }
  }
  return out;
}

/** Сколько прокруток осталось.
 *
 * owner — { userId } у вошедшего, { deviceId } у гостя, у вошедшего с телефона
 * известны оба. Считаем ПО ОБОИМ сразу: иначе человек крутит гостем, заводит
 * аккаунт и получает вторую попытку на то же устройство.
 */
/** Все аккаунты одного человека: текущий плюс все удалённые до него.
 *
 *  Удаление аккаунта не стирает человека — при повторной регистрации на тот же
 *  номер заводится НОВАЯ строка со ссылкой previous_user_id на старую. Без
 *  обхода этой цепочки попытка выдавалась бы заново после каждого удаления
 *  профиля, и главный приз доставался бы тому, кто упорнее удаляет аккаунт.
 */
async function accountChain(userId) {
  const ids = [];
  let cur = userId;
  // Ограничение на глубину — страховка от кольца в данных, а не от длинной
  // истории: двадцати перерегистраций хватает с запасом.
  for (let i = 0; cur && i < 20; i++) {
    if (ids.includes(cur)) break;
    ids.push(cur);
    const { data } = await supabase
      .from('users')
      .select('previous_user_id')
      .eq('id', cur)
      .maybeSingle();
    cur = data && data.previous_user_id;
  }
  return ids;
}

async function spinsLeft(owner, cfg) {
  const userId = owner && owner.userId;
  const deviceId = owner && owner.deviceId;
  if (!userId && !deviceId) return 0;

  let q = supabase
    .from('wheel_spins')
    .select('id', { count: 'exact', head: true })
    .neq('status', 'cancelled');

  // PostgREST: «или» по двум колонкам. Пустую сторону не добавляем, иначе
  // условие станет `device_id=eq.null` и перестанет совпадать с чем-либо.
  // По аккаунту считаем всю цепочку перерегистраций, а не только текущий id.
  const ids = userId ? await accountChain(userId) : [];
  if (ids.length && deviceId) {
    q = q.or(`user_id.in.(${ids.join(',')}),device_id.eq.${deviceId}`);
  } else if (ids.length) {
    q = q.in('user_id', ids);
  } else {
    q = q.eq('device_id', deviceId);
  }

  const { count, error } = await q;
  if (error) throw new Error('не удалось посчитать прокрутки: ' + error.message);
  return Math.max(0, Number(cfg.spins_per_user || 0) - Number(count || 0));
}

/** Сколько призов уже разыграно. Нужно, чтобы остановить акцию на обещанном
 *  числе победителей: объявили тысячу — значит тысяча, а не сколько придёт. */
async function winnersCount() {
  // ⚠️ Считаем ТОЛЬКО призы с владельцем. Незабранные гостевые прокрутки в
  // счёт не идут: иначе человек с десятком меток устройства выбирает себе
  // выигрыш поудобнее, а остальные его прокрутки съедают лимит кампании —
  // акция закрывается для настоящих клиентов, ничего им не отдав.
  const { count, error } = await supabase
    .from('wheel_spins')
    .select('id', { count: 'exact', head: true })
    .not('user_id', 'is', null)
    .neq('status', 'cancelled');
  if (error) throw new Error('не удалось посчитать победителей: ' + error.message);
  return Number(count || 0);
}

/** Номер для чужих глаз: виден код оператора и две последние цифры. Этого хватает,
 *  чтобы лента победителей выглядела живой, и мало, чтобы по ней найти человека. */
function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 7) return null;
  return `+${d.slice(0, 3)} ${d.slice(3, 5)} ••• •• ${d.slice(-2)}`;
}

/** Последние выигрыши для ленты «Кто что выиграл». Те же правила, что у
 *  winnersCount: только призы с владельцем; удалённые аккаунты не показываем. */
async function recentWinners(limit = 10) {
  const { data: spins, error } = await supabase
    .from('wheel_spins')
    .select('user_id, prize_label, kind, created_at')
    .not('user_id', 'is', null)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(limit * 2);
  if (error) throw new Error('не удалось загрузить победителей: ' + error.message);
  if (!spins.length) return [];

  const ids = [...new Set(spins.map((s) => s.user_id))];
  const { data: users, error: uErr } = await supabase
    .from('users')
    .select('id, phone, deleted_at')
    .in('id', ids);
  if (uErr) throw new Error('не удалось загрузить победителей: ' + uErr.message);
  const phones = new Map(users.filter((u) => !u.deleted_at).map((u) => [u.id, u.phone]));

  return spins
    .map((s) => ({ who: maskPhone(phones.get(s.user_id)), prize: s.prize_label, kind: s.kind, at: s.created_at }))
    .filter((w) => w.who)
    .slice(0, limit);
}

/** Идёт ли акция прямо сейчас: включена, срок не вышел, победители не кончились.
 *  Возвращает { open, reason, winners, winnersLimit, endsAt }. */
async function promoState(cfg) {
  const winnersLimit = Number(cfg.winners_limit || 0);
  const endsAt = cfg.ends_at ? new Date(cfg.ends_at) : null;

  if (!cfg.enabled) return { open: false, reason: 'disabled', winners: 0, winnersLimit, endsAt };
  if (endsAt && Date.now() > endsAt.getTime()) {
    return { open: false, reason: 'finished', winners: 0, winnersLimit, endsAt };
  }

  // Здесь счёт победителей нужен только для экрана и для быстрого «акция
  // закрыта». Настоящий, не обгоняемый предел держит wheel_spin_record: он
  // пересчитывает победителей внутри той же транзакции, что и запись приза.
  const winners = winnersLimit > 0 ? await winnersCount() : 0;
  if (winnersLimit > 0 && winners >= winnersLimit) {
    return { open: false, reason: 'all_won', winners, winnersLimit, endsAt };
  }
  return { open: true, reason: null, winners, winnersLimit, endsAt };
}

/** Прокрутить колесо. Возвращает { prize, balance, pending } либо бросает
 *  понятную ошибку.
 *
 *  owner — { userId } у вошедшего, { deviceId } у гостя.
 *  Гостю приз ЗАПИСЫВАЕТСЯ, но на счёт не кладётся: счёта у него ещё нет.
 *  Начисление произойдёт в claimFor() сразу после регистрации — до тех пор
 *  выигрыш числится за устройством и ждёт (pending: true).
 */
async function spin(owner) {
  const userId = (owner && owner.userId) || null;
  const deviceId = (owner && owner.deviceId) || null;
  if (!userId && !deviceId) {
    const e = new Error('Не удалось определить устройство'); e.code = 'no_owner'; throw e;
  }

  const cfg = await getConfig();
  const state = await promoState(cfg);
  if (!state.open) {
    const e = new Error(
      state.reason === 'all_won'
        ? 'Все призы акции уже разыграны'
        : state.reason === 'finished'
            ? 'Акция завершена'
            : 'Акция сейчас не проводится',
    );
    e.code = state.reason === 'disabled' ? 'disabled' : 'closed';
    throw e;
  }

  const left = await spinsLeft({ userId, deviceId }, cfg);
  if (left <= 0) { const e = new Error('Вы уже использовали свою попытку'); e.code = 'no_spins'; throw e; }

  // ⚠️ Гость с НЕЗАБРАННЫМ выигрышем второй раз не крутит. Метку устройства
  // присылает телефон, подделать её ничего не стоит, но вместе с правилом
  // «один незабранный приз на устройство» перебор перестаёт быть выгодным:
  // чтобы крутить снова, прежний приз надо сначала забрать — то есть
  // зарегистрироваться, а там уже действует лимит на аккаунт.
  if (!userId && deviceId) {
    const { count: pending } = await supabase
      .from('wheel_spins')
      .select('id', { count: 'exact', head: true })
      .eq('device_id', deviceId)
      .is('user_id', null)
      .neq('status', 'cancelled');
    if (Number(pending || 0) > 0) {
      const e = new Error('Ваш выигрыш уже ждёт — зарегистрируйтесь, чтобы забрать его');
      e.code = 'no_spins';
      throw e;
    }
  }

  const prize = drawPrize(cfg.prizes);
  if (!prize) { const e = new Error('Призы не настроены'); e.code = 'no_prizes'; throw e; }

  // ⚠️ НАЧИСЛЕНИЕ И ЗАПИСЬ ПРОКРУТКИ — ОДНА ТРАНЗАКЦИЯ. Раньше вошедшему
  // пользователю сперва вставлялось начисление, потом прокрутка, а лимит
  // попыток проверялся третьим запросом выше. Два одновременных нажатия
  // (двойной тап, повтор запроса) проходили проверку оба и давали два приза за
  // одну попытку; откат «удалим начисление, если прокрутка не вставилась» от
  // этого не спасал — вставлялись-то обе. Теперь лимит попыток и лимит
  // победителей пересчитываются внутри той же транзакции, что и записи.
  const { data: rec, error: recErr } = await supabase.rpc('wheel_spin_record', {
    uids: userId ? await accountChain(userId) : [],
    dev: deviceId,
    max_spins: Number(cfg.spins_per_user || 1),
    winners_limit: Number(cfg.winners_limit || 0),
    p_code: prize.code,
    p_label: prize.label,
    p_amount: Number(prize.amount || 0),
    p_kind: prize.kind,
    days_valid: Number(cfg.expires_days || 30),
  });
  if (recErr) throw new Error('не удалось записать прокрутку: ' + recErr.message);
  const row = Array.isArray(rec) ? rec[0] : rec;
  if (!row || !row.spin_id) {
    // Гонку проиграли: пока крутилось колесо, попытка или призы кончились.
    const e = new Error(row && row.reason === 'all_won'
      ? 'Все призы акции уже разыграны'
      : 'Вы уже использовали свою попытку');
    e.code = row && row.reason === 'all_won' ? 'closed' : 'no_spins';
    throw e;
  }

  return {
    prize,
    balance: userId ? await balanceOf(userId) : 0,
    pending: !userId, // приз ждёт регистрации
  };
}

/** Выигрыш, который уже сделан с этого устройства, но ещё не забран.
 *
 *  Нужен экрану колеса: гость выиграл, потерял диалог (перезапуск, обычный
 *  вход вместо регистрации из диалога) — и штатного пути «забрать» не
 *  оставалось, хотя сервер прокрутку помнит (F19). Отдаём самую раннюю.
 */
async function pendingPrizeOf({ deviceId }) {
  if (!deviceId) return null;
  const { data, error } = await supabase
    .from('wheel_spins')
    .select('prize_code, prize_label, amount, kind')
    .eq('device_id', deviceId)
    .is('user_id', null)
    .is('claimed_at', null)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) { console.error('pendingPrizeOf:', error.message); return null; }
  const row = (data || [])[0];
  if (!row) return null;
  return { code: row.prize_code, label: row.prize_label, kind: row.kind, amount: Number(row.amount || 0) };
}

/** Забрать выигрыши, накрученные этим устройством до регистрации.
 *
 *  Зовётся сразу после входа. Берёт прокрутки устройства без владельца,
 *  привязывает их к аккаунту и начисляет бонус. Возвращает сколько начислено.
 *
 *  ⚠️ Порядок обратный спину: сперва создаём начисление, и только если оно
 *  прошло — помечаем прокрутку забранной. Упадём посередине — прокрутка
 *  останется неотмеченной и начисление повторится при следующем входе, что
 *  лучше, чем молча потерять выигрыш. От двойного начисления защищает
 *  claimed_at: отмеченную прокрутку второй раз уже не возьмём.
 */
async function claimFor(userId, deviceId) {
  if (!userId || !deviceId) return { claimed: 0, amount: 0 };
  const cfg = await getConfig();

  // ⚠️ Сколько прокруток человеку ещё положено. Без этой проверки появляется
  // дыра: гость крутит, приз не нравится, он сносит приложение и ставит заново
  // — устройство новое, попытка новая, и так до главного приза, а забрать
  // можно всё разом. Привязываем не больше, чем положено на аккаунт.
  const allowed = await spinsLeft({ userId }, cfg);
  if (allowed <= 0) return { claimed: 0, amount: 0 };

  const { data: rows, error } = await supabase
    .from('wheel_spins')
    .select('id')
    .eq('device_id', deviceId)
    .is('user_id', null)
    .is('claimed_at', null)
    .neq('status', 'cancelled')
    // Самая ранняя прокрутка, а не самая выгодная: берём ту, что человек
    // действительно сделал первой.
    .order('created_at', { ascending: true })
    .limit(allowed);
  if (error) throw new Error('не удалось найти выигрыши устройства: ' + error.message);

  let claimed = 0;
  let total = 0;
  for (const row of rows || []) {
    // ⚠️ Захват и начисление — одной транзакцией в базе (wheel_claim_spin).
    // Раньше начисление создавалось ПЕРЕД закреплением выигрыша, а закрепление
    // с условием `claimed_at is null` при проигрыше гонки меняло ноль строк и
    // НЕ возвращало ошибку: начисление оставалось. Два одновременных «Забрать
    // приз» давали двойной бонус из воздуха.
    const { data, error: rpcErr } = await supabase.rpc('wheel_claim_spin', {
      uid: userId,
      spin: row.id,
      days_valid: Number(cfg.expires_days || 30),
    });
    if (rpcErr) throw new Error('не удалось забрать выигрыш: ' + rpcErr.message);

    const res = Array.isArray(data) ? data[0] : data;
    if (res && Number(res.claimed) > 0) {
      claimed++;
      total += Number(res.amount || 0);
    }
  }

  return { claimed, amount: total };
}

/** Кому пора напомнить, что бонус скоро сгорит.
 *
 *  Срок виден на экранах, но человек в приложение не заходит — и выигрыш
 *  сгорает молча. Это худший исход для акции: мы подарили, он не узнал.
 *
 *  Берём начисления, которые сгорают в ближайшие [days] суток и ещё не
 *  потрачены целиком. Возвращает [{ userId, amount, expiresAt }].
 */
async function expiringSoon(days = 3, onlyUserId = null) {
  const now = new Date();
  const until = new Date(now.getTime() + days * 86400_000);

  // Та же выборка служит двум задачам: рассылке напоминаний (по всем) и экрану
  // баланса одного человека — ему нужен ближайший срок среди ЖИВЫХ остатков.
  let q = supabase
    .from('wallet_entries')
    .select('id, user_id, amount, expires_at')
    .gt('amount', 0)
    .is('parent_id', null)          // только начисления, не возвраты
    .not('expires_at', 'is', null)
    .gt('expires_at', now.toISOString())
    .lte('expires_at', until.toISOString());
  if (onlyUserId) q = q.eq('user_id', onlyUserId);

  const { data: credits, error } = await q;
  if (error) throw new Error('не удалось найти сгорающие бонусы: ' + error.message);
  if (!credits || !credits.length) return [];

  // Сколько с каждого начисления уже потрачено: напоминать о нуле незачем.
  const ids = credits.map((c) => c.id);
  const { data: spent } = await supabase
    .from('wallet_entries')
    .select('parent_id, amount')
    .in('parent_id', ids);

  const used = new Map();
  for (const s of spent || []) {
    used.set(s.parent_id, (used.get(s.parent_id) || 0) + Number(s.amount)); // отрицательное
  }

  // Складываем остатки по человеку: у него может быть несколько начислений.
  const byUser = new Map();
  for (const c of credits) {
    const left = Number(c.amount) + (used.get(c.id) || 0);
    if (left <= 0) continue;
    const cur = byUser.get(c.user_id);
    const expiresAt = new Date(c.expires_at);
    if (cur) {
      cur.amount += left;
      // Напоминаем по самому раннему сроку — он и есть крайний.
      if (expiresAt < cur.expiresAt) cur.expiresAt = expiresAt;
    } else {
      byUser.set(c.user_id, { userId: c.user_id, amount: left, expiresAt });
    }
  }
  return [...byUser.values()];
}

/** Списать бонус под заказ. Списание ссылается на конкретные начисления
 *  (parent_id), поэтому сгоревшее начисление уносит свои траты с собой. */
async function spend(userId, rentalId, amount) {
  if (!(amount > 0)) return 0;
  // ⚠️ Списание идёт одной транзакцией в базе (wallet_spend): начисления там
  // берутся под блокировку. Раньше остаток читался отдельным запросом, и два
  // одновременных заказа видели одни и те же деньги — бонус уходил дважды.
  const { data, error } = await supabase.rpc('wallet_spend', {
    uid: userId, rid: rentalId, want: Math.floor(amount),
  });
  if (error) throw new Error('не удалось списать бонус: ' + error.message);
  return Number(data || 0);
}

/** Вернуть списанное при отмене заказа.
 *
 *  ⚠️ ИДЕМПОТЕНТНО. Заказ отменяется из нескольких мест (пользователь, админ,
 *  крон брошенных, отмена транзакции в Payme и Click), и один заказ вполне
 *  может быть отменён дважды подряд. Без сверки с уже сделанными возвратами
 *  человек получал бы бонус заново при каждом вызове — из воздуха.
 */
async function refund(userId, rentalId) {
  if (!userId || !rentalId) return 0;
  // ⚠️ Возврат тоже одной транзакцией (wallet_refund_rental). Прежняя версия
  // читала уже возвращённое и писала сторно отдельно: два параллельных
  // возврата одного заказа возвращали двойную сумму, а неудачная вставка
  // молча считалась успехом.
  const { data, error } = await supabase.rpc('wallet_refund_rental', {
    uid: userId, rid: rentalId,
  });
  if (error) throw new Error('не удалось вернуть бонус: ' + error.message);
  return Number(data || 0);
}

module.exports = {
  DEFAULTS, SETTINGS_KEY, getConfig, dropCache,
  balanceOf, applicable, drawPrize, layoutSectors,
  winnersCount, recentWinners, maskPhone, promoState, accountChain, spinsLeft, spin, claimFor, pendingPrizeOf,
  expiringSoon, spend, refund,
};
