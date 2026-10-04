const express = require('express');
const supabase = require('../lib/supabase');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// POST /api/notifications/device — приложение отдаёт свой FCM-токен.
// Зовётся после входа и при каждом обновлении токена Firebase.
// { token, platform: android|ios, app_version? }
router.post('/device', async (req, res) => {
  try {
    const { token, platform, app_version } = req.body || {};
    if (!token || typeof token !== 'string' || token.length < 20) {
      return res.status(400).json({ error: 'Нужен токен устройства' });
    }
    if (!['android', 'ios'].includes(platform)) {
      return res.status(400).json({ error: 'platform должен быть android или ios' });
    }
    // Upsert по token: тот же телефон после переустановки или передачи другому
    // человеку переедет на нового владельца, а не продублируется.
    const { error } = await supabase.from('device_tokens').upsert({
      user_id: req.userId,
      token,
      platform,
      app_version: app_version || null,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'token' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('register device error:', err);
    res.status(500).json({ error: 'Не удалось зарегистрировать устройство' });
  }
});

// DELETE /api/notifications/device — при выходе из аккаунта, чтобы уведомления
// прошлого владельца не прилетели следующему на том же телефоне.
router.delete('/device', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Нужен токен устройства' });
    // Привязка к user_id обязательна: иначе любой залогиненный мог бы отписать
    // чужое устройство, зная его токен.
    const { error } = await supabase.from('device_tokens')
      .delete().eq('token', token).eq('user_id', req.userId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('unregister device error:', err);
    res.status(500).json({ error: 'Не удалось снять устройство' });
  }
});

// GET /api/notifications
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.userId)
      .order('sent_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('notifications error:', err);
    res.status(500).json({ error: 'Ошибка загрузки уведомлений' });
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.userId)
      .eq('read', false);

    if (error) throw error;
    res.json({ count: count || 0 });
  } catch (err) {
    console.error('unread count error:', err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('mark read error:', err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// PATCH /api/notifications/read-all
router.patch('/read-all', async (req, res) => {
  try {
    await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', req.userId)
      .eq('read', false);

    res.json({ success: true });
  } catch (err) {
    console.error('read all error:', err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

module.exports = router;
