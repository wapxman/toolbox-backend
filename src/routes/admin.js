// Админские переходы статусов заказов. Закрыто X-Admin-Secret (как /api/locks).
// Админка вызывает через свой серверный прокси /api/orders/[id].
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

// PATCH /api/admin/orders/:id
// { action: open_cell | packed | dispatched | delivered | ready | picked_up | restocked | refunded | cancel,
//   courier_name?, courier_phone?, cell_id? (для ready) }
router.patch('/orders/:id', async (req, res) => {
  try {
    const rental = await orders.loadRental(req.params.id);
    if (!rental) return res.status(404).json({ error: 'Заказ не найден' });
    const { action, courier_name, courier_phone, cell_id } = req.body || {};
    const now = new Date().toISOString();
    const upd = (fields) => supabase.from('rentals').update(fields).eq('id', rental.id);
    const name = rental.tools?.name || 'инструмент';
    const inDelivery = rental.status === 'pending_delivery';

    switch (action) {
      case 'open_cell': {
        const cell = orders.cellOf(rental);
        if (!cell) return res.status(400).json({ error: 'У заказа нет ячейки' });
        await orders.openLock(cell);
        return res.json({ ok: true, cell_number: cell.cell_number });
      }

      // Аренда с доставкой: экземпляр забрали из бокса. Покупка с доставкой: единицу взяли со склада.
      case 'packed': {
        if (!inDelivery || rental.kind === 'courier_return') return res.status(400).json({ error: 'Заказ не в доставке' });
        if (rental.fulfillment !== 'delivery') return res.status(400).json({ error: 'Для самовывоза используйте «Готов к выдаче»' });
        await upd({ delivery_status: 'packed', packed_at: now });
        await orders.notifyUser(rental.user_id, rental.id, 'info', 'Заказ собран',
          `${name} готов к отправке. Курьер выедет к вам: ${rental.delivery_slot_label || 'в выбранное время'}.`);
        return res.json({ ok: true });
      }

      // Покупка с самовывозом: новая единица положена в ячейку бокса
      case 'ready': {
        if (!inDelivery || rental.kind !== 'buy' || rental.fulfillment !== 'pickup') {
          return res.status(400).json({ error: 'Только для покупки с самовывозом' });
        }
        if (!cell_id) return res.status(400).json({ error: 'Укажите ячейку, куда положили инструмент' });
        const { data: cell } = await supabase.from('cells').select('id, cell_number, status, boxes(name)').eq('id', cell_id).single();
        if (!cell) return res.status(400).json({ error: 'Ячейка не найдена' });
        if (cell.status !== 'free') return res.status(400).json({ error: `Ячейка ${cell.cell_number} занята` });
        await supabase.from('cells').update({ status: 'occupied' }).eq('id', cell.id);
        await upd({ delivery_status: 'ready', pickup_cell_id: cell.id, packed_at: now });
        await orders.notifyUser(rental.user_id, rental.id, 'info', 'Покупка готова к выдаче',
          `${name} лежит в боксе «${cell.boxes?.name || ''}», ячейка ${cell.cell_number}. Откройте заказ в приложении и нажмите «Открыть ячейку», когда будете у бокса.`);
        return res.json({ ok: true });
      }

      case 'dispatched': {
        if (!inDelivery) return res.status(400).json({ error: 'Заказ не в доставке' });
        if (rental.fulfillment !== 'delivery') return res.status(400).json({ error: 'Самовывоз курьером не везём' });
        if (rental.kind !== 'courier_return' && rental.delivery_status !== 'packed') {
          return res.status(400).json({ error: 'Сначала отметьте «Собран»' });
        }
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
        if (!inDelivery || rental.kind === 'courier_return') return res.status(400).json({ error: 'Заказ не в доставке' });
        if (rental.delivery_status !== 'dispatched') return res.status(400).json({ error: 'Сначала «Передан курьеру»' });
        if (rental.kind === 'buy') {
          await upd({ delivery_status: 'delivered', delivered_at: now, status: 'completed', actual_end: now });
          await orders.notifyUser(rental.user_id, rental.id, 'info', 'Покупка доставлена', `${name} передан вам. Спасибо за покупку!`);
        } else {
          const end = new Date(); end.setDate(end.getDate() + (rental.days || 1));
          await upd({ delivery_status: 'delivered', delivered_at: now, status: 'active', started_at: now, expected_end: end.toISOString() });
          await orders.notifyUser(rental.user_id, rental.id, 'info', 'Инструмент доставлен',
            `${name} у вас. Срок аренды ${rental.days} дн. — вернуть до ${end.toLocaleDateString('ru-RU')}.`);
        }
        return res.json({ ok: true });
      }

      // Курьер забрал арендованный инструмент у клиента
      case 'picked_up': {
        if (rental.kind !== 'courier_return') return res.status(400).json({ error: 'Это не возврат курьером' });
        if (!inDelivery || rental.delivery_status !== 'dispatched') return res.status(400).json({ error: 'Сначала «Передан курьеру»' });
        await upd({ delivery_status: 'picked_up', delivered_at: now, status: 'completed', actual_end: now });
        const parent = rental.parent_rental_id ? await orders.loadRental(rental.parent_rental_id) : null;
        let overdueFee = 0;
        if (parent && ['active', 'overdue'].includes(parent.status)) {
          overdueFee = await orders.overdueFeeFor(parent);
          // Ячейка остаётся occupied: экземпляр у курьера, а не в боксе. Освободит «Инструмент в боксе».
          await supabase.from('rentals').update({
            status: 'completed', actual_end: now, overdue_fee: overdueFee, return_method: 'courier', restock_pending: true,
          }).eq('id', parent.id);
        }
        await orders.notifyUser(rental.user_id, rental.parent_rental_id || rental.id, 'info',
          overdueFee > 0 ? 'Возвращён со штрафом' : 'Инструмент возвращён',
          overdueFee > 0 ? `${name} принят курьером. Штраф за просрочку ${orders.fmt(overdueFee)} сум.` : `${name} принят курьером. Спасибо за использование Taketool!`);
        return res.json({ ok: true, overdue_fee: overdueFee });
      }

      // Сотрудник вернул экземпляр в ячейку (после возврата курьером / отмены после сборки)
      // или убрал новую единицу из ячейки обратно на склад (отмена покупки после «готов к выдаче»)
      case 'restocked': {
        if (!rental.restock_pending) return res.status(400).json({ error: 'Возврат в бокс не требуется' });
        if (rental.kind === 'buy') {
          if (rental.pickup_cell_id) await supabase.from('cells').update({ status: 'free' }).eq('id', rental.pickup_cell_id);
          await orders.returnStock(rental.tool_id);
        } else if (rental.tools?.cell_id) {
          await supabase.from('cells').update({ status: 'free' }).eq('id', rental.tools.cell_id);
        }
        await upd({ restock_pending: false });
        return res.json({ ok: true });
      }

      case 'refunded': {
        if (rental.refund_status !== 'pending') return res.status(400).json({ error: 'Возврат денег не ожидается' });
        await upd({ refund_status: 'done' });
        await orders.notifyUser(rental.user_id, rental.id, 'payment', 'Деньги возвращены',
          `Возврат ${orders.fmt(rental.total_price)} сум по заказу №${rental.order_number} выполнен.`);
        return res.json({ ok: true });
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
