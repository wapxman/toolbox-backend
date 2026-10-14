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
  let value = DEFAULTS;
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle();
    if (data?.value) value = { ...DEFAULTS, ...data.value };
  } catch {
    // Настройки недоступны — работаем на умолчаниях, но НЕ молча: пусть видно в логе.
    console.error('wheel: не прочитал app_settings, беру умолчания');
  }
  cache.value = value;
  cache.ts = Date.now();
  return value;
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
  if (userId && deviceId) {
    q = q.or(`user_id.eq.${userId},device_id.eq.${deviceId}`);
  } else if (userId) {
    q = q.eq('user_id', userId);
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
  const { count, error } = await supabase
    .from('wheel_spins')
    .select('id', { count: 'exact', head: true })
    .neq('status', 'cancelled');
  if (error) throw new Error('не удалось посчитать победителей: ' + error.message);
  return Number(count || 0);
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

  // ⚠️ Проверка и запись прокрутки не атомарны: если тысячный приз разыграют
  // несколько человек в одну секунду, победителей может оказаться на единицы
  // больше. Для акции на тысячу это допустимый перелёт, а не дыра — блокировка
  // всей таблицы на каждую прокрутку обошлась бы дороже.
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

  const prize = drawPrize(cfg.prizes);
  if (!prize) { const e = new Error('Призы не настроены'); e.code = 'no_prizes'; throw e; }

  let walletEntryId = null;
  if (userId && prize.kind === 'bonus' && Number(prize.amount) > 0) {
    const expires = new Date(Date.now() + Number(cfg.expires_days || 30) * 86400_000).toISOString();
    const { data, error } = await supabase
      .from('wallet_entries')
      .insert({
        user_id: userId,
        amount: Number(prize.amount),
        kind: 'wheel_win',
        expires_at: expires,
        note: `Колесо Фортуны: ${prize.label}`,
      })
      .select('id')
      .single();
    if (error) throw new Error('не удалось начислить бонус: ' + error.message);
    walletEntryId = data.id;
  }

  const { error: spinErr } = await supabase.from('wheel_spins').insert({
    user_id: userId,
    device_id: deviceId,
    prize_code: prize.code,
    prize_label: prize.label,
    amount: Number(prize.amount || 0),
    kind: prize.kind,
    wallet_entry_id: walletEntryId,
    claimed_at: userId ? new Date().toISOString() : null,
  });
  // ⚠️ Если запись прокрутки не прошла, а бонус уже начислен — откатываем
  // начисление. Иначе человек получит бесплатную попытку и деньги: прокруток
  // по счёту ноль, а бонус на счету.
  if (spinErr) {
    if (walletEntryId) await supabase.from('wallet_entries').delete().eq('id', walletEntryId);
    throw new Error('не удалось записать прокрутку: ' + spinErr.message);
  }

  return {
    prize,
    balance: userId ? await balanceOf(userId) : 0,
    pending: !userId, // приз ждёт регистрации
  };
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
    .select('id, prize_label, amount, kind')
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
    let walletEntryId = null;
    if (row.kind === 'bonus' && Number(row.amount) > 0) {
      const expires = new Date(Date.now() + Number(cfg.expires_days || 30) * 86400_000).toISOString();
      const { data, error: insErr } = await supabase
        .from('wallet_entries')
        .insert({
          user_id: userId,
          amount: Number(row.amount),
          kind: 'wheel_win',
          expires_at: expires,
          note: `Колесо Фортуны: ${row.prize_label}`,
        })
        .select('id')
        .single();
      if (insErr) throw new Error('не удалось начислить выигрыш: ' + insErr.message);
      walletEntryId = data.id;
      total += Number(row.amount);
    }

    const { error: updErr } = await supabase
      .from('wheel_spins')
      .update({ user_id: userId, wallet_entry_id: walletEntryId, claimed_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('claimed_at', null); // гонка двух входов: второй не перезапишет
    if (updErr) {
      if (walletEntryId) await supabase.from('wallet_entries').delete().eq('id', walletEntryId);
      throw new Error('не удалось закрепить выигрыш: ' + updErr.message);
    }
    claimed++;
  }

  return { claimed, amount: total };
}

/** Списать бонус под заказ. Списание ссылается на конкретные начисления
 *  (parent_id), поэтому сгоревшее начисление уносит свои траты с собой. */
async function spend(userId, rentalId, amount) {
  if (!(amount > 0)) return 0;

  const { data: credits, error } = await supabase
    .from('wallet_entries')
    .select('id, amount, expires_at, created_at')
    .eq('user_id', userId)
    .gt('amount', 0)
    .order('expires_at', { ascending: true, nullsFirst: false });
  if (error) throw new Error('не удалось прочитать кошелёк: ' + error.message);

  const now = Date.now();
  let rest = amount;
  for (const c of credits || []) {
    if (rest <= 0) break;
    if (c.expires_at && new Date(c.expires_at).getTime() <= now) continue;
    const { data: used } = await supabase
      .from('wallet_entries')
      .select('amount')
      .eq('parent_id', c.id);
    const spentOnIt = (used || []).reduce((s, r) => s + Number(r.amount), 0); // отрицательное
    const left = Number(c.amount) + spentOnIt;
    if (left <= 0) continue;
    const take = Math.min(left, rest);
    const { error: insErr } = await supabase.from('wallet_entries').insert({
      user_id: userId,
      amount: -take,
      kind: 'rent_spend',
      parent_id: c.id,
      rental_id: rentalId,
      note: 'Списано на заказ',
    });
    if (insErr) throw new Error('не удалось списать бонус: ' + insErr.message);
    rest -= take;
  }
  return amount - rest;
}

/** Вернуть списанное при отмене заказа. */
async function refund(userId, rentalId) {
  const { data: spends } = await supabase
    .from('wallet_entries')
    .select('id, amount, parent_id')
    .eq('user_id', userId)
    .eq('rental_id', rentalId)
    .eq('kind', 'rent_spend');
  let total = 0;
  for (const s of spends || []) {
    const back = -Number(s.amount);
    if (back <= 0) continue;
    await supabase.from('wallet_entries').insert({
      user_id: userId,
      amount: back,
      kind: 'refund',
      parent_id: s.parent_id,
      rental_id: rentalId,
      note: 'Возврат при отмене заказа',
    });
    total += back;
  }
  return total;
}

module.exports = {
  DEFAULTS, SETTINGS_KEY, getConfig, dropCache,
  balanceOf, applicable, drawPrize, layoutSectors,
  winnersCount, promoState, spinsLeft, spin, claimFor, spend, refund,
};
