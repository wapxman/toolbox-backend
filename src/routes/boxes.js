const express = require('express');
const supabase = require('../lib/supabase');

const router = express.Router();

// Расчёт расстояния между двумя точками (формула Haversine, в км)
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// GET /api/boxes
// Список всех боксов. Если переданы lat/lng — с расстоянием и сортировкой
router.get('/', async (req, res) => {
  try {
    const { lat, lng } = req.query;

    const { data: boxes, error } = await supabase
      .from('boxes')
      .select('*')
      .eq('status', 'online');

    if (error) throw error;

    const result = await Promise.all(boxes.map(async (box) => {
      const { count } = await supabase
        .from('cells')
        .select('*', { count: 'exact', head: true })
        .eq('box_id', box.id)
        .eq('status', 'free');

      const item = {
        ...box,
        free_cells: count || 0
      };

      // Добавляем расстояние если есть координаты
      if (lat && lng) {
        item.distance_km = Math.round(distanceKm(
          parseFloat(lat), parseFloat(lng), box.lat, box.lng
        ) * 10) / 10;
      }

      return item;
    }));

    // Сортируем по расстоянию если есть координаты
    if (lat && lng) {
      result.sort((a, b) => a.distance_km - b.distance_km);
    }

    res.json(result);
  } catch (err) {
    console.error('boxes error:', err);
    res.status(500).json({ error: 'Ошибка загрузки боксов' });
  }
});

// GET /api/boxes/:id
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
// Инструменты в боксе. ?category=Дрели для фильтрации
router.get('/:id/tools', async (req, res) => {
  try {
    const { category } = req.query;

    let query = supabase
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

    if (category) {
      query = query.eq('category', category);
    }

    const { data: tools, error } = await query;

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
