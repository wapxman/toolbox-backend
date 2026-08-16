const express = require('express');
const supabase = require('../lib/supabase');
const kerong = require('../lib/kerong');
const clickMapi = require('../lib/click_mapi');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// Ценовые правила редактируются в админке (app_settings, key='pricing');
// при недоступности таблицы работаем на прежних дефолтах. Кэш 60 сек.
const DEFAULT_PRICING = { discount3_pct: 20, discount7_pct: 35, overdue_multiplier: 1.5 };
let pricingCache = { value: DEFAULT_PRICING, ts: 0 };
async function getPricing() {
  if (Date.now() - pricingCache.ts < 60_000) return pricingCache.value;
  try {
    const { data } = await supabase
      .from('app_settings').select('value').eq('key', 'pricing').maybeSingle();
    pricingCache = { value: { ...DEFAULT_PRICING, ...(data?.value || {}) }, ts: Date.now() };
  } catch {
    pricingCache.ts = Date.now();
  }
  return pricingCache.value;
}

function calculatePrice(dayPrice, days, pricing = DEFAULT_PRICING) {
  if (days >= 7) return Math.round(days * dayPrice * (1 - pricing.discount7_pct / 100));
  if (days >= 3) return Math.round(days * dayPrice * (1 - pricing.discount3_pct / 100));
  return days * dayPrice;
}

// POST /api/rentals — создать аренду + открыть замок
router.post('/', async (req, res) => {
  try {
    const { tool_id, days, provider } = req.body;

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

    const totalPrice = calculatePrice(tool.day_price, days, await getPricing());
    const startedAt = new Date();
    const expectedEnd = new Date(startedAt);
    expectedEnd.setDate(expectedEnd.getDate() + days);

    // Аренда создаётся в статусе pending_payment.
    // Замок откроется в Payme PerformTransaction — после реальной оплаты.
    const { data: rental, error: rentalErr } = await supabase
      .from('rentals')
      .insert({
        user_id: req.userId,
        tool_id: tool_id,
        days: days,
        started_at: startedAt.toISOString(),
        expected_end: expectedEnd.toISOString(),
        status: 'pending_payment',
        total_price: totalPrice,
        payment_provider: provider === 'click' ? 'click' : 'payme'
      })
      .select()
      .single();

    if (rentalErr) throw rentalErr;

    // Ячейку НЕ резервируем до оплаты: иначе брошенная (неоплаченная) аренда
    // держала бы инструмент «Занят» навсегда. Ячейка помечается occupied только
    // после реального подтверждения оплаты — в Payme PerformTransaction.

    if (provider === 'click') {
      // Метод 3 (Create Invoice): счёт с суммой прилетает пушем в приложение
      // Click Up на номер пользователя (как Payme). Подтверждение оплаты придёт
      // к нам через SHOP API Prepare/Complete. Телефон берём из профиля (вариант Б).
      const { data: usr } = await supabase
        .from('users').select('phone').eq('id', req.userId).single();
      const inv = await clickMapi.createInvoice({
        phone: usr?.phone,
        amount: totalPrice,
        merchantTransId: rental.id,
      });
      if (inv && Number(inv.error_code) === 0 && inv.invoice_id) {
        return res.json({
          rental,
          tool_name: tool.name,
          total_price: totalPrice,
          provider: 'click',
          click_invoice: true,
          invoice_id: inv.invoice_id,
          // Ссылку отдаём, чтобы приложение сразу открыло Click (как Payme).
          // Счёт с суммой уже в Click Up; ссылка нужна лишь для перехода в приложение.
          payment_url: buildClickUrl(rental.id, totalPrice),
          message: 'Счёт отправлен в приложение Click. Откройте Click и подтвердите оплату.',
        });
      }
      // Фолбэк: инвойс не создался (напр. номер не в Click) — отдаём платёжную ссылку.
      console.error('click invoice failed:', inv);
      return res.json({
        rental,
        tool_name: tool.name,
        total_price: totalPrice,
        provider: 'click',
        click_invoice: false,
        payment_url: buildClickUrl(rental.id, totalPrice),
        message: 'Счёт не удалось отправить в Click — откроем страницу оплаты.',
      });
    }

    res.json({
      rental,
      tool_name: tool.name,
      total_price: totalPrice,
      provider: 'payme',
      payment_url: buildPaymeUrl(rental.id, totalPrice),
      message: 'Аренда создана. Оплатите, чтобы открыть замок.'
    });
  } catch (err) {
    console.error('create rental error:', err);
    res.status(500).json({ error: 'Ошибка создания аренды' });
  }
});

