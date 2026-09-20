// Публичные настройки для приложения (без авторизации — гость видит тариф доставки).
const express = require('express');
const orders = require('../lib/orders');

const router = express.Router();

// GET /api/settings/delivery — тариф, город и доступные интервалы на ближайшие дни
router.get('/delivery', async (req, res) => {
  try {
    const s = await orders.getDelivery();
    res.json({
      fee: s.fee,
      city: s.city,
      same_day_min_hours: s.same_day_min_hours,
      slots: await orders.availableSlots(),
    });
  } catch (err) {
    console.error('settings delivery error:', err);
    res.status(500).json({ error: 'Ошибка настроек доставки' });
  }
});

module.exports = router;
