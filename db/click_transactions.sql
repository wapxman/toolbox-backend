-- Транзакции Click SHOP API (аналог payme_transactions).
-- Применить в Supabase (SQL editor) до включения Click.
create table if not exists public.click_transactions (
  id                uuid primary key default gen_random_uuid(),
  click_trans_id    text not null,
  click_paydoc_id   text,
  merchant_trans_id uuid not null references public.rentals(id) on delete cascade,
  amount            numeric not null,           -- в СУМАХ
  state             int  not null default 1,    -- 1=prepared, 2=confirmed, -1=cancelled
  sign_time         text,
  prepare_time      bigint,
  confirm_time      bigint,
  cancel_time       bigint,
  created_at        timestamptz not null default now()
);

create index if not exists click_tx_merchant_trans on public.click_transactions(merchant_trans_id);
create index if not exists click_tx_click_trans   on public.click_transactions(click_trans_id);

-- merchant_prepare_id, который мы возвращаем Click в Prepare — это click_transactions.id (uuid).
-- В Complete Click присылает его обратно, ищем строку по id.
