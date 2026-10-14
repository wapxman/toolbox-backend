// Прицельная проверка продления: просрочка не стирается, ставка штрафа не падает,
// счёт не оплачивается после возврата. Работает с служебным юзером автотеста.
//
// Запуск:  SUPABASE_SECRET=<сервисный ключ> node test_extension.js
// Ключ берём только из окружения: в файле ему не место — он обходит RLS.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://zwzmcihwtwgjajjjsbms.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_SECRET || process.env.SUPABASE_KEY || '';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
if (!process.env.SUPABASE_KEY) {
  console.error('Нужен сервисный ключ: SUPABASE_SECRET=<ключ> node test_extension.js');
  process.exit(2);
}
const supabase = require('./src/lib/supabase');
const orders = require('./src/lib/orders');

const D = 86400000;
const iso = (ms) => new Date(ms).toISOString();
let fails = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log(`${ok ? '✅' : '❌'} ${name}: ${got}${ok ? '' : `  (ожидалось ${want})`}`);
};

(async () => {
  const { data: u } = await supabase.from('users').select('id').eq('phone', '+998900000007').single();
  const { data: tool } = await supabase.from('tools').select('id').limit(1).single();
  const made = [];
  const mk = async (f) => {
    const { data, error } = await supabase.from('rentals').insert({
      user_id: u.id, tool_id: tool.id, fulfillment: 'pickup', payment_provider: 'payme',
      discount: 0, delivery_fee: 0, ...f,
    }).select('*').single();
    if (error) throw new Error(error.message);
    made.push(data.id);
    return data;
  };

  // ── А. Оплата продления по ПРОСРОЧЕННОЙ аренде ──────────────────────────────
  console.log('\n━━ А. Продление просроченной аренды ━━');
  const now = Date.now();
  const rent = await mk({
    kind: 'rent', status: 'active', days: 2, items_price: 100000, total_price: 100000,
    started_at: iso(now - 7 * D), expected_end: iso(now - 5 * D), paid_at: iso(now - 7 * D),
  });
  const feeBefore = await orders.overdueFeeFor(rent);
  console.log(`   до продления: 2 дн. за 100 000 (50 000/дн.), просрочка 5 дн. → штраф ${feeBefore}`);

  const bill = await mk({
    kind: 'extension', status: 'pending_payment', parent_rental_id: rent.id, days: 2,
    items_price: 100000, total_price: 100000, bonus_applied: 0,
    started_at: iso(now), expected_end: iso(now),
  });
  await orders.confirmPayment(bill.id, { method: 'payme', paymentId: 'test-ext-' + now, amountSum: 100000 });

  const { data: p } = await supabase.from('rentals')
    .select('days, items_price, total_price, expected_end, status').eq('id', rent.id).single();
  const overdueDaysLeft = Math.ceil((now - new Date(p.expected_end).getTime()) / D);
  check('срок сдвинут от СТАРОГО срока, а не от сегодня', overdueDaysLeft, 3);
  check('просрочка не стёрта статусом', p.status, 'overdue');
  check('дней стало', p.days, 4);
  check('цена выросла вместе с днями', p.items_price, 200000);
  check('ставка за день сохранилась', p.items_price / p.days, 50000);
  // Штраф считается по полным суткам вверх: 3 дня «с хвостиком» = 4 суток.
  const daysBilled = Math.ceil((Date.now() - new Date(p.expected_end).getTime()) / D);
  const feeAfter = await orders.overdueFeeFor({ ...p, discount: 0 });
  check(`штраф за остаток просрочки (${daysBilled} сут. × 50 000 × 1,5)`, feeAfter, daysBilled * 50000 * 1.5);
  // ⚠️ Это и есть закрытая дыра: раньше дни росли, а цена нет, и ставка падала
  // до 25 000/дн. — каждый следующий день просрочки стоил вдвое дешевле.
  check('штраф НЕ ополовинен разбавленной ставкой', feeAfter > daysBilled * 25000 * 1.5, 'true');

  // ── Б. Счёт гасится при возврате ────────────────────────────────────────────
  console.log('\n━━ Б. Возврат гасит неоплаченный счёт на продление ━━');
  const rent2 = await mk({
    kind: 'rent', status: 'active', days: 2, items_price: 100000, total_price: 100000,
    started_at: iso(now - D), expected_end: iso(now + D), paid_at: iso(now - D),
  });
  const bill2 = await mk({
    kind: 'extension', status: 'pending_payment', parent_rental_id: rent2.id, days: 2,
    items_price: 100000, total_price: 100000, bonus_applied: 0,
    started_at: iso(now), expected_end: iso(now),
  });
  // Вместе со счётом на продление возврат обязан гасить и неоплаченный вызов
  // курьера: ехать уже не за чем.
  const courier2 = await mk({
    kind: 'courier_return', status: 'pending_payment', parent_rental_id: rent2.id, days: 0,
    items_price: 50000, total_price: 50000, bonus_applied: 0,
    started_at: iso(now), expected_end: iso(now),
  });
  const closed = await orders.cancelChildBills(rent2.id);
  const { data: b2 } = await supabase.from('rentals').select('status').eq('id', bill2.id).single();
  const { data: c2 } = await supabase.from('rentals').select('status').eq('id', courier2.id).single();
  check('счетов снято', closed, 2);
  check('счёт на продление отменён', b2.status, 'cancelled');
  check('вызов курьера отменён', c2.status, 'cancelled');

  // ── В. Оплата продления по ЗАКРЫТОЙ аренде ──────────────────────────────────
  console.log('\n━━ В. Оплата продления после возврата ━━');
  const rent3 = await mk({
    kind: 'rent', status: 'completed', days: 2, items_price: 100000, total_price: 100000,
    started_at: iso(now - 3 * D), expected_end: iso(now - D), actual_end: iso(now - D), paid_at: iso(now - 3 * D),
  });
  const bill3 = await mk({
    kind: 'extension', status: 'pending_payment', parent_rental_id: rent3.id, days: 2,
    items_price: 100000, total_price: 100000, bonus_applied: 0,
    started_at: iso(now), expected_end: iso(now),
  });
  await orders.confirmPayment(bill3.id, { method: 'payme', paymentId: 'test-ext3-' + now, amountSum: 100000 });
  const { data: p3 } = await supabase.from('rentals').select('days, expected_end, status').eq('id', rent3.id).single();
  const { data: b3 } = await supabase.from('rentals').select('status, refund_status').eq('id', bill3.id).single();
  check('сданная аренда не продлилась (дни)', p3.days, 2);
  check('сданная аренда не ожила (статус)', p3.status, 'completed');
  check('срок по сданной аренде не уехал', p3.expected_end, rent3.expected_end);
  check('счёт отменён', b3.status, 'cancelled');
  check('деньги помечены к возврату', b3.refund_status, 'pending');

  // ── Г. Оплата вызова курьера после возврата ────────────────────────────────
  console.log('\n━━ Г. Оплата вызова курьера после возврата ━━');
  const rent4 = await mk({
    kind: 'rent', status: 'completed', days: 2, items_price: 100000, total_price: 100000,
    started_at: iso(now - 3 * D), expected_end: iso(now - D), actual_end: iso(now - D), paid_at: iso(now - 3 * D),
  });
  const call4 = await mk({
    kind: 'courier_return', status: 'pending_payment', parent_rental_id: rent4.id, days: 0,
    items_price: 50000, total_price: 50000, bonus_applied: 0,
    started_at: iso(now), expected_end: iso(now),
  });
  await orders.confirmPayment(call4.id, { method: 'payme', paymentId: 'test-cr-' + now, amountSum: 50000 });
  const { data: p4 } = await supabase.from('rentals').select('status, return_method').eq('id', rent4.id).single();
  const { data: c4 } = await supabase.from('rentals').select('status, refund_status').eq('id', call4.id).single();
  check('курьер не объявлен по сданной аренде', p4.return_method || 'нет', 'нет');
  check('сданная аренда не ожила', p4.status, 'completed');
  check('счёт на курьера отменён', c4.status, 'cancelled');
  check('деньги за курьера к возврату', c4.refund_status, 'pending');

  // ── уборка ──────────────────────────────────────────────────────────────────
  // Снимаем ссылки в обратном порядке: сперва всё, что ссылается на заказы,
  // потом сами дочерние счёта, и только затем родительские аренды.
  for (const id of made) {
    await supabase.from('transactions').delete().eq('rental_id', id);
    await supabase.from('notifications').delete().eq('rental_id', id);
  }
  for (const id of made) {
    const { data: kids } = await supabase.from('rentals').select('id').eq('parent_rental_id', id);
    for (const k of kids || []) {
      await supabase.from('transactions').delete().eq('rental_id', k.id);
      await supabase.from('notifications').delete().eq('rental_id', k.id);
      const { error } = await supabase.from('rentals').delete().eq('id', k.id);
      if (error) console.log('   уборка: дочерний счёт остался —', error.message);
    }
  }
  for (const id of made) {
    const { error } = await supabase.from('rentals').delete().eq('id', id);
    if (error) console.log('   уборка не смогла удалить заказ:', error.message);
  }
  const { data: left } = await supabase.from('rentals').select('id').in('id', made);
  console.log(`\nуборка: осталось тестовых заказов — ${(left || []).length}`);
  console.log(fails === 0 ? '\n🎉 ВСЕ ПРОВЕРКИ ПРОДЛЕНИЯ ПРОЙДЕНЫ' : `\n❌ ПРОВАЛОВ: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('СБОЙ ТЕСТА:', e.message); process.exit(1); });
