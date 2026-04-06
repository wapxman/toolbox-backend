const express = require('express');
const supabase = require('../lib/supabase');

const router = express.Router();

// GET /api/boxes
// Список всех боксов (с количеством свободных ячеек)
router.get('/', async (req, res) => {
  try {
    const { data: boxes, error } = await supabase
      .from('boxes')
      .select('*')
      .eq('status', 'online');

    if (error) throw error;

    // Для каждого бокса считаем свободные ячейки
    const result = await Promise.all(boxes.map(async (box) => {
      const { count } = await supabase
        .from('cells')
        .select('*', { count: 'exact', head: true })
        .eq('box_id', box.id)
        .eq('status', 'free');

      return {
        ...box,
        free_cells: count || 0
      };
    }));

    res.json(result);
  } catch (err) {
    console.error('boxes error:', err);
    res.status(500).json({ error: 'Ошибка загрузки боксов' });
  }
});

// GET /api/boxes/:id
// Детали бокса
router.get('/:id', async (req, res) => {
  try {
    const { data: box, error } = await supabase
      .from('boxes')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !box) {
      return res.status(404).json({ error: 'Бокс не найден' });
    }

    res.json(box);
  } catch (err) {
    console.error('box detail error:', err);
    res.status(500).json({ error: 'Ошибка загрузки бокса' });
  }
});

// GET /api/boxes/:id/tools
// Инструменты в боксе
router.get('/:id/tools', async (req, res) => {
  try {
    const { data: tools, error } = await supabase
      .from('tools')
      .select(`
        *,
        cells!inner (
          cell_number,
          status,
          box_id
        )
      `)
      .eq('cells.box_id', req.params.id);

    if (error) throw error;

    const result = tools.map(tool => ({
      id: tool.id,
      name: tool.name,
      category: tool.category,
      brand: tool.brand,
      description: tool.description,
      specs: tool.specs,
      photo_url: tool.photo_url,
      day_price: tool.day_price,
      condition: tool.condition,
      cell_number: tool.cells.cell_number,
      status: tool.cells.status
    }));

    res.json(result);
  } catch (err) {
    console.error('box tools error:', err);
    res.status(500).json({ error: 'Ошибка загрузки инструментов' });
  }
});

module.exports = router;
