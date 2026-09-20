// Cron-задачи (вызывает Vercel Cron по расписанию из vercel.json).
// Vercel шлёт заголовок Authorization: Bearer <CRON_SECRET> — чужих не пускаем.
// Если CRON_SECRET не задан в env, роут выключен (fail closed).

const express = require('express');
const supabase = require('../lib/supabase');
const orders = require('../lib/orders');

const router = express.Router();

function cronOnly(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

router.use(cronOnly);

// GET /api/cron/overdue — раз в день:
//  1) просроченные active-аренды → overdue + уведомление (штраф считает возврат);
//  2) брошенные неоплаченные заказы старше 24 ч → cancelled, чтобы не копились.
router.get('/overdue', async (req, res) => {
  try {
    const { data: expired, error } = await supabase
      .from('rentals')
      .select('id, user_id, days, total_price, items_price, discount, expected_end, tools(name)')
      .eq('status', 'active')
      .eq('kind', 'rent')
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
      const daysOver = Math.max(1, Math.ceil((Date.now() - new Date(r.expected_end).getTime()) / 86_400_000));
      const feeNow = await orders.overdueFeeFor(r);
      await supabase.from('notifications').insert({
        user_id: r.user_id, rental_id: r.id, type: 'overdue', title: 'Аренда просрочена',
        message: `${r.tools?.name || 'Инструмент'} — просрочка ${daysOver} дн. ` +
          `Текущий штраф ~${feeNow.toLocaleString('ru-RU')} сум и растёт каждый день. Пожалуйста, верните инструмент.`,
      });
    }

    const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { data: stale } = await supabase
      .from('rentals')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('status', 'pending_payment')
      .lt('created_at', dayAgo)
      .select('id');

    console.log(`[CRON overdue] помечено: ${marked}, брошенных отменено: ${(stale || []).length}`);
    res.json({ ok: true, marked, stale_cancelled: (stale || []).length });
  } catch (err) {
    console.error('cron overdue error:', err);
    res.status(500).json({ error: 'cron failed' });
  }
});

module.exports = router;