// Ссылка на оплату Payme: base64(m=MERCHANT_ID;ac.rental_id=ID;a=СУММА_В_ТИЙИНАХ)
function buildPaymeUrl(rentalId, priceSum) {
  const merchantId = process.env.PAYME_MERCHANT_ID;
  if (!merchantId) return null;
  const base = process.env.PAYME_CHECKOUT_URL || 'https://checkout.paycom.uz';
  const payload = `m=${merchantId};ac.rental_id=${rentalId};a=${priceSum * 100}`;
  return `${base}/${Buffer.from(payload).toString('base64')}`;
}

// Ссылка на оплату Click: my.click.uz/services/pay (сумма в СУМАХ, transaction_param = rental_id).
// merchant_trans_id, который Click вернёт в Prepare/Complete — это наш rental_id.
function buildClickUrl(rentalId, priceSum) {
  const serviceId = process.env.CLICK_SERVICE_ID;
  const merchantId = process.env.CLICK_MERCHANT_ID;
  if (!serviceId || !merchantId) return null;
  const params = new URLSearchParams({
    service_id: serviceId,
    merchant_id: merchantId,
    amount: String(priceSum),
    transaction_param: rentalId,
  });
  if (process.env.CLICK_RETURN_URL) params.set('return_url', process.env.CLICK_RETURN_URL);
  return `https://my.click.uz/services/pay?${params.toString()}`;
}

// GET /api/rentals/:id/payment-status — поллинг оплаты из приложения
router.get('/:id/payment-status', async (req, res) => {
  try {
    const { data: rental, error } = await supabase
      .from('rentals')
      .select('id, status, total_price, payment_provider')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (error || !rental) {
      return res.status(404).json({ error: 'Аренда не найдена' });
    }

    res.json({
      rental_id: rental.id,
      status: rental.status,
      provider: rental.payment_provider || 'payme',
      paid: rental.status === 'active',
      payment_url: rental.status === 'pending_payment'
        ? (rental.payment_provider === 'click'
            ? buildClickUrl(rental.id, rental.total_price)
            : buildPaymeUrl(rental.id, rental.total_price))
        : null
    });
  } catch (err) {
    console.error('payment-status error:', err);
    res.status(500).json({ error: 'Ошибка проверки оплаты' });
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
    // Продлевать можно только оплаченную аренду — иначе pending_payment/cancelled
    // «оживали» бы в active без оплаты.
    if (!['active', 'overdue'].includes(rental.status)) {
      return res.status(400).json({ error: 'Аренда не активна — продление невозможно' });
    }

    const newDays = rental.days + extra_days;
    const extraPrice = calculatePrice(rental.tools.day_price, extra_days, await getPricing());
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
      .select('*, tools(cell_id, name, cells(cell_number, kerong_lock_number, boxes(kerong_zone_id)))')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (rErr || !rental) {
      return res.status(404).json({ error: 'Аренда не найдена' });
    }

    if (rental.status === 'completed') {
      return res.status(400).json({ error: 'Уже возвращён' });
    }
    // Замок открывается только по оплаченной (активной/просроченной) аренде —
    // pending_payment/cancelled сюда не проходят, иначе инструмент выдаётся бесплатно.
    if (!['active', 'overdue'].includes(rental.status)) {
      return res.status(400).json({ error: 'Аренда не активна — возврат невозможен' });
    }

    // Открываем замок для возврата через Kerong. Если замок недоступен
    // (бокс офлайн / туннель упал) — НЕ завершаем аренду: пользователь у бокса
    // ничего не смог положить. Отдаём понятную ошибку 503, а не общий 500.
    const cell = rental.tools.cells;
    const zoneId = cell.boxes.kerong_zone_id || 1;
    const lockNumber = cell.kerong_lock_number ?? (cell.cell_number - 1);
    try {
      await kerong.openLock(zoneId, lockNumber);
    } catch (lockErr) {
      console.error('return: lock open failed', lockErr.message);
      return res.status(503).json({
        error: 'Не удалось открыть замок ячейки. Попробуйте ещё раз через минуту. ' +
               'Если не помогает — обратитесь в поддержку, аренда останется активной.',
        lock_failed: true,
      });
    }

    const now = new Date();
    const expectedEnd = new Date(rental.expected_end);
    let overdueFee = 0;

    if (now > expectedEnd) {
      const { overdue_multiplier } = await getPricing();
      const overdueDays = Math.ceil((now - expectedEnd) / (1000 * 60 * 60 * 24));
      overdueFee = Math.round(overdueDays * (rental.total_price / rental.days) * overdue_multiplier);
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
        : `${rental.tools.name} — спасибо за использование Taketool!`
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
