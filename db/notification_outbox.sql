-- Транзакционный outbox уведомлений (Taketool 1.2).
--
-- Зачем. Раньше уведомление операторам уходило прямо из обработчика оплаты вызовом
-- fetch() БЕЗ await. На Vercel это терялось: функция отвечает кассе и засыпает, не
-- дождавшись ответа api.telegram.org. Заказ оплачен — в группе тишина, и узнать об
-- этом было негде.
--
-- Теперь уведомление сперва пишется сюда (дешёвый и надёжный INSERT), и только потом
-- доставляется: сразу после записи пробуем отправить, а если канал лежит — строка
-- остаётся pending и её добирает крон /api/cron/notifications с растущей задержкой.
--
-- Идемпотентность — на dedupe_key: Payme/Click, дёрнувшие PerformTransaction дважды,
-- не приведут к двойному сообщению.

create table if not exists notification_outbox (
  id              uuid primary key default uuid_generate_v4(),
  channel         text        not null check (channel in ('telegram', 'in_app')),
  event           text        not null,                      -- order.paid, order.cancelled, …
  dedupe_key      text        not null unique,                -- <event>:<rental_id>:<channel>
  payload         jsonb       not null,
  status          text        not null default 'pending' check (status in ('pending', 'sending', 'sent', 'dead')),
  attempts        integer     not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at       timestamptz,                                -- когда строку забрали в доставку
  last_error      text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

-- Выборка «что пора отправить» — только по живым строкам, отправленные индекс не раздувают.
create index if not exists notification_outbox_due_idx
  on notification_outbox (next_attempt_at)
  where status in ('pending', 'sending');

-- Разбор полётов: что умерло, не достучавшись.
create index if not exists notification_outbox_dead_idx
  on notification_outbox (created_at desc)
  where status = 'dead';

alter table notification_outbox enable row level security;  -- политик нет: ходим только service-ключом

-- Забрать пачку на доставку. FOR UPDATE SKIP LOCKED — чтобы два параллельных
-- воркера (крон и обработчик оплаты) не взяли одну строку и не отправили дважды.
--
-- p_stale_seconds: строка, застрявшая в sending, значит воркер умер на полпути
-- (на Vercel лямбду могли просто прибить). Через это время её можно забрать заново.
-- attempts растёт в момент ЗАХВАТА, а не успеха, — иначе «отравленная» строка,
-- роняющая воркер, крутилась бы вечно.
create or replace function claim_notifications(p_limit integer default 20, p_stale_seconds integer default 120)
returns setof notification_outbox
language sql
security invoker
set search_path = public, pg_temp
as $$
  update notification_outbox o
     set status = 'sending', locked_at = now(), attempts = o.attempts + 1
   where o.id in (
           select id from notification_outbox
            where (status = 'pending' and next_attempt_at <= now())
               or (status = 'sending' and locked_at < now() - make_interval(secs => p_stale_seconds))
            order by next_attempt_at
            limit p_limit
            for update skip locked
         )
  returning o.*;
$$;

-- Postgres по умолчанию даёт EXECUTE всем. Без этого anon-ключ мог бы дёрнуть
-- функцию через /rest/v1/rpc и вычерпать чужие уведомления.
revoke all on function claim_notifications(integer, integer) from public;
revoke all on function claim_notifications(integer, integer) from anon, authenticated;
grant execute on function claim_notifications(integer, integer) to service_role;
