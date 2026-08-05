const express = require('express');
const kerong = require('../lib/kerong');

const router = express.Router();

// Служебные роуты управления замками. Раньше были доступны любому залогиненному
// пользователю (а /status — вообще без авторизации и светил URL туннеля LCS).
// Теперь все закрыты админ-секретом: заголовок X-Admin-Secret === ADMIN_API_SECRET.
// Если ADMIN_API_SECRET не задан в env — роуты выключены (fail closed).
function adminOnly(req, res, next) {
  const secret = process.env.ADMIN_API_SECRET;
  if (!secret || req.headers['x-admin-secret'] !== secret) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

router.use(adminOnly);

// GET /api/locks/status — статус подключения к Kerong LCS
router.get('/status', async (req, res) => {
  try {
    const status = await kerong.checkConnection();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка проверки Kerong' });
  }
});

// POST /api/locks/open — открыть замок напрямую (сервисный)
router.post('/open', async (req, res) => {
  try {
    const { zoneId, lockNumber } = req.body;

    // Нумерация замков 0-based — проверяем именно на null/undefined,
    // иначе lockNumber=0 отвергался бы как «пустой».
    if (zoneId == null || lockNumber == null) {
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
router.get('/free/:zoneId', async (req, res) => {
  try {
    const locks = await kerong.getFreeLocks(parseInt(req.params.zoneId));
    res.json({ free_locks: locks });
  } catch (err) {
    console.error('free locks error:', err);
    res.status(500).json({ error: 'Ошибка получения свободных ячеек' });
  }
});

module.exports = router;
