const express = require('express');
const supabase = require('../lib/supabase');
const kerong = require('../lib/kerong');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

function calculatePrice(dayPrice, days) {
  if (days >= 7) return Math.round(days * dayPrice * 0.65);
  if (days >= 3) return Math.round(days * dayPrice * 0.80);
  return days * dayPrice;
}

// POST /api/rentals — создать аренду + открыть замок
router.post('/', async (req, res) => {
  try {
    const { tool_id, days } = req.body;

    if (!tool_id || !days || days < 1 || days > 30) {
      return res.status(400).json({ error: 'Укажите инструмент и количество дней (1-30)' });
    }

    const { count: activeCount } = await supabase
      .from('rentals')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.userId)
      .in('status', ['active', 'overdue']);

    if (activeCount >= 3) {
      return res.status(400).json({ error: 'Максимум 3 активных аренды одновременно' });
    }

    const { data: tool, error: toolErr } = await supabase
      .from('tools')
      .select('*, cells(*, boxes(*))')
      .eq('id', tool_id)
      .single();

    if (toolErr || !tool) {
      return res.status(404).json({ error: 'Инструмент не найден' });
    }

    if (tool.cells.status !== 'free') {
      return res.status(400).json({ error: 'Инструмент уже занят' });
    }

    const totalPrice = calculatePrice(tool.day_price, days);
    const startedAt = new Date();
    const expectedEnd = new Date(startedAt);
    expectedEnd.setDate(expectedEnd.getDate() + days);

    // Открываем замок через Kerong
    const zoneId = tool.cells.boxes.kerong_zone_id || 1;
    const lockNumber = tool.cells.cell_number;
    await kerong.openLock(zoneId, lockNumber);

    const { data: rental, error: rentalErr } = await supabase
      .from('rentals')
      .insert({
        user_id: req.userId,
        tool_id: tool_id,
        days: days,
        started_at: startedAt.toISOString(),
        expected_end: expectedEnd.toISOString(),
        status: 'active',
        total_price: totalPrice
      })
      .select()
      .single();

    if (rentalErr) throw rentalErr;

    await supabase
      .from('cells')
      .update({ status: 'occupied' })
      .eq('id', tool.cell_id);

    await supabase.from('notifications').insert({
      user_id: req.userId,
      rental_id: rental.id,
      type: 'payment',
      title: 'Аренда создана',
      message: `${tool.name} — ${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}, ${totalPrice.toLocaleString('ru-RU')} сум`
    });

    res.json({
      rental,
      tool_name: tool.name,
      total_price: totalPrice,
      lock_opened: true,
      message: 'Замок открыт! Заберите инструмент.'
    });
  } catch (err) {
    console.error('create rental error:', err);
    res.status(500).json({ error: 'Ошибка создания аренды' });
  }
});

// GET /api/rentals/active
router.get('/active', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rentals')
      .select(`
        *,
        tools (
          name, category, brand, photo_url, day_price,
          cells ( cell_number, boxes ( name, address ) )
        )
      `)
      .eq('user_id', req.userId)
      .in('status', ['active', 'overdue'])
      .order('started_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('active rentals error:', err);
    res.status(500).json({ error: 'Ошибка загрузки аренд' });
  }
});

// GET /api/rentals/history
router.get('/history', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rentals')
      .select(`*, tools ( name, category, brand, photo_url, day_price )`)
      .eq('user_id', req.userId)
      .eq('status', 'completed')
      .order('started_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('rental history error:', err);
    res.status(500).json({ error: 'Ошибка загрузки истории' });
  }
});

