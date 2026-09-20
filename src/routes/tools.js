const express = require('express');
const supabase = require('../lib/supabase');

const router = express.Router();

// Даты «занят до» по активным/ожидающим заказам для набора инструментов
async function busyUntilMap(toolIds) {
  if (!toolIds.length) return {};
  const { data } = await supabase
    .from('rentals')
    .select('tool_id, expected_end, status')
    .in('tool_id', toolIds)
    .eq('kind', 'rent') // покупки — новые единицы со склада, арендный экземпляр не занимают
    .in('status', ['active', 'overdue', 'pending_delivery']);
  const map = {};
  for (const r of data || []) {
    if (!map[r.tool_id] || new Date(r.expected_end) > new Date(map[r.tool_id])) map[r.tool_id] = r.expected_end;
  }
  return map;
}

function publicTool(tool, busy) {
  const cell = tool.cells || {};
  const box = cell.boxes || {};
  return {
    id: tool.id,
    name: tool.name,
    category: tool.category,
    brand: tool.brand,
    description: tool.description,
    specs: tool.specs,
    photo_url: tool.photo_url,
    day_price: tool.day_price,
    sale_price: tool.sale_price,
    sale_stock: Number(tool.sale_stock || 0),
    sale_condition: tool.sale_condition,
    sale_kit: tool.sale_kit,
    sale_warranty: tool.sale_warranty,
    condition: tool.condition,
    cell_number: cell.cell_number,
    cell_status: cell.status,
    box_id: box.id || cell.box_id,
    box_name: box.name,
    box_address: box.address,
    busy_until: busy[tool.id] || null,
  };
}

// GET /api/tools?q=&category=&mode=rent|buy — каталог магазина (все боксы)
router.get('/', async (req, res) => {
  try {
    const { q, category, mode } = req.query;
    let query = supabase
      .from('tools')
      .select('*, cells!inner(cell_number, status, box_id, boxes!inner(id, name, address))')
      .eq('status', 'available')
      .order('name');
    if (category) query = query.eq('category', String(category));
    if (mode === 'buy') query = query.not('sale_price', 'is', null).gt('sale_price', 0).gt('sale_stock', 0);
    if (q && String(q).trim().length >= 2) {
      const safeQ = String(q).replace(/[,()]/g, ' ').trim();
      query = query.or(`name.ilike.%${safeQ}%,category.ilike.%${safeQ}%,brand.ilike.%${safeQ}%`);
    }
    const { data: tools, error } = await query;
    if (error) throw error;
    const busy = await busyUntilMap((tools || []).map(t => t.id));
    res.json((tools || []).map(t => publicTool(t, busy)));
  } catch (err) {
    console.error('catalog error:', err);
    res.status(500).json({ error: 'Ошибка загрузки каталога' });
  }
});

// GET /api/tools/categories — список категорий для чипсов
router.get('/categories', async (req, res) => {
  try {
    const { data, error } = await supabase.from('tools').select('category').eq('status', 'available');
    if (error) throw error;
    const set = new Set((data || []).map(t => t.category).filter(Boolean));
    res.json([...set].sort());
  } catch (err) {
    res.status(500).json({ error: 'Ошибка категорий' });
  }
});

// GET /api/tools/search?q=дрель — поиск (старый контракт приложения 1.0.x)
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Минимум 2 символа для поиска' });
    }
    const safeQ = q.replace(/[,()]/g, ' ').trim();
    if (safeQ.length < 2) {
      return res.status(400).json({ error: 'Минимум 2 символа для поиска' });
    }
    const { data: tools, error } = await supabase
      .from('tools')
      .select('*, cells!inner(cell_number, status, box_id, boxes!inner(id, name, address, lat, lng))')
      .eq('status', 'available')
      .or(`name.ilike.%${safeQ}%,category.ilike.%${safeQ}%,brand.ilike.%${safeQ}%`);
    if (error) throw error;
    const busy = await busyUntilMap((tools || []).map(t => t.id));
    res.json((tools || []).map(t => publicTool(t, busy)));
  } catch (err) {
    console.error('search error:', err);
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

// GET /api/tools/:id — детали инструмента
router.get('/:id', async (req, res) => {
  try {
    const { data: tool, error } = await supabase
      .from('tools')
      .select('*, cells(cell_number, status, box_id, boxes(id, name, address))')
      .eq('id', req.params.id)
      .single();

    if (error || !tool) {
      return res.status(404).json({ error: 'Инструмент не найден' });
    }
    const busy = await busyUntilMap([tool.id]);
    res.json({
      ...publicTool(tool, busy),
      status: tool.status,
      box: tool.cells?.boxes || null,
    });
  } catch (err) {
    console.error('tool detail error:', err);
    res.status(500).json({ error: 'Ошибка загрузки инструмента' });
  }
});

module.exports = router;
