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

    // 3) Сверка ячеек с заказами. Ячейка обязана быть occupied только если по ней есть
    //    живой заказ: аренда экземпляра (active/overdue/pending_delivery), покупка в ячейке
    //    выдачи (ready) или инструмент вне бокса (restock_pending). Иначе — free.
    //    Это страховка от ручных правок в базе и старых записей: без неё «застрявшая» ячейка
    //    запирает инструмент для всех клиентов.
    const fixedCells = await reconcileCells();

    const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { data: stale } = await supabase
      .from('rentals')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('status', 'pending_payment')
      .neq('kind', 'penalty') // счёт за штраф живёт до оплаты
      .lt('created_at', dayAgo)
      .select('id');

    console.log(`[CRON overdue] помечено: ${marked}, брошенных отменено: ${(stale || []).length}, ячеек исправлено: ${fixedCells.length}`);
    res.json({ ok: true, marked, stale_cancelled: (stale || []).length, cells_fixed: fixedCells });
  } catch (err) {
    console.error('cron overdue error:', err);
    res.status(500).json({ error: 'cron failed' });
  }
});

// Ячейки, которые должны быть заняты, по живым заказам; всё остальное освобождаем,
// а занятые по факту, но помеченные free — занимаем. Возвращает список исправлений.
async function reconcileCells() {
  const { data: cells } = await supabase.from('cells').select('id, cell_number, status, tools(id)');
  const { data: live } = await supabase
    .from('rentals')
    .select('kind, status, delivery_status, restock_pending, tool_id, pickup_cell_id, tools(cell_id)')
    .or('status.in.(active,overdue,pending_delivery),restock_pending.eq.true');
  const mustBeOccupied = new Set();
  for (const r of live || []) {
    if (r.restock_pending) {
      if (r.kind === 'buy' && r.pickup_cell_id) mustBeOccupied.add(r.pickup_cell_id);
      else if (r.tools?.cell_id) mustBeOccupied.add(r.tools.cell_id);
      continue;
    }
    if (r.kind === 'rent' && r.tools?.cell_id) mustBeOccupied.add(r.tools.cell_id);           // экземпляр у клиента / ждёт курьера
    if (r.kind === 'buy' && r.delivery_status === 'ready' && r.pickup_cell_id) mustBeOccupied.add(r.pickup_cell_id);
  }
  const fixed = [];
  for (const c of cells || []) {
    if (c.status === 'maintenance') continue;
    const want = mustBeOccupied.has(c.id) ? 'occupied' : 'free';
    if (c.status !== want) {
      const { error } = await supabase.from('cells').update({ status: want }).eq('id', c.id).eq('status', c.status);
      if (!error) fixed.push({ cell: c.cell_number, from: c.status, to: want });
    }
  }
  return fixed;
}

// GET /api/cron/reconcile — только сверка ячеек (можно дёрнуть руками с CRON_SECRET)
router.get('/reconcile', async (req, res) => {
  try {
    res.json({ ok: true, cells_fixed: await reconcileCells() });
  } catch (err) {
    console.error('cron reconcile error:', err);
    res.status(500).json({ error: 'reconcile failed' });
  }
});

module.exports = router;
