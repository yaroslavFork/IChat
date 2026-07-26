-- ============================================================
-- IChat — таблица персональных уведомлений (в приложении)
-- ============================================================
--
-- ЧЕСТНО ПРО ГРАНИЦЫ ЭТОЙ ФУНКЦИИ:
-- Эта таблица обеспечивает уведомление, которое пользователь увидит
-- ВНУТРИ приложения (колокольчик со счётчиком, список, реалтайм-доставка,
-- если пользователь сейчас в сети). Это НЕ то же самое, что настоящий
-- push от операционной системы, который будит закрытое приложение —
-- для этого нужен отдельный сервер с приватным VAPID-ключом (см.
-- js/push.js и ecosystem-security/SECURITY-REFACTOR.md), потому что
-- приватный ключ нельзя класть в клиентский код на GitHub Pages —
-- это открыло бы возможность слать поддельные push кому угодно.
--
-- recipient_id = NULL означает "уведомление для всех" (можно использовать
-- как общую ленту, если понадобится в будущем); обычно здесь будет
-- конкретный id пользователя.

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

-- Включаем Realtime для мгновенной доставки (колокольчик обновляется без перезагрузки).
-- Обёрнуто в DO-блок, чтобы не падать с ошибкой при повторном запуске,
-- если таблица уже была добавлена в publication ранее.
do $$
begin
  alter publication supabase_realtime add table notifications;
exception
  when duplicate_object then null;
end $$;

-- ============================================================
-- Готово. RLS здесь не включён — отдельный шаг по docs/RLS-GUIDE.md.
-- ============================================================
