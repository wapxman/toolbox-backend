// Публичные настройки для приложения (без авторизации).
const express = require('express');
const orders = require('../lib/orders');

const router = express.Router();

// GET /api/settings/delivery — тариф, город и доступные интервалы на ближайшие дни
router.get('/delivery', async (req, res) => {
  try {
    const s = await orders.getDelivery();
    res.json({ fee: s.fee, city: s.city, same_day_min_hours: s.same_day_min_hours, slots: await orders.availableSlots() });
  } catch (err) {
    console.error('settings delivery error:', err);
    res.status(500).json({ error: 'Ошибка настроек доставки' });
  }
});

// GET /api/settings/support — контакты поддержки (телефон, Telegram, e-mail)
router.get('/support', async (req, res) => {
  try {
    const s = await orders.getSupport();
    res.json({ phone: s.phone || null, telegram: s.telegram || null, email: s.email || null });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка настроек поддержки' });
  }
});

// GET /api/settings/terms — действующая редакция оферты (версия, дата, ссылка)
router.get('/terms', async (req, res) => {
  try {
    const t = await orders.getTerms();
    res.json({ version: String(t.version), date: t.date, url: t.url, title: t.title });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка настроек оферты' });
  }
});

module.exports = router;
