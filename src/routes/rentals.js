const express = require('express');
const supabase = require('../lib/supabase');
const auth = require('../middleware/auth');

const router = express.Router();

// Все rental-эндпоинты требуют авторизации
router.use(auth);

// Расчёт цены с учётом скидок
function calculatePrice(dayPrice, days) {
  if (days >= 7) return Math.round(days * dayPrice * 0.65); // скидка 35%
  if (days >= 3) return Math.round(days * dayPrice * 0.80); // скидка 20%
  return days * dayPrice;
}

// POST /api/rentals
// Создать аренду
router.post('/', async (req, res) => {
  try {
    const { tool_id, days } = req.body;

    if (!tool_id || !days || days < 1 || days > 30) {
      return res.status(400).json({ error: 'Укажите инструмент и количество дней (1-30)' });
    }

    // Получаем инструмент
    const { data: tool, error: toolErr } = await supabase
      .from('tools')
      .select('*, cells(*)')
      .eq('id', tool_id)
      .single();

    if (toolErr || !tool) {
      return res.status(404).json({ error: 'Инструмент не найден' });
    }

    if (tool.cells.status !== 'free') {
      return res.status(400).json({ error: 'Инструмент уже занят' });
    }

    // Рассчитываем цену
    const totalPrice = calculatePrice(tool.day_price, days);

    // Рассчитываем дату окончания
    const startedAt = new Date();
    const expectedEnd = new Date(startedAt);
    expectedEnd.setDate(expectedEnd.getDate() + days);

    // Создаём аренду
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

    // Обновляем статус ячейки
    await supabase
      .from('cells')
      .update({ status: 'occupied' })
      .eq('id', tool.cell_id);

    res.json({
      rental,
      tool_name: tool.name,
      total_price: totalPrice,
      message: 'Аренда создана. Оплатите для получения инструмента.'
    });
  } catch (err) {
    console.error('create rental error:', err);
    res.status(500).json({ error: 'Ошибка создания аренды' });
  }
});

// GET /api/rentals/active
// Активные аренды пользователя
router.get('/active', async (req, res) => {
  try {
    const { data: rentals, error } = await supabase
      .from('rentals')
      .select(`
        *,
        tools (
          name, category, brand, photo_url, day_price,
          cells (
            cell_number,
            boxes ( name, address )
          )
        )
      `)
      .eq('user_id', req.userId)
      .in('status', ['active', 'overdue'])
      .order('started_at', { ascending: false });

    if (error) throw error;
    res.json(rentals);
  } catch (err) {
    console.error('active rentals error:', err);
    res.status(500).json({ error: 'Ошибка загрузки аренд' });
  }
});

// GET /api/rentals/history
// История аренд
router.get('/history', async (req, res) => {
  try {
    const { data: rentals, error } = await supabase
      .from('rentals')
      .select(`
        *,
        tools (
          name, category, brand, photo_url, day_price
        )
      `)
      .eq('user_id', req.userId)
      .eq('status', 'completed')
      .order('started_at', { ascending: false });

    if (error) throw error;
    res.json(rentals);
  } catch (err) {
    console.error('rental history error:', err);
    res.status(500).json({ error: 'Ошибка загрузки истории' });
  }
});

// POST /api/rentals/:id/extend
// Продлить аренду
router.post('/:id/extend', async (req, res) => {
  try {
    const { extra_days } = req.body;

    if (!extra_days || extra_days < 1) {
      return res.status(400).json({ error: 'Укажите количество дополнительных дней' });
    }

    const { data: rental, error: rErr } = await supabase
      .from('rentals')
      .select('*, tools(day_price)')
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

    res.json({
      rental: updated,
      extra_price: extraPrice,
      message: `Аренда продлена на ${extra_days} дн.`
    });
  } catch (err) {
    console.error('extend error:', err);
    res.status(500).json({ error: 'Ошибка продления' });
  }
});

// POST /api/rentals/:id/return
// Вернуть инструмент
router.post('/:id/return', async (req, res) => {
  try {
    const { data: rental, error: rErr } = await supabase
      .from('rentals')
      .select('*, tools(cell_id, name)')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (rErr || !rental) {
      return res.status(404).json({ error: 'Аренда не найдена' });
    }

    if (rental.status === 'completed') {
      return res.status(400).json({ error: 'Уже возвращён' });
    }

    // Проверяем просрочку
    const now = new Date();
    const expectedEnd = new Date(rental.expected_end);
    let overdueFee = 0;

    if (now > expectedEnd) {
      const overdueDays = Math.ceil((now - expectedEnd) / (1000 * 60 * 60 * 24));
      overdueFee = Math.round(overdueDays * (rental.total_price / rental.days) * 1.5);
    }

    // Завершаем аренду
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

    // Освобождаем ячейку
    await supabase
      .from('cells')
      .update({ status: 'free' })
      .eq('id', rental.tools.cell_id);

    res.json({
      rental: updated,
      overdue_fee: overdueFee,
      tool_name: rental.tools.name,
      message: overdueFee > 0
        ? `Возвращён со штрафом ${overdueFee} сум за просрочку`
        : 'Инструмент возвращён. Спасибо!'
    });
  } catch (err) {
    console.error('return error:', err);
    res.status(500).json({ error: 'Ошибка возврата' });
  }
});

module.exports = router;
