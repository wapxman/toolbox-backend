require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const boxRoutes = require('./routes/boxes');
const toolRoutes = require('./routes/tools');
const rentalRoutes = require('./routes/rentals');
const notificationRoutes = require('./routes/notifications');
const lockRoutes = require('./routes/locks');
const paymeRoutes = require('./routes/payme');
const clickRoutes = require('./routes/click');
const cronRoutes = require('./routes/cron');
const settingsRoutes = require('./routes/settings');
const adminRoutes = require('./routes/admin');
const kerong = require('./lib/kerong');
const notify = require('./lib/notify');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    name: 'Taketool API',
    version: '1.2.0',
    kerong: kerong.MOCK_MODE ? 'mock' : 'live'
  });
});

// GET /health — для внешнего монитора. Наружу только вердикт: подробности
// (имена незаданных env, текст ошибки канала) отдаёт /api/admin/health.
// degraded + 503 означает «API жив, но уведомления не доходят» — именно это
// раньше нельзя было заметить никак.
app.get('/health', async (req, res) => {
  const problems = [];
  if (notify.configReport().missing.length) problems.push('notifications_misconfigured');
  try {
    const o = await notify.stats();
    if (o.dead_24h > 0) problems.push('notifications_dead');
    if (o.oldest_queued_age_min > 15) problems.push('notifications_stuck');
  } catch {
    problems.push('database_unreachable');
  }
  res.status(problems.length ? 503 : 200).json({
    status: problems.length ? 'degraded' : 'ok',
    problems,
    kerong: kerong.MOCK_MODE ? 'mock' : 'live',
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/boxes', boxRoutes);
app.use('/api/tools', toolRoutes);
app.use('/api/rentals', rentalRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/locks', lockRoutes);
app.use('/api/payments/payme', paymeRoutes);
// Алиас на случай, если в кабинете Payme прописан короткий путь endpoint.
// Оба адреса ведут на один и тот же Merchant-API обработчик.
app.use('/api/payme', paymeRoutes);
// Click SHOP API: /api/payments/click/prepare и /complete — эти URL прописываем
// в кабинете merchant.click.uz (Сервисы → адреса проверки и результата).
app.use('/api/payments/click', clickRoutes);
// Cron-задачи Vercel (защищены CRON_SECRET)
app.use('/api/cron', cronRoutes);
// Публичные настройки (тариф и интервалы доставки)
app.use('/api/settings', settingsRoutes);
// Админские переходы заказов (X-Admin-Secret)
app.use('/api/admin', adminRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Что-то пошло не так' });
});

// Для Vercel — экспортируем app
module.exports = app;

// Для локальной разработки — запускаем сервер
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n  Taketool API запущен: http://localhost:${PORT}`);
    console.log(`  Kerong: ${kerong.MOCK_MODE ? 'MOCK режим' : 'LIVE'}\n`);
  });
}
