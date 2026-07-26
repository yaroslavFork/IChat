-- ============================================================
-- IChat — создание всех таблиц (в правильном порядке зависимостей)
-- Безопасно запускать повторно: везде IF NOT EXISTS.
-- НЕ включает RLS — это отдельный шаг (см. docs/RLS-GUIDE.md),
-- чтобы не сломать приложение раньше времени.
-- ============================================================

create extension if not exists pgcrypto;

-- ⚠️ ВАЖНО: скрипт предполагает, что users.id имеет тип uuid
-- (стандарт для Supabase). Если у вас в таблице users id другого типа
-- (например bigint/serial) — остановитесь и сообщите мне тип,
-- иначе внешние ключи ниже не совпадут по типу и упадут с ошибкой.

-- ------------------------------------------------------------
-- 1. USERS — создаётся, только если её ещё нет вообще;
--    если уже есть (как в вашем случае) — просто докидываем колонки.
-- ------------------------------------------------------------
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  password text,
  created_at timestamptz default now()
);

alter table users add column if not exists name text;
alter table users add column if not exists avatar_url text;
alter table users add column if not exists bio text;
alter table users add column if not exists role text default 'user';
alter table users add column if not exists blocked boolean default false;
alter table users add column if not exists online boolean default false;
alter table users add column if not exists last_seen timestamptz;
alter table users add column if not exists verified_badge text;
alter table users add column if not exists created_at timestamptz default now();

-- ------------------------------------------------------------
-- 2. CHATS
-- ------------------------------------------------------------
create table if not exists chats (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'private',
  name text,
  avatar_url text,
  owner_id uuid references users(id),
  is_open boolean default false,
  created_at timestamptz default now()
);

alter table chats add column if not exists avatar_url text;
alter table chats add column if not exists is_open boolean default false;
alter table chats add column if not exists owner_id uuid references users(id);
alter table chats add column if not exists created_at timestamptz default now();

-- ------------------------------------------------------------
-- 3. CHAT_MEMBERS
-- ------------------------------------------------------------
create table if not exists chat_members (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid references chats(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  role text default 'member',
  unread_count int default 0,
  last_read_at timestamptz,
  unique (chat_id, user_id)
);

alter table chat_members add column if not exists role text default 'member';
alter table chat_members add column if not exists unread_count int default 0;
alter table chat_members add column if not exists last_read_at timestamptz;

-- ------------------------------------------------------------
-- 4. MESSAGES — вот эта таблица у вас отсутствовала
-- ------------------------------------------------------------
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid references chats(id) on delete cascade,
  sender_id uuid references users(id),
  content text,
  type text default 'text',
  status text default 'sent',
  created_at timestamptz default now()
);

alter table messages add column if not exists reply_to uuid references messages(id);
alter table messages add column if not exists forwarded_from uuid references users(id);
alter table messages add column if not exists edited_at timestamptz;
alter table messages add column if not exists deleted_at timestamptz;
alter table messages add column if not exists status text default 'sent';
alter table messages add column if not exists file_url text;
alter table messages add column if not exists file_name text;
alter table messages add column if not exists file_size bigint;
alter table messages add column if not exists duration numeric;

-- ------------------------------------------------------------
-- 5. ANNOUNCEMENTS
-- ------------------------------------------------------------
create table if not exists announcements (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references users(id),
  content text not null,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- 6. CALLS
-- ------------------------------------------------------------
create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid references chats(id) on delete cascade,
  caller_id uuid references users(id),
  callee_id uuid references users(id),
  type text default 'voice',
  status text default 'ringing',
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- 7. PUSH_SUBSCRIPTIONS
-- ------------------------------------------------------------
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  endpoint text unique not null,
  subscription jsonb not null,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- Индексы для производительности (не обязательны, но полезны)
-- ------------------------------------------------------------
create index if not exists idx_messages_chat_id on messages(chat_id);
create index if not exists idx_messages_created_at on messages(created_at);
create index if not exists idx_chat_members_user_id on chat_members(user_id);
create index if not exists idx_chat_members_chat_id on chat_members(chat_id);
create index if not exists idx_calls_chat_id on calls(chat_id);
create index if not exists idx_push_subscriptions_user_id on push_subscriptions(user_id);

-- ============================================================
-- Готово. RLS здесь намеренно не включён — сделаем отдельным
-- шагом по docs/RLS-GUIDE.md, когда таблицы будут на месте.
-- ============================================================
