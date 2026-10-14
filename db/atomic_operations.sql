-- Атомарные операции Taketool: деньги, склад, ячейки, коды входа, колесо.
--
-- Всё, что здесь лежит, уже применено к рабочей базе. Файл — не «черновик на
-- будущее», а единственное место, где эту логику можно прочитать: она живёт в
-- Postgres, и по коду на Node.js её не видно. Любая правка этих функций меняет
-- поведение прода немедленно, без деплоя.
--
-- Общее правило: если операция меняет деньги или число вещей на складе, её
-- условие обязано проверять сама база одной операцией. Прочитать, подумать и
-- записать — значит разрешить двум одновременным запросам сделать это дважды.

-- ─────────────────────────────────────────────────────────────────────────────
-- Ячейки
-- ─────────────────────────────────────────────────────────────────────────────

-- Занять ячейку может только тот, кто застал её свободной.
create or replace function public.cell_claim(cell uuid) returns boolean
language plpgsql as $$
declare ok int;
begin
  update cells set status = 'occupied' where id = cell and status = 'free';
  get diagnostics ok = row_count;
  return ok > 0;
end;
$$;

-- Метка времени на ячейке. Нужна ночной сверке: «занята» и «занята только что
-- оплаченным заказом» — одно и то же значение статуса, и сверка освобождала
-- ячейку под оплаченным заказом. Метка делает эти случаи различимыми.
alter table cells add column if not exists updated_at timestamptz not null default now();

-- Кто поставил ячейку на приёмку. Без этого приёмку возврата можно подтвердить
-- номером ЛЮБОГО старого заказа на тот же инструмент, не подходя к боксу.
alter table cells add column if not exists pending_rental_id uuid references rentals(id) on delete set null;

create or replace function public.cells_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cells_touch_trg on cells;
create trigger cells_touch_trg before update on cells
  for each row execute function public.cells_touch();

-- ─────────────────────────────────────────────────────────────────────────────
-- Склад
-- ─────────────────────────────────────────────────────────────────────────────

-- Списать единицу можно только если она есть. Условие в WHERE, а не в if выше.
create or replace function public.stock_take(tool uuid) returns boolean
language plpgsql as $$
declare ok int;
begin
  update tools set sale_stock = sale_stock - 1 where id = tool and sale_stock > 0;
  get diagnostics ok = row_count;
  return ok > 0;
end;
$$;

create or replace function public.stock_return(tool uuid) returns void
language sql as $$
  update tools set sale_stock = coalesce(sale_stock, 0) + 1 where id = tool;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Кошелёк
-- ─────────────────────────────────────────────────────────────────────────────

-- Списание бонуса. Начисления берём по сроку сгорания — сперва то, что сгорит
-- раньше. Остаток по каждому начислению считается как само начисление плюс все
-- его списания (parent_id), поэтому дважды одно и то же не потратится.
create or replace function public.wallet_spend(uid uuid, rid uuid, want integer) returns integer
language plpgsql as $$
declare
  c record;
  left_on_credit int;
  rest int := want;
  take int;
begin
  if want is null or want <= 0 then return 0; end if;

  for c in
    select w.id, w.amount, w.expires_at
      from wallet_entries w
     where w.user_id = uid
       and w.amount > 0
       and w.parent_id is null
       and (w.expires_at is null or w.expires_at > now())
     order by w.expires_at asc nulls last
     for update
  loop
    exit when rest <= 0;
    select c.amount + coalesce(sum(d.amount), 0) into left_on_credit
      from wallet_entries d where d.parent_id = c.id;
    if left_on_credit <= 0 then continue; end if;

    take := least(left_on_credit, rest);
    insert into wallet_entries (user_id, amount, kind, parent_id, rental_id, note)
    values (uid, -take, 'rent_spend', c.id, rid, 'Списано на заказ');
    rest := rest - take;
  end loop;

  return want - rest;
end;
$$;

-- Возврат бонуса при отмене заказа: возвращаем ровно недостачу по каждому
-- начислению, не больше. Раньше возврат считался от суммы заказа и при двух
-- циклах «заказал — отменил» баланс рос из воздуха.
create or replace function public.wallet_refund_rental(uid uuid, rid uuid) returns integer
language plpgsql as $$
declare
  r record;
  total int := 0;
begin
  for r in
    select w.parent_id as credit_id, sum(w.amount) as net
      from wallet_entries w
     where w.user_id = uid and w.rental_id = rid
       and w.kind in ('rent_spend', 'refund')
       and w.parent_id is not null
     group by w.parent_id
  loop
    if r.net < 0 then
      perform 1 from wallet_entries where id = r.credit_id for update;
      insert into wallet_entries (user_id, amount, kind, parent_id, rental_id, note)
      values (uid, -r.net, 'refund', r.credit_id, rid, 'Возврат при отмене заказа');
      total := total + (-r.net);
    end if;
  end loop;

  return total;
end;
$$;

-- Один возврат на одно начисление и один заказ. Функция считает остаток
-- курсором, а блокировку берёт уже в теле цикла: два одновременных возврата по
-- одному заказу увидели бы одну недостачу и оба её возместили. Сейчас этот путь
-- прикрыт проверкой статуса в отмене заказа, но запрет на уровне базы не
-- зависит от того, не уберёт ли её кто-нибудь однажды.
create unique index if not exists wallet_refund_once
  on wallet_entries (parent_id, rental_id) where kind = 'refund';

-- ─────────────────────────────────────────────────────────────────────────────
-- Колесо Фортуны
-- ─────────────────────────────────────────────────────────────────────────────

