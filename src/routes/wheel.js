// Колесо Фортуны и кошелёк — ручки для приложения.
const express = require('express');
const auth = require('../middleware/auth');
const optionalAuth = require('../middleware/optionalAuth');
const wheel = require('../lib/wheel');

const router = express.Router();

// Устройство, с которого крутят. Нужно, чтобы гость мог выиграть до
// регистрации, а попытка при этом осталась одна: иначе выход из аккаунта
// давал бы бесконечные прокрутки.
const deviceOf = (req) => {
  const raw = req.get('X-Device-Id') || req.body?.device_id || req.query?.device_id || '';
  const id = String(raw).trim();
  // Длину режем: это ключ в запросах, а не место для чужого текста.
  return id && id.length <= 128 ? id : null;
};

// GET /api/wheel — что показать на экране колеса. Открыт и гостю: акция
// существует ради незарегистрированных, за дверью она бессмысленна.
// Призы отдаём БЕЗ весов: шансы это внутренняя кухня, в приложении им не место.
router.get('/', optionalAuth, async (req, res) => {
  try {
    const cfg = await wheel.getConfig();
    const deviceId = deviceOf(req);
    const [left, balance, state, pendingPrize] = await Promise.all([
      wheel.spinsLeft({ userId: req.userId, deviceId }, cfg),
      req.userId ? wheel.balanceOf(req.userId) : Promise.resolve(0),
      wheel.promoState(cfg),
      wheel.pendingPrizeOf({ deviceId }),
    ]);
    res.json({
      // Акция «включена» только если идёт на самом деле: срок не вышел и
      // победители не кончились. Иначе кнопка обещала бы несуществующее.
      enabled: state.open,
      closed_reason: state.reason, // disabled | finished | all_won | null
      spins_left: left,
      balance,
      expires_days: Number(cfg.expires_days || 30),
      max_pay_pct: Number(cfg.max_pay_pct || 50),
      prizes: (cfg.prizes || []).map((p) => ({
        code: p.code, label: p.label, kind: p.kind, amount: Number(p.amount || 0),
      })),
      // Раскладка секторов: коды призов по кругу, дешёвые повторяются. Считаем
      // здесь, потому что строится она из весов, а веса наружу не отдаём.
      sectors: wheel.layoutSectors(cfg.prizes, Number(cfg.sectors_count || 12)),
      // Гостю приз зачислится только после регистрации. Приложение обязано
      // сказать об этом ДО прокрутки, иначе выйдет ловушка.
      requires_account: !req.userId,
      // Выигрыш, сделанный с этого устройства и не забранный: гость потерял
      // диалог или вошёл обычным входом. Приложение по нему восстанавливает
      // путь «Забрать приз» (F19).
      pending_prize: pendingPrize,
      // Правила акции для экрана «Правила». Требование Apple 5.3.2 и Google
      // Play (Gamified Loyalty Programs): фиксированное число победителей,
      // дедлайн участия и срок выдачи приза должны быть видны в приложении.
      rules: {
        winners_limit: state.winnersLimit,
        winners_so_far: state.winners,
        ends_at: cfg.ends_at || null,
        spins_per_user: Number(cfg.spins_per_user || 1),
        expires_days: Number(cfg.expires_days || 30),
        max_pay_pct: Number(cfg.max_pay_pct || 50),
      },
    });
  } catch (err) {
    console.error('wheel get error:', err);
    res.status(500).json({ error: 'Не удалось загрузить акцию' });
  }
});

// POST /api/wheel/spin — крутить. Приз выбирает сервер.
// Гостю тоже можно: выигрыш запишется за устройством и дождётся регистрации.
router.post('/spin', optionalAuth, async (req, res) => {
  try {
    const { prize, balance, pending } = await wheel.spin({
      userId: req.userId,
      deviceId: deviceOf(req),
    });
    res.json({
      prize: { code: prize.code, label: prize.label, kind: prize.kind, amount: Number(prize.amount || 0) },
      balance,
      pending, // true — приз ждёт регистрации
    });
  } catch (err) {
    // Ожидаемые отказы отдаём 400 с человеческим текстом, а не 500: это не
    // поломка, а правило акции, и приложение должно показать его словами.
    if (err.code === 'no_spins' || err.code === 'disabled' || err.code === 'closed'
        || err.code === 'no_prizes' || err.code === 'no_owner') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('wheel spin error:', err);
    res.status(500).json({ error: 'Не удалось прокрутить колесо' });
  }
});

