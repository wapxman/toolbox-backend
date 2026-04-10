require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const boxRoutes = require('./routes/boxes');
const toolRoutes = require('./routes/tools');
const rentalRoutes = require('./routes/rentals');
const notificationRoutes = require('./routes/notifications');
const lockRoutes = require('./routes/locks');
const kerong = require('./lib/kerong');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    name: 'ToolBox API',
    version: '1.1.0',
    kerong: kerong.MOCK_MODE ? 'mock' : 'live'
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/boxes', boxRoutes);
app.use('/api/tools', toolRoutes);
app.use('/api/rentals', rentalRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/locks', lockRoutes);

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
    console.log(`\n  ToolBox API запущен: http://localhost:${PORT}`);
    console.log(`  Kerong: ${kerong.MOCK_MODE ? 'MOCK режим' : 'LIVE'}\n`);
  });
}