-- Прокрутка одной транзакцией: проверка попыток, проверка числа победителей,
-- начисление и запись прокрутки. Раньше это были три отдельных запроса, и два
-- одновременных нажатия давали два приза за одну попытку.
create or replace function public.wheel_spin_record(
  uids uuid[], dev text, max_spins int, winners_limit int,
  p_code text, p_label text, p_amount int, p_kind text, days_valid int
) returns table(spin_id uuid, entry_id uuid, reason text)
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := case when coalesce(array_length(uids, 1), 0) > 0 then uids[1] else null end;
  has_chain boolean := coalesce(array_length(uids, 1), 0) > 0;
  used_count int;
  winners int;
  we_id uuid := null;
  s_id uuid;
begin
  -- Акция одна, победителей ровно столько, сколько обещано. Общая блокировка
  -- выстраивает прокрутки в очередь: их за всю акцию тысяча, очередь не узкая.
  perform pg_advisory_xact_lock(hashtext('taketool:wheel'));

  select count(*) into used_count from wheel_spins ws
   where coalesce(ws.status, '') <> 'cancelled'
     and ( (has_chain and ws.user_id = any(uids))
        or (dev is not null and ws.device_id = dev) );
  if used_count >= max_spins then
    return query select null::uuid, null::uuid, 'no_spins'::text;
    return;
  end if;

  if winners_limit > 0 then
    select count(*) into winners from wheel_spins ws
     where ws.user_id is not null and coalesce(ws.status, '') <> 'cancelled';
    if winners >= winners_limit then
      return query select null::uuid, null::uuid, 'all_won'::text;
      return;
    end if;
  end if;

  if uid is not null and p_kind = 'bonus' and p_amount > 0 then
    insert into wallet_entries (user_id, amount, kind, expires_at, note)
    values (uid, p_amount, 'wheel_win', now() + make_interval(days => days_valid),
            'Колесо Фортуны: ' || p_label)
    returning id into we_id;
  end if;

  insert into wheel_spins (user_id, device_id, prize_code, prize_label, amount, kind,
                           wallet_entry_id, claimed_at)
  values (uid, dev, p_code, p_label, p_amount, p_kind, we_id,
          case when uid is not null then now() else null end)
  returning id into s_id;

  return query select s_id, we_id, null::text;
end;
$$;

-- Забрать гостевой выигрыш после регистрации. Прокрутку привязывает и начисляет
-- одной транзакцией; claimed_at не даёт забрать её дважды.
create or replace function public.wheel_claim_spin(uid uuid, spin uuid, days_valid integer)
returns table(claimed integer, amount integer)
language plpgsql as $$
declare
  rec record;
  entry_id uuid;
begin
  update wheel_spins s
     set user_id = uid, claimed_at = now()
   where s.id = spin and s.user_id is null and s.claimed_at is null
     and s.status <> 'cancelled'
  returning s.id, s.prize_label, s.amount, s.kind into rec;

  if rec.id is null then
    return query select 0, 0;      -- уже забрано кем-то другим
    return;
  end if;

  if rec.kind = 'bonus' and rec.amount > 0 then
    insert into wallet_entries (user_id, amount, kind, expires_at, note)
    values (uid, rec.amount, 'wheel_win', now() + (days_valid || ' days')::interval,
            'Колесо Фортуны: ' || rec.prize_label)
    returning id into entry_id;

    update wheel_spins set wallet_entry_id = entry_id where id = rec.id;
    return query select 1, rec.amount;
  else
    return query select 1, 0;      -- приз-инструмент: денег не начисляем
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Коды входа
-- ─────────────────────────────────────────────────────────────────────────────

-- Проверка кода со счётчиком попыток. Код четырёхзначный, 9000 вариантов, живёт
-- пять минут — без счётчика его перебирают и входят в чужой аккаунт. Ограничение
-- на отправку SMS от этого не защищает: оно ограничивает выдачу кода, а не
-- число попыток его угадать.
create or replace function public.sms_verify_code(p_phone text, p_code text, max_attempts integer default 5)
returns table(ok boolean, reason text)
language plpgsql as $$
declare
  rec record;
begin
  select * into rec from sms_codes where phone = p_phone for update;

  if rec.phone is null then
    return query select false, 'no_code'; return;
  end if;
  if rec.expires_at is not null and now() > rec.expires_at then
    delete from sms_codes where phone = p_phone;
    return query select false, 'expired'; return;
  end if;
  if rec.attempts >= max_attempts then
    delete from sms_codes where phone = p_phone;   -- код сжигаем, нужен новый
    return query select false, 'too_many'; return;
  end if;
  if rec.code <> p_code then
    update sms_codes set attempts = attempts + 1 where phone = p_phone;
    return query select false, 'wrong'; return;
  end if;

  delete from sms_codes where phone = p_phone;
  return query select true, 'ok';
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Права
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Эти функции зовёт только сервер. Postgres по умолчанию отдаёт EXECUTE всем, и
-- PostgREST выставлял их наружу как /rest/v1/rpc/<имя>: записи не проходили лишь
-- потому, что на таблицах включён RLS без политик. Одна добавленная политика
-- «читать всем» — и накрутка склада или бонуса становится вызовом из браузера.
do $$
declare f text;
begin
  foreach f in array array[
    'cell_claim(uuid)',
    'stock_take(uuid)',
    'stock_return(uuid)',
    'wheel_claim_spin(uuid, uuid, integer)',
    'wheel_spin_record(uuid[], text, integer, integer, text, text, integer, text, integer)',
    'wallet_spend(uuid, uuid, integer)',
    'wallet_refund_rental(uuid, uuid)',
    'sms_verify_code(text, text, integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
