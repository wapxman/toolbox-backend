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

/** Сколько прокруток осталось у пользователя. */
async function spinsLeft(userId, cfg) {
  const { count, error } = await supabase
    .from('wheel_spins')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .neq('status', 'cancelled');
  if (error) throw new Error('не удалось посчитать прокрутки: ' + error.message);
  return Math.max(0, Number(cfg.spins_per_user || 0) - Number(count || 0));
}

/** Прокрутить колесо. Возвращает { prize, balance } либо бросает понятную ошибку. */
async function spin(userId) {
  const cfg = await getConfig();
  if (!cfg.enabled) { const e = new Error('Акция сейчас не проводится'); e.code = 'disabled'; throw e; }

  const left = await spinsLeft(userId, cfg);
  if (left <= 0) { const e = new Error('Вы уже использовали свою попытку'); e.code = 'no_spins'; throw e; }

  const prize = drawPrize(cfg.prizes);
  if (!prize) { const e = new Error('Призы не настроены'); e.code = 'no_prizes'; throw e; }

  let walletEntryId = null;
  if (prize.kind === 'bonus' && Number(prize.amount) > 0) {
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
    prize_code: prize.code,
    prize_label: prize.label,
    amount: Number(prize.amount || 0),
    kind: prize.kind,
    wallet_entry_id: walletEntryId,
  });
  // ⚠️ Если запись прокрутки не прошла, а бонус уже начислен — откатываем
  // начисление. Иначе человек получит бесплатную попытку и деньги: прокруток
  // по счёту ноль, а бонус на счету.
  if (spinErr) {
    if (walletEntryId) await supabase.from('wallet_entries').delete().eq('id', walletEntryId);
    throw new Error('не удалось записать прокрутку: ' + spinErr.message);
  }

  return { prize, balance: await balanceOf(userId) };
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
  balanceOf, applicable, drawPrize, spinsLeft, spin, spend, refund,
};
