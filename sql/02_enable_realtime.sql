-- ============================================================
-- IChat — включение Realtime для нужных таблиц
-- ============================================================
--
-- ПОЧЕМУ ЭТО НУЖНО:
-- Supabase Realtime (postgres_changes) не начинает слать события
-- по таблице автоматически при её создании. Таблицу нужно явно
-- добавить в publication "supabase_realtime". Без этого шага
-- js/chat-view.js и js/chats.js подписываются корректно, но никогда
-- не получают события INSERT/UPDATE — именно поэтому новые сообщения
-- видны только после повторного захода в чат (когда происходит
-- обычный SELECT), а не мгновенно.
--
-- Альтернативный способ (без SQL): Supabase Dashboard → Database →
-- Replication → найти таблицу → включить тумблер напротив неё.
-- Ниже — то же самое через SQL, на случай если так удобнее.

-- Обёрнуто в отдельные DO-блоки на каждую таблицу: если одна из них уже
-- была добавлена в publication раньше, ошибка на этой строке больше не
-- прерывает выполнение остальных (в предыдущей версии скрипта одна
-- ошибка "already member of publication" останавливала весь скрипт —
-- и остальные таблицы могли остаться без Realtime, что и вызывало
-- симптом "сообщения появляются только после повторного захода в чат").

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

-- ============================================================
-- Проверка после применения: откройте чат на двух устройствах/вкладках
-- под разными аккаунтами и отправьте сообщение — оно должно появиться
-- у собеседника без обновления страницы.
-- ============================================================
