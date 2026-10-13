// Колесо Фортуны и кошелёк — ручки для приложения.
const express = require('express');
const auth = require('../middleware/auth');
const wheel = require('../lib/wheel');

const router = express.Router();

// GET /api/wheel — что показать на экране колеса.
// Призы отдаём БЕЗ весов: шансы это внутренняя кухня, в приложении им не место.
router.get('/', auth, async (req, res) => {
  try {
    const cfg = await wheel.getConfig();
    const [left, balance] = await Promise.all([
      wheel.spinsLeft(req.userId, cfg),
      wheel.balanceOf(req.userId),
    ]);
    res.json({
      enabled: !!cfg.enabled,
      spins_left: left,
      balance,
      expires_days: Number(cfg.expires_days || 30),
      max_pay_pct: Number(cfg.max_pay_pct || 50),
      prizes: (cfg.prizes || []).map((p) => ({
        code: p.code, label: p.label, kind: p.kind, amount: Number(p.amount || 0),
      })),
    });
  } catch (err) {
    console.error('wheel get error:', err);
    res.status(500).json({ error: 'Не удалось загрузить акцию' });
  }
});

// POST /api/wheel/spin — крутить. Приз выбирает сервер.
router.post('/spin', auth, async (req, res) => {
  try {
    const { prize, balance } = await wheel.spin(req.userId);
    res.json({
      prize: { code: prize.code, label: prize.label, kind: prize.kind, amount: Number(prize.amount || 0) },
      balance,
    });
  } catch (err) {
    // Ожидаемые отказы отдаём 400 с человеческим текстом, а не 500: это не
    // поломка, а правило акции, и приложение должно показать его словами.
    if (err.code === 'no_spins' || err.code === 'disabled' || err.code === 'no_prizes') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('wheel spin error:', err);
    res.status(500).json({ error: 'Не удалось прокрутить колесо' });
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
