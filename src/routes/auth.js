const express = require('express');
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');
const { sendSmsCode } = require('../lib/sms');

const router = express.Router();

// Хранилище кодов (в MVP — в памяти, потом Redis)
const codes = new Map();

// POST /api/auth/send-code
// Отправить SMS-код на номер телефона
router.post('/send-code', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone || !phone.match(/^\+998\d{9}$/)) {
      return res.status(400).json({ error: 'Введите корректный номер: +998XXXXXXXXX' });
    }

    // Генерируем 4-значный код
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    
    // Сохраняем код (живёт 5 минут)
    codes.set(phone, { code, expires: Date.now() + 5 * 60 * 1000 });

    // Отправляем SMS (пока просто в консоль)
    await sendSmsCode(phone, code);

    res.json({ success: true, message: 'Код отправлен' });
  } catch (err) {
    console.error('send-code error:', err);
    res.status(500).json({ error: 'Ошибка отправки кода' });
  }
});

// POST /api/auth/verify
// Проверить SMS-код и авторизовать
router.post('/verify', async (req, res) => {
  try {
    const { phone, code, name } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ error: 'Укажите номер и код' });
    }

    // Проверяем код
    const stored = codes.get(phone);
    if (!stored || stored.code !== code) {
      return res.status(401).json({ error: 'Неверный код' });
    }
    if (Date.now() > stored.expires) {
      codes.delete(phone);
      return res.status(401).json({ error: 'Код истёк, запросите новый' });
    }

    // Код верный — удаляем
    codes.delete(phone);

    // Ищем пользователя в базе
    let { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .single();

    // Если нет — создаём (регистрация)
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
    }

    // Проверяем блокировку
    if (user.is_blocked) {
      return res.status(403).json({ error: 'Аккаунт заблокирован' });
    }

    // Генерируем JWT-токен
    const token = jwt.sign(
      { userId: user.id, phone: user.phone },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name
      }
    });
  } catch (err) {
    console.error('verify error:', err);
    res.status(500).json({ error: 'Ошибка авторизации' });
  }
});

module.exports = router;
