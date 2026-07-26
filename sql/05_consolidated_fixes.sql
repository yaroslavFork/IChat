-- ============================================================
-- IChat — консолидированный скрипт (Realtime + модерация + уведомления)
-- Безопасно выполнять сколько угодно раз. Выполните целиком одним разом.
-- ============================================================

-- ---------- 1. Realtime для чатов/сообщений/звонков ----------
do $$ begin
  alter publication supabase_realtime add table messages;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table chat_members;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table chats;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table calls;
exception when duplicate_object then null;
end $$;

-- ---------- 2. Блокировки со сроком (колонки в users) ----------
alter table users add column if not exists block_reason text;
alter table users add column if not exists block_comment text;
alter table users add column if not exists blocked_until timestamptz;
alter table users add column if not exists blocked_by uuid references users(id);

-- ---------- 3. Журнал действий администраторов ----------
create table if not exists moderation_log (
  id uuid primary key default gen_random_uuid()
);
alter table moderation_log add column if not exists admin_id uuid references users(id);
alter table moderation_log add column if not exists action text;
alter table moderation_log add column if not exists target_user_id uuid references users(id);
alter table moderation_log add column if not exists details text;
alter table moderation_log add column if not exists created_at timestamptz default now();

create index if not exists idx_moderation_log_created_at on moderation_log(created_at);

-- ---------- 4. Жалобы ----------
create table if not exists reports (
  id uuid primary key default gen_random_uuid()
);
alter table reports add column if not exists reporter_id uuid references users(id);
alter table reports add column if not exists target_type text;
alter table reports add column if not exists target_id uuid;
alter table reports add column if not exists reason text;
alter table reports add column if not exists status text default 'pending';
alter table reports add column if not exists created_at timestamptz default now();
alter table reports add column if not exists resolved_at timestamptz;
alter table reports add column if not exists resolved_by uuid references users(id);

create index if not exists idx_reports_status on reports(status);

do $$ begin
  alter publication supabase_realtime add table reports;
exception when duplicate_object then null;
end $$;

-- ---------- 5. Персональные уведомления ----------
create table if not exists notifications (
  id uuid primary key default gen_random_uuid()
);
alter table notifications add column if not exists recipient_id uuid references users(id) on delete cascade;
alter table notifications add column if not exists sender_id uuid references users(id);
alter table notifications add column if not exists title text;
alter table notifications add column if not exists content text;
alter table notifications add column if not exists link text;
alter table notifications add column if not exists read_at timestamptz;
alter table notifications add column if not exists created_at timestamptz default now();

create index if not exists idx_notifications_recipient on notifications(recipient_id);
create index if not exists idx_notifications_created_at on notifications(created_at);

do $$ begin
  alter publication supabase_realtime add table notifications;
exception when duplicate_object then null;
end $$;

-- ============================================================
-- Готово. Проверка: SELECT count(*) FROM moderation_log; и
-- SELECT count(*) FROM reports; и SELECT count(*) FROM notifications;
-- — все три должны выполниться без ошибки "table not found".
-- ============================================================
