const express = require('express');
const supabase = require('../lib/supabase');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

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
