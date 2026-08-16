// Cron-задачи (вызывает Vercel Cron по расписанию из vercel.json).
// Vercel шлёт заголовок Authorization: Bearer <CRON_SECRET> — чужих не пускаем.
// Если CRON_SECRET не задан в env, роут выключен (fail closed).

const express = require('express');
const supabase = require('../lib/supabase');

const router = express.Router();

function cronOnly(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

router.use(cronOnly);

// GET /api/cron/overdue — раз в день: просроченные active → overdue + уведомление.
// Штраф здесь НЕ начисляется (его считает возврат) — только статус и напоминание.
router.get('/overdue', async (req, res) => {
  try {
    const { data: expired, error } = await supabase
      .from('rentals')
      .select('id, user_id, days, total_price, expected_end, tools(name)')
      .eq('status', 'active')
      .lt('expected_end', new Date().toISOString());
    if (error) throw error;

    let marked = 0;
    for (const r of expired || []) {
      const { error: uErr } = await supabase
        .from('rentals')
        .update({ status: 'overdue' })
        .eq('id', r.id)
        .eq('status', 'active'); // защита от гонки с параллельным возвратом
      if (uErr) continue;
      marked++;

      const daysOver = Math.max(1, Math.ceil(
        (Date.now() - new Date(r.expected_end).getTime()) / 86_400_000));
      const feeNow = Math.round(daysOver * (r.total_price / (r.days || 1)) * 1.5);
      await supabase.from('notifications').insert({
        user_id: r.user_id,
        rental_id: r.id,
        type: 'overdue',
        title: 'Аренда просрочена',
        message: `${r.tools?.name || 'Инструмент'} — просрочка ${daysOver} дн. ` +
          `Текущий штраф ~${feeNow.toLocaleString('ru-RU')} сум и растёт каждый день. ` +
          `Пожалуйста, верните инструмент.`,
      });
    }

    console.log(`[CRON overdue] помечено: ${marked}`);
    res.json({ ok: true, marked });
  } catch (err) {
    console.error('cron overdue error:', err);
    res.status(500).json({ error: 'cron failed' });
  }
});

module.exports = router;
