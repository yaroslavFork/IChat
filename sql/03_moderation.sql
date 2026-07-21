-- ============================================================
-- IChat — модерация: блокировки со сроком, журнал действий, жалобы
-- Безопасно запускать повторно (IF NOT EXISTS везде).
-- ============================================================

-- ------------------------------------------------------------
-- Блокировки: причина, комментарий администратора, дата окончания.
-- users.blocked остаётся общим флагом "заблокирован сейчас";
-- blocked_until = NULL при blocked=true означает "навсегда".
-- ------------------------------------------------------------
alter table users add column if not exists block_reason text;
alter table users add column if not exists block_comment text;
alter table users add column if not exists blocked_until timestamptz;
alter table users add column if not exists blocked_by uuid references users(id);

-- ------------------------------------------------------------
-- Журнал действий администраторов
-- ------------------------------------------------------------
create table if not exists moderation_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references users(id),
  action text not null,
  target_user_id uuid references users(id),
  details text,
  created_at timestamptz default now()
);

create index if not exists idx_moderation_log_created_at on moderation_log(created_at);

-- ------------------------------------------------------------
-- Жалобы
-- ------------------------------------------------------------
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references users(id),
  target_type text not null, -- 'user' | 'message' | 'group' | 'channel'
  target_id uuid,
  reason text not null,
  status text default 'pending', -- 'pending' | 'resolved' | 'dismissed'
  created_at timestamptz default now(),
  resolved_at timestamptz,
  resolved_by uuid references users(id)
);

create index if not exists idx_reports_status on reports(status);

-- ============================================================
-- Готово. RLS на этих таблицах не включён — отдельный шаг
-- по docs/RLS-GUIDE.md (там уже описан общий подход).
-- ============================================================
