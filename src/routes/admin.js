// Админские переходы статусов заказов с доставкой. Закрыто X-Admin-Secret
// (как /api/locks). Админка вызывает через свой серверный прокси /api/orders.
const express = require('express');
const supabase = require('../lib/supabase');
const orders = require('../lib/orders');

const router = express.Router();

function adminOnly(req, res, next) {
  const secret = process.env.ADMIN_API_SECRET;
  if (!secret || req.headers['x-admin-secret'] !== secret) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}
router.use(adminOnly);

// PATCH /api/admin/orders/:id  { action: packed|dispatched|delivered|picked_up|cancel|open_cell,
//                               courier_name?, courier_phone? }
router.patch('/orders/:id', async (req, res) => {
  try {
    const rental = await orders.loadRental(req.params.id);
    if (!rental) return res.status(404).json({ error: 'Заказ не найден' });
    const { action, courier_name, courier_phone } = req.body || {};
    const now = new Date().toISOString();
    const upd = (fields) => supabase.from('rentals').update(fields).eq('id', rental.id);
    const name = rental.tools?.name || 'инструмент';

    switch (action) {
      case 'open_cell': {
        await orders.openCellFor(rental);
        return res.json({ ok: true });
      }
      case 'packed': {
        if (rental.status !== 'pending_delivery') return res.status(400).json({ error: 'Заказ не в доставке' });
        await upd({ delivery_status: 'packed', packed_at: now });
        await orders.notifyUser(rental.user_id, rental.id, 'info', 'Заказ собран',
          `${name} готов к отправке. Курьер выедет к вам: ${rental.delivery_slot_label || 'в выбранное время'}.`);
        return res.json({ ok: true });
      }
      case 'dispatched': {
        if (rental.status !== 'pending_delivery') return res.status(400).json({ error: 'Заказ не в доставке' });
        await upd({
          delivery_status: 'dispatched', dispatched_at: now,
          courier_name: courier_name || rental.courier_name || null,
          courier_phone: courier_phone || rental.courier_phone || null,
        });
        const who = courier_name ? `Курьер ${courier_name}${courier_phone ? ', ' + courier_phone : ''}` : 'Курьер';
        await orders.notifyUser(rental.user_id, rental.id, 'info',
          rental.kind === 'courier_return' ? 'Курьер едет за инструментом' : 'Курьер в пути',
          `${who} ${rental.kind === 'courier_return' ? 'скоро заберёт' : 'везёт'} ${name}. ${rental.delivery_slot_label || ''}`.trim());
        return res.json({ ok: true });
      }
      case 'delivered': {
        if (rental.status !== 'pending_delivery') return res.status(400).json({ error: 'Заказ не в доставке' });
        if (rental.kind === 'buy') {
          await upd({ delivery_status: 'delivered', delivered_at: now, status: 'completed', actual_end: now });
          await supabase.from('tools').update({ status: 'sold' }).eq('id', rental.tool_id);
          if (rental.tools?.cell_id) await supabase.from('cells').update({ status: 'free' }).eq('id', rental.tools.cell_id);
          await orders.notifyUser(rental.user_id, rental.id, 'info', 'Покупка доставлена',
            `${name} передан вам. Спасибо за покупку!`);
        } else {
          const end = new Date(); end.setDate(end.getDate() + (rental.days || 1));
          await upd({
            delivery_status: 'delivered', delivered_at: now, status: 'active',
            started_at: now, expected_end: end.toISOString(),
          });
          await orders.notifyUser(rental.user_id, rental.id, 'info', 'Инструмент доставлен',
            `${name} у вас. Срок аренды ${rental.days} дн. — вернуть до ${end.toLocaleDateString('ru-RU')}.`);
        }
        return res.json({ ok: true });
      }
      case 'picked_up': {
        // Курьер забрал инструмент у клиента (kind = courier_return)
        if (rental.kind !== 'courier_return') return res.status(400).json({ error: 'Это не возврат курьером' });
        if (rental.status !== 'pending_delivery') return res.status(400).json({ error: 'Возврат не в работе' });
        await upd({ delivery_status: 'picked_up', delivered_at: now, status: 'completed', actual_end: now });
        const parent = rental.parent_rental_id ? await orders.loadRental(rental.parent_rental_id) : null;
        let overdueFee = 0;
        if (parent && ['active', 'overdue'].includes(parent.status)) {
          const expectedEnd = new Date(parent.expected_end);
          if (Date.now() > expectedEnd.getTime()) {
            const { overdue_multiplier } = await orders.getPricing();
            const overdueDays = Math.ceil((Date.now() - expectedEnd.getTime()) / 86_400_000);
            overdueFee = Math.round(overdueDays * (parent.total_price / (parent.days || 1)) * overdue_multiplier);
          }
          await supabase.from('rentals').update({ status: 'completed', actual_end: now, overdue_fee: overdueFee }).eq('id', parent.id);
          if (parent.tools?.cell_id) await supabase.from('cells').update({ status: 'free' }).eq('id', parent.tools.cell_id);
        }
        await orders.notifyUser(rental.user_id, rental.parent_rental_id || rental.id, 'info',
          overdueFee > 0 ? 'Возвращён со штрафом' : 'Инструмент возвращён',
          overdueFee > 0 ? `${name} принят курьером. Штраф за просрочку ${orders.fmt(overdueFee)} сум.` : `${name} принят курьером. Спасибо за использование Taketool!`);
        return res.json({ ok: true, overdue_fee: overdueFee });
      }
      case 'cancel': {
        const r = await orders.cancelOrder(rental, 'admin');
        if (r.error) return res.status(400).json({ error: r.error });
        return res.json(r);
      }
      default:
        return res.status(400).json({ error: 'Неизвестное действие' });
    }
  } catch (err) {
    console.error('admin order error:', err);
    res.status(500).json({ error: err.message || 'Ошибка' });
  }
});

module.exports = router;