// GET /api/rentals/:id
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rentals')
      .select(`
        *,
        tools (
          name, category, brand, photo_url, day_price, specs,
          cells ( cell_number, qr_code, boxes ( id, name, address ) )
        )
      `)
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Аренда не найдена' });
    }

    res.json(data);
  } catch (err) {
    console.error('rental detail error:', err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// POST /api/rentals/:id/extend
router.post('/:id/extend', async (req, res) => {
  try {
    const { extra_days } = req.body;

    if (!extra_days || extra_days < 1) {
      return res.status(400).json({ error: 'Укажите количество дополнительных дней' });
    }

    const { data: rental, error: rErr } = await supabase
      .from('rentals')
      .select('*, tools(day_price, name)')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (rErr || !rental) {
      return res.status(404).json({ error: 'Аренда не найдена' });
    }

    if (rental.status === 'completed') {
      return res.status(400).json({ error: 'Аренда уже завершена' });
    }

    const newDays = rental.days + extra_days;
    const extraPrice = calculatePrice(rental.tools.day_price, extra_days);
    const newEnd = new Date(rental.expected_end);
    newEnd.setDate(newEnd.getDate() + extra_days);

    const { data: updated, error: uErr } = await supabase
      .from('rentals')
      .update({
        days: newDays,
        expected_end: newEnd.toISOString(),
        total_price: rental.total_price + extraPrice,
        status: 'active'
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (uErr) throw uErr;

    await supabase.from('notifications').insert({
      user_id: req.userId,
      rental_id: rental.id,
      type: 'payment',
      title: 'Аренда продлена',
      message: `${rental.tools.name} — +${extra_days} дн., доплата ${extraPrice.toLocaleString('ru-RU')} сум`
    });

    res.json({ rental: updated, extra_price: extraPrice, message: `Аренда продлена на ${extra_days} дн.` });
  } catch (err) {
    console.error('extend error:', err);
    res.status(500).json({ error: 'Ошибка продления' });
  }
});

// POST /api/rentals/:id/return — вернуть инструмент + открыть замок
router.post('/:id/return', async (req, res) => {
  try {
    const { data: rental, error: rErr } = await supabase
      .from('rentals')
      .select('*, tools(cell_id, name, cells(cell_number, boxes(kerong_zone_id)))')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (rErr || !rental) {
      return res.status(404).json({ error: 'Аренда не найдена' });
    }

    if (rental.status === 'completed') {
      return res.status(400).json({ error: 'Уже возвращён' });
    }

    // Открываем замок для возврата через Kerong
    const zoneId = rental.tools.cells.boxes.kerong_zone_id || 1;
    const lockNumber = rental.tools.cells.cell_number;
    await kerong.openLock(zoneId, lockNumber);

    const now = new Date();
    const expectedEnd = new Date(rental.expected_end);
    let overdueFee = 0;

    if (now > expectedEnd) {
      const overdueDays = Math.ceil((now - expectedEnd) / (1000 * 60 * 60 * 24));
      overdueFee = Math.round(overdueDays * (rental.total_price / rental.days) * 1.5);
    }

    const { data: updated, error: uErr } = await supabase
      .from('rentals')
      .update({
        actual_end: now.toISOString(),
        status: 'completed',
        overdue_fee: overdueFee
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (uErr) throw uErr;

    await supabase
      .from('cells')
      .update({ status: 'free' })
      .eq('id', rental.tools.cell_id);

    await supabase.from('notifications').insert({
      user_id: req.userId,
      rental_id: rental.id,
      type: 'info',
      title: overdueFee > 0 ? 'Возвращён со штрафом' : 'Инструмент возвращён',
      message: overdueFee > 0
        ? `${rental.tools.name} — штраф ${overdueFee.toLocaleString('ru-RU')} сум`
        : `${rental.tools.name} — спасибо за использование ToolBox!`
    });

    res.json({
      rental: updated,
      overdue_fee: overdueFee,
      lock_opened: true,
      message: overdueFee > 0
        ? `Замок открыт. Штраф ${overdueFee} сум за просрочку`
        : 'Замок открыт. Верните инструмент в ячейку. Спасибо!'
    });
  } catch (err) {
    console.error('return error:', err);
    res.status(500).json({ error: 'Ошибка возврата' });
  }
});

module.exports = router;
