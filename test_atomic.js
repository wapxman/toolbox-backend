// Проверка атомарности: ячейка, прокрутка колеса и склад не должны
// выдаваться дважды при одновременных запросах.
// Запуск:  SUPABASE_SECRET=<сервисный ключ> node test_atomic.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://zwzmcihwtwgjajjjsbms.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_SECRET || process.env.SUPABASE_KEY || '';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
if (!process.env.SUPABASE_KEY) {
  console.error('Нужен сервисный ключ: SUPABASE_SECRET=<ключ> node test_atomic.js');
  process.exit(2);
}
const sb=require('./src/lib/supabase'); const o=require('./src/lib/orders');
(async()=>{
  let bad=0;
  // ячейка
  const {data:c}=await sb.from('cells').select('id,cell_number,status').eq('status','free').limit(1).single();
  const r=await Promise.all([1,2,3,4,5].map(()=>o.claimCell(c.id)));
  const got=r.filter(Boolean).length;
  console.log((got===1?'✅':'❌')+` ячейка ${c.cell_number}: из 5 одновременных захватов успешных ${got}`);
  if(got!==1) bad++;
  await sb.from('cells').update({status:'free'}).eq('id',c.id);
  // прокрутка
  const {data:u}=await sb.from('users').select('id').eq('phone','+998900000007').single();
  await sb.from('wallet_entries').delete().eq('user_id',u.id).eq('kind','wheel_win');
  await sb.from('wheel_spins').delete().eq('user_id',u.id);
  const call=i=>sb.rpc('wheel_spin_record',{uids:[u.id],dev:'atomic-check',max_spins:1,winners_limit:1000,
    p_code:'b50',p_label:'Проверка '+i,p_amount:50000,p_kind:'bonus',days_valid:30});
  const res=await Promise.all([1,2,3,4,5].map(call));
  const wins=res.map(x=>(Array.isArray(x.data)?x.data[0]:x.data)).filter(x=>x&&x.spin_id).length;
  const {data:ents}=await sb.from('wallet_entries').select('amount').eq('user_id',u.id).eq('kind','wheel_win');
  const sum=(ents||[]).reduce((a,e)=>a+e.amount,0);
  const okSpin = wins===1 && sum===50000;
  console.log((okSpin?'✅':'❌')+` колесо: из 5 одновременных прокруток призов ${wins}, начислено ${sum}`);
  if(!okSpin) bad++;
  await sb.from('wallet_entries').delete().eq('user_id',u.id).eq('kind','wheel_win');
  await sb.from('wheel_spins').delete().eq('user_id',u.id);
  // склад
  const {data:t}=await sb.from('tools').select('id,sale_stock').gt('sale_stock',0).limit(1).single();
  const takes=await Promise.all(Array(Number(t.sale_stock)+3).fill(0).map(()=>o.takeStock(t.id)));
  const okTakes=takes.filter(Boolean).length;
  console.log((okTakes===t.sale_stock?'✅':'❌')+` склад: остаток был ${t.sale_stock}, выдано ${okTakes} из ${takes.length} попыток`);
  if(okTakes!==t.sale_stock) bad++;
  await sb.from('tools').update({sale_stock:t.sale_stock}).eq('id',t.id);
  console.log(bad?`\n❌ сбоев: ${bad}`:'\n✅ ВСЕ ТРИ ОПЕРАЦИИ АТОМАРНЫ');
  process.exit(bad?1:0);
})();
