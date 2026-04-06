const express = require('express');
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');
const { sendSmsCode } = require('../lib/sms');
const auth = require('../middleware/auth');

const router = express.Router();

// Хранилище кодов (в MVP — в памяти)
const codes = new Map();

// POST /api/auth/send-code
router.post('/send-code', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone || !phone.match(/^\+998\d{9}$/)) {
      return res.status(400).json({ error: 'Введите корректный номер: +998XXXXXXXXX' });
    }

    // Rate limit: 1 код в 60 сек
    const existing = codes.get(phone);
    if (existing && Date.now() - existing.created < 60000) {
      const wait = Math.ceil((60000 - (Date.now() - existing.created)) / 1000);
      return res.status(429).json({ error: `Подождите ${wait} сек перед повторной отправкой` });
    }

    const code = Math.floor(1000 + Math.random() * 9000).toString();
    codes.set(phone, { code, created: Date.now(), expires: Date.now() + 5 * 60 * 1000 });

    await sendSmsCode(phone, code);

    res.json({ success: true, message: 'Код отправлен' });
  } catch (err) {
    console.error('send-code error:', err);
    res.status(500).json({ error: 'Ошибка отправки кода' });
  }
});

// POST /api/auth/verify
router.post('/verify', async (req, res) => {
  try {
    const { phone, code, name } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ error: 'Укажите номер и код' });
    }

    const stored = codes.get(phone);
    if (!stored || stored.code !== code) {
      return res.status(401).json({ error: 'Неверный код' });
    }
    if (Date.now() > stored.expires) {
      codes.delete(phone);
      return res.status(401).json({ error: 'Код истёк, запросите новый' });
    }

    codes.delete(phone);

    // Ищем или создаём пользователя
    let { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .single();

    if (!user) {
      const { data: newUser, error } = await supabase
        .from('users')
        .insert({
          phone,
          name: name || 'Пользователь',
          terms_accepted_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) throw error;
      user = newUser;

      // Создаём приветственное уведомление
      await supabase.from('notifications').insert({
        user_id: user.id,
        type: 'welcome',
        title: 'Добро пожаловать!',
        message: 'Регистрация завершена. Найдите ближайший бокс и арендуйте первый инструмент!'
      });
    }

    if (user.is_blocked) {
      return res.status(403).json({ error: 'Аккаунт заблокирован' });
    }

    const token = jwt.sign(
      { userId: user.id, phone: user.phone },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      user: { id: user.id, phone: user.phone, name: user.name }
    });
  } catch (err) {
    console.error('verify error:', err);
    res.status(500).json({ error: 'Ошибка авторизации' });
  }
});

// GET /api/auth/me — профиль текущего пользователя
router.get('/me', auth, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Статистика
    const { count: totalRentals } = await supabase
      .from('rentals')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.userId);

    const { count: activeRentals } = await supabase
      .from('rentals')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.userId)
      .in('status', ['active', 'overdue']);

    const { data: sumData } = await supabase
      .from('rentals')
      .select('total_price')
      .eq('user_id', req.userId)
      .eq('status', 'completed');

    const totalSpent = (sumData || []).reduce((sum, r) => sum + r.total_price, 0);

    res.json({
      id: user.id,
      phone: user.phone,
      name: user.name,
      created_at: user.created_at,
      stats: {
        total_rentals: totalRentals || 0,
        active_rentals: activeRentals || 0,
        total_spent: totalSpent
      }
    });
  } catch (err) {
    console.error('me error:', err);
    res.status(500).json({ error: 'Ошибка загрузки профиля' });
  }
});

// PATCH /api/auth/me — обновить профиль
router.patch('/me', auth, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'Имя должно быть минимум 2 символа' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .update({ name: name.trim() })
      .eq('id', req.userId)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, user: { id: user.id, phone: user.phone, name: user.name } });
  } catch (err) {
    console.error('update me error:', err);
    res.status(500).json({ error: 'Ошибка обновления профиля' });
  }
});

module.exports = router;
