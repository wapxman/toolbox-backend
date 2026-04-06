const express = require('express');
const supabase = require('../lib/supabase');

const router = express.Router();

// GET /api/tools/search?q=дрель
// Поиск инструментов по названию
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Минимум 2 символа для поиска' });
    }

    const { data: tools, error } = await supabase
      .from('tools')
      .select(`
        *,
        cells!inner (
          cell_number,
          status,
          box_id,
          boxes!inner (
            name,
            address,
            lat,
            lng
          )
        )
      `)
      .or(`name.ilike.%${q}%,category.ilike.%${q}%,brand.ilike.%${q}%`);

    if (error) throw error;

    const result = tools.map(tool => ({
      id: tool.id,
      name: tool.name,
      category: tool.category,
      brand: tool.brand,
      photo_url: tool.photo_url,
      day_price: tool.day_price,
      cell_number: tool.cells.cell_number,
      cell_status: tool.cells.status,
      box_name: tool.cells.boxes.name,
      box_address: tool.cells.boxes.address
    }));

    res.json(result);
  } catch (err) {
    console.error('search error:', err);
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

// GET /api/tools/:id
// Детали инструмента
router.get('/:id', async (req, res) => {
  try {
    const { data: tool, error } = await supabase
      .from('tools')
      .select(`
        *,
        cells (
          cell_number,
          status,
          boxes (
            id,
            name,
            address
          )
        )
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !tool) {
      return res.status(404).json({ error: 'Инструмент не найден' });
    }

    res.json({
      ...tool,
      cell_number: tool.cells.cell_number,
      cell_status: tool.cells.status,
      box: tool.cells.boxes,
      cells: undefined
    });
  } catch (err) {
    console.error('tool detail error:', err);
    res.status(500).json({ error: 'Ошибка загрузки инструмента' });
  }
});

module.exports = router;
