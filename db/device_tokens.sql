-- Push-уведомления: токены устройств + канал 'push' в outbox (Taketool 1.3).
--
-- До этого клиент видел уведомления ТОЛЬКО открыв приложение: бэкенд писал строку
-- в notifications, а дотянуться до телефона было нечем. Теперь тот же outbox умеет
-- канал push, а здесь живут регистрационные токены FCM.

create table if not exists device_tokens (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid not null references users(id) on delete cascade,
  -- Регистрационный токен FCM. Уникален: одно устройство — один владелец.
  -- Телефон передали другому человеку → при входе токен переедет на нового
  -- пользователя через upsert, а не продублируется.
  token        text not null unique,
  platform     text not null check (platform in ('android', 'ios')),
  app_version  text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists device_tokens_user_idx on device_tokens (user_id);

alter table device_tokens enable row level security;  -- политик нет: только service-ключ

-- Разрешаем каналу push жить в очереди. CHECK пересоздаём: в Postgres его не изменить.
alter table notification_outbox drop constraint if exists notification_outbox_channel_check;
alter table notification_outbox add constraint notification_outbox_channel_check
  check (channel in ('telegram', 'in_app', 'push'));
