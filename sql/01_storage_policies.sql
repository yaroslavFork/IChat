-- ============================================================
-- IChat — Storage Policies для bucket "ichat-media"
-- ВЕРСИЯ 2 — устойчива к политикам, созданным вручную через
-- мастер в Supabase Dashboard (Storage → Policies → New Policy),
-- у которых могут быть произвольные имена вроде
-- "Authenticated users can upload" — это НЕ мои политики,
-- поэтому DROP POLICY IF EXISTS "ichat_media_anon_insert" их
-- не находил и не мог удалить, а конфликтующее имя оставалось.
-- ============================================================
--
-- ПОЧЕМУ ЭТО ВООБЩЕ НУЖНО:
-- "Public bucket" в Supabase включает только публичное ЧТЕНИЕ файлов.
-- Запись (INSERT/UPDATE/DELETE) по умолчанию запрещена RLS-политиками
-- на storage.objects, даже если сам бакет публичный.
--
-- ЧЕСТНО ПРО АРХИТЕКТУРУ: приложение не использует Supabase Auth
-- (auth.uid() всегда NULL при текущей схеме входа через кастомную
-- таблицу users, см. docs/RLS-GUIDE.md) — поэтому политики ниже
-- разрешают запись роли anon без проверки "чей это чат", это тот
-- же осознанный компромисс, что и по всей базе сейчас.
--
-- БЕЗОПАСНО ДЛЯ ДРУГИХ ПРОЕКТОВ (F-BANK / Forkuslugi): storage.objects
-- — общая системная таблица на весь Supabase-проект, в ней лежат
-- политики для ВСЕХ бакетов сразу. Поэтому ниже НЕ удаляются все
-- политики подряд — только те, чьё условие (USING/WITH CHECK)
-- реально ссылается на bucket_id = 'ichat-media'. Политики других
-- бакетов (например, для F-BANK) это не затронет.

do $$
declare
  pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (
        coalesce(qual, '') ilike '%ichat-media%'
        or coalesce(with_check, '') ilike '%ichat-media%'
      )
  loop
    execute format('drop policy %I on storage.objects', pol.policyname);
  end loop;
end $$;

create policy "ichat_media_public_read"
on storage.objects for select
to public
using (bucket_id = 'ichat-media');

create policy "ichat_media_anon_insert"
on storage.objects for insert
to public
with check (bucket_id = 'ichat-media');

create policy "ichat_media_anon_update"
on storage.objects for update
to public
using (bucket_id = 'ichat-media')
with check (bucket_id = 'ichat-media');

create policy "ichat_media_anon_delete"
on storage.objects for delete
to public
using (bucket_id = 'ichat-media');

-- ПРИМЕЧАНИЕ: команда `alter table storage.objects enable row level
-- security` намеренно не включена в этот скрипт. В Supabase таблица
-- storage.objects принадлежит служебной роли supabase_storage_admin —
-- даже роль postgres, под которой выполняются запросы в SQL Editor,
-- не является её владельцем, и такая команда падает с ошибкой
-- "must be owner of table objects". RLS на storage.objects включён
-- системой Supabase по умолчанию для всех проектов — вручную
-- включать его не требуется и невозможно через обычный SQL Editor.

-- ------------------------------------------------------------
-- Диагностика: покажет все текущие политики на storage.objects,
-- относящиеся к нашему бакету (должно быть 4 строки — select/insert/
-- update/delete, все с именами ichat_media_*).
-- ------------------------------------------------------------
-- select policyname, cmd, roles from pg_policies
-- where schemaname = 'storage' and tablename = 'objects'
-- and (qual ilike '%ichat-media%' or with_check ilike '%ichat-media%');

