const express = require('express');
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');
const { sendSmsCode } = require('../lib/sms');
const auth = require('../middleware/auth');

const router = express.Router();

// Коды хранятся в Supabase (таблица sms_codes) — in-memory Map не переживает
// serverless-инстансы Vercel: send-code и verify могут попасть на разные инстансы.

// Тестовые аккаунты для ревьюеров магазинов (Google Play / App Store) и демо-показов:
// env REVIEW_ACCOUNTS="+998900000000:1234,+998900000001:5678".
// Для таких номеров SMS не отправляется, вход — по фиксированному коду.
// Код "*" означает «принимать любой код» — для демо-номеров, чтобы не помнить пару.
function reviewCodeFor(phone) {
  const raw = process.env.REVIEW_ACCOUNTS || '';
  for (const pair of raw.split(',')) {
    const [p, c] = pair.trim().split(':');
    if (p && c && p === phone) return c;
  }
  return null;
}

// Совпал ли введённый код с тест-аккаунтом. Пустой код не принимаем никогда,
// даже для "*": /verify выше уже требует непустой code, это вторая линия.
function isReviewLogin(phone, code) {
  const expected = reviewCodeFor(phone);
  if (expected === null || !code) return false;
  return expected === '*' || expected === code;
}

// POST /api/auth/send-code
router.post('/send-code', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone || !phone.match(/^\+998\d{9}$/)) {
      return res.status(400).json({ error: 'Введите корректный номер: +998XXXXXXXXX' });
    }

    if (reviewCodeFor(phone)) {
      return res.json({ success: true, message: 'Код отправлен' });
    }

    // Rate limit: 1 код в 60 сек
    const { data: existing } = await supabase
      .from('sms_codes')
      .select('created_at')
      .eq('phone', phone)
      .single();

    if (existing) {
      const elapsed = Date.now() - new Date(existing.created_at).getTime();
      if (elapsed < 60000) {
        const wait = Math.ceil((60000 - elapsed) / 1000);
        return res.status(429).json({ error: `Подождите ${wait} сек перед повторной отправкой` });
      }
    }

    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const { error: upsertError } = await supabase
      .from('sms_codes')
      .upsert({
        phone,
        code,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
    if (upsertError) throw upsertError;

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

    // DEV-вход: пока SMS в режиме console (реальные SMS не подключены),
    // принимаем мастер-код для тестирования без получения СМС.
    // Как только SMS_PROVIDER станет реальным (eskiz/playmobile) — мастер-код
    // автоматически перестанет работать.
    const smsProvider = process.env.SMS_PROVIDER || 'console';
    const isDevMaster =
      smsProvider === 'console' && code === (process.env.DEV_LOGIN_CODE || '0000');
    const isReviewer = isReviewLogin(phone, code);

    if (!isDevMaster && !isReviewer) {
      const { data: stored } = await supabase
        .from('sms_codes')
        .select('code, expires_at')
        .eq('phone', phone)
        .single();

      if (!stored || stored.code !== code) {
        return res.status(401).json({ error: 'Неверный код' });
      }
      if (Date.now() > new Date(stored.expires_at).getTime()) {
        await supabase.from('sms_codes').delete().eq('phone', phone);
        return res.status(401).json({ error: 'Код истёк, запросите новый' });
      }
      await supabase.from('sms_codes').delete().eq('phone', phone);
    }

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

// DELETE /api/auth/me — удаление аккаунта (требование Google Play / App Store).
// Персональные данные обезличиваются (телефон и имя стираются), аккаунт помечается
// deleted_at и блокируется, уведомления и SMS-коды удаляются. Записи аренд и платежей
// остаются в обезличенном виде — они нужны для бухгалтерии и споров по платежам.
// Нельзя удалить аккаунт с незакрытыми арендами (инструмент на руках / неоплаченный заказ).
router.delete('/me', auth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('id, phone, deleted_at')
      .eq('id', req.userId)
      .single();

    if (!user || user.deleted_at) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const { count: openRentals } = await supabase
      .from('rentals')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.userId)
      .in('status', ['active', 'overdue', 'pending_payment']);

    if (openRentals && openRentals > 0) {
      return res.status(409).json({
        error: 'Сначала верните инструмент и закройте активные аренды, затем удалите аккаунт'
      });
    }

    const now = new Date().toISOString();
    const { error } = await supabase
      .from('users')
      .update({
        phone: `deleted:${user.id}`,
        name: 'Удалённый пользователь',
        is_blocked: true,
        deleted_at: now,
      })
      .eq('id', req.userId);
    if (error) throw error;

    await supabase.from('notifications').delete().eq('user_id', req.userId);
    await supabase.from('sms_codes').delete().eq('phone', user.phone);

    res.json({ success: true, message: 'Аккаунт удалён' });
  } catch (err) {
    console.error('delete me error:', err);
    res.status(500).json({ error: 'Ошибка удаления аккаунта' });
  }
});

module.exports = router;