// POST /api/wheel/claim — забрать выигрыш, накрученный до регистрации.
// Зовётся приложением сразу после входа. Без device_id забирать нечего.
router.post('/claim', auth, async (req, res) => {
  try {
    const { claimed, amount } = await wheel.claimFor(req.userId, deviceOf(req));
    res.json({ claimed, amount, balance: await wheel.balanceOf(req.userId) });
  } catch (err) {
    console.error('wheel claim error:', err);
    res.status(500).json({ error: 'Не удалось забрать выигрыш' });
  }
});

// GET /api/wheel/balance — только счёт и ближайшее сгорание.
// Отдельно от /wallet: баланс показывается на главной, в магазине и в профиле,
// и тащить ради строчки полсотни движений кошелька незачем.
router.get('/balance', auth, async (req, res) => {
  try {
    const cfg = await wheel.getConfig();
    // ⚠️ Ближайшее сгорание ищем среди НЕПОТРАЧЕННЫХ начислений. Иначе человек
    // видит «сгорит через 2 дня» про начисление, которое он уже израсходовал,
    // и пугается зря — а настоящий срок его живых денег остаётся неизвестным.
    const [balance, soon] = await Promise.all([
      wheel.balanceOf(req.userId),
      wheel.expiringSoon(3650, req.userId), // ближайший срок среди живых остатков
    ]);
    res.json({
      balance,
      max_pay_pct: Number(cfg.max_pay_pct || 50),
      // Ближайшее сгорание — то, ради чего человек возвращается. Молчать о нём
      // нечестно: бонус исчезнет, а он и не узнает.
      expires_at: soon.length ? soon[0].expiresAt.toISOString() : null,
    });
  } catch (err) {
    console.error('wallet balance error:', err);
    res.status(500).json({ error: 'Не удалось загрузить бонусный счёт' });
  }
});

// GET /api/wheel/wallet — баланс и история движений.
router.get('/wallet', auth, async (req, res) => {
  try {
    const supabase = require('../lib/supabase');
    const cfg = await wheel.getConfig();
    const [balance, { data: rows }] = await Promise.all([
      wheel.balanceOf(req.userId),
      supabase
        .from('wallet_entries')
        .select('id, amount, kind, note, expires_at, created_at, rental_id')
        .eq('user_id', req.userId)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);
    res.json({
      balance,
      max_pay_pct: Number(cfg.max_pay_pct || 50),
      entries: (rows || []).map((r) => ({
        id: r.id, amount: r.amount, kind: r.kind, note: r.note,
        expires_at: r.expires_at, created_at: r.created_at, rental_id: r.rental_id,
      })),
    });
  } catch (err) {
    console.error('wallet error:', err);
    res.status(500).json({ error: 'Не удалось загрузить кошелёк' });
  }
});

// GET /api/wheel/quote?items_price=NNN — сколько спишется с такого заказа.
// Нужна экрану заказа ДО оформления: человек должен видеть цифру заранее,
// а считать её на телефоне нельзя — потолок и баланс живут на сервере.
router.get('/quote', auth, async (req, res) => {
  try {
    const itemsPrice = Math.max(0, parseInt(req.query.items_price, 10) || 0);
    const cfg = await wheel.getConfig();
    const balance = await wheel.balanceOf(req.userId);
    const apply = wheel.applicable(balance, itemsPrice, Number(cfg.max_pay_pct || 50));
    res.json({ balance, applicable: apply, max_pay_pct: Number(cfg.max_pay_pct || 50) });
  } catch (err) {
    console.error('wallet quote error:', err);
    res.status(500).json({ error: 'Не удалось посчитать бонус' });
  }
});

module.exports = router;
