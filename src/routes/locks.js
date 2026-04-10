const express = require('express');
const kerong = require('../lib/kerong');
const auth = require('../middleware/auth');

const router = express.Router();

// GET /api/locks/status — статус подключения к Kerong LCS
router.get('/status', async (req, res) => {
  try {
    const status = await kerong.checkConnection();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка проверки Kerong' });
  }
});

// POST /api/locks/open — открыть замок напрямую (для тестов)
router.post('/open', auth, async (req, res) => {
  try {
    const { zoneId, lockNumber } = req.body;

    if (!zoneId || !lockNumber) {
      return res.status(400).json({ error: 'Укажите zoneId и lockNumber' });
    }

    const result = await kerong.openLock(zoneId, lockNumber);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('open lock error:', err);
    res.status(500).json({ error: 'Ошибка открытия замка' });
  }
});

// GET /api/locks/free/:zoneId — свободные ячейки
router.get('/free/:zoneId', auth, async (req, res) => {
  try {
    const locks = await kerong.getFreeLocks(parseInt(req.params.zoneId));
    res.json({ free_locks: locks });
  } catch (err) {
    console.error('free locks error:', err);
    res.status(500).json({ error: 'Ошибка получения свободных ячеек' });
  }
});

module.exports = router;
