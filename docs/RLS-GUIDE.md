# IChat — таблицы и RLS: что и почему настроить в Supabase

## 0. Важно: я не подключён к вашей базе напрямую

У меня нет сетевого доступа к вашему Supabase-проекту (`monyjcyypnqknrzzxjej`) — я не могу зайти
в дашборд и посмотреть, какие таблицы там реально существуют. Всё, что ниже, — это схема,
которую мы **вместе собрали по ходу разработки** (она разбросана комментариями по файлам:
`chats.js`, `chat-view.js`, `attachments.js`, `voice.js`, `admin.js`, `groups.js`, `new-chat.js`,
`auth.js`). Прежде чем включать RLS, откройте Table Editor в Supabase и **сверьте список таблиц
и колонок с этим документом** — если что-то называется иначе, политики нужно будет поправить под
реальные имена.

---

## 1. Критическая проблема: RLS не будет работать так, как вы ожидаете

Это самое важное, что нужно понять до включения RLS.

Приложение **не использует Supabase Auth** — вход идёт через обычный `SELECT` в таблицу `users`
с сверкой пароля в коде (`js/auth.js`). Значит, каждый запрос к Supabase (и от Артёма, и от
любого другого пользователя) идёт **под одной и той же ролью `anon`**, с одним и тем же публичным
`anon key`. С точки зрения Postgres все запросы неотличимы друг от друга — `auth.uid()` всегда
будет `NULL`, потому что настоящей сессии Supabase Auth просто нет.

Из этого следует:

- Политика вида `USING (user_id = auth.uid())` **не сработает** — `auth.uid()` всегда `NULL`,
  и такая политика либо заблокирует всё, либо (если написана менее строго) не защитит вообще
  ничего.
- Любая политика, которая опирается на «id текущего пользователя», переданный из клиентского кода
  (например, через фильтр `.eq('user_id', ...)` в JS), **не является защитой** — `anon key` публичный,
  лежит открытым текстом в `js/config.js`, и любой человек может открыть консоль браузера и
  отправить запрос с любым `user_id`, каким захочет. RLS не может доверять данным, которые
  прислал клиент.

**Вывод:** при нынешней архитектуре (кастомная таблица `users` + анонимный ключ) настоящая
построчная защита «каждый видит только своё» **технически невозможна** средствами одного только
RLS. Это не вопрос «правильно написанных политик» — это ограничение модели авторизации.

### Как это обычно решают (без ломки вашего UI)

Хорошая новость: экран входа, поля «логин/пароль», внешний вид — всё это можно оставить
полностью как есть. Меняется только то, что происходит **после** успешной проверки пароля:

1. **Вариант A (рекомендуемый).** После того как ваш код нашёл пользователя в таблице `users`
   и пароль совпал, дополнительно выполнить настоящий вход в Supabase Auth «под капотом»
   (например, `supabase.auth.signInWithPassword` с синтетическим email вида `login@ichat.local`
   и тем же паролем, либо через Anonymous Sign-in + привязку `user_id` в JWT custom claims).
   Тогда у Supabase появляется реальная сессия, `auth.uid()` перестаёт быть `NULL`, и все политики
   ниже начинают работать по-настоящему. Потребует один раз завести Auth-пользователей (по одному
   на каждую строку в `users`) — это можно сделать вручную через Admin API, без изменения вашей
   таблицы `users` и без единой SQL-миграции, которую пишу я.
2. **Вариант B (если Supabase Auth категорически не подходит).** Тогда RLS можно включить только
   как «грубый рубильник» (запретить вообще всё анонимам, кроме явно разрешённых публичных вещей —
   например, чтения открытых каналов). Разделения «своё / чужое» на уровне базы не будет — это
   ограничение придётся держать в голове как временное и компенсировать на уровне приложения.

Ниже я привожу политики в расчёте на **Вариант A** (`auth.uid()` доступен), потому что только
так выполняется ваше требование «пользователи видят только свои чаты/сообщения/файлы». Если
останетесь на Варианте B, скажите — пересоберу список под него отдельно.

---

## 2. Ещё один срочный момент, не связанный с RLS напрямую

`js/auth.js` сейчас делает `select('*')` из `users` и сравнивает пароль **на клиенте**. Это значит,
что пока RLS выключен (или даже включён неаккуратно), **любой человек с открытой консолью браузера
может запросить `select * from users` и увидеть пароли всех пользователей в открытом виде** —
потому что колонка `password` возвращается вместе со всей строкой.

Это не чинится одним RLS (RLS работает построчно, а не по колонкам). Когда дойдёте до этого —
варианта два:
- завести Postgres-функцию (`SECURITY DEFINER`) `check_login(login, password)`, которая сверяет
  пароль **внутри базы** и возвращает пользователя без колонки `password`, а прямой `SELECT`
  колонки `password` закрыть политикой/правами для всех, кроме этой функции;
- либо перейти на Variant A выше и хешировать пароли через сам Supabase Auth (он не хранит их
  в открытом виде вообще).

Не меняю ничего сейчас — просто фиксирую, чтобы не забыть.

---

## 3. Таблицы IChat и зачем каждой нужен RLS

| Таблица | Что хранит | Почему обязательно включить RLS |
|---|---|---|
| `users` | логин, пароль, профиль, роль, блокировка, галочка | без RLS любой видит пароли и профили всех, может сам себе выдать `role='admin'` |
| `chats` | приватные чаты, группы, каналы | без RLS любой видит список всех чатов в системе, включая чужие приватные |
| `chat_members` | кто состоит в каком чате | без RLS видно, кто с кем переписывается, можно самовольно вступить в закрытую группу |
| `messages` | текст сообщений, вложения, статусы | без RLS **вся переписка всех пользователей читается кем угодно** — самое критичное место |
| `announcements` | объявления администрации | без RLS кто угодно может опубликовать «объявление от администрации» |
| `storage.objects` (bucket `ichat-media`) | фото/видео/документы/голосовые/аватары | без RLS кто угодно может залить файл в чужой чат или удалить чужой файл |

Включаем RLS на всех шести (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + для Storage — политики
на `storage.objects`, отфильтрованные по `bucket_id = 'ichat-media'`).

---

## 4. Политики по таблицам

Для краткости пишу логику каждой политики словами и рядом — ориентировочный SQL (это описание
того, что нужно создать в Supabase → Authentication → Policies или в SQL editor **вами**, не
то, что выполняю я).

### 4.1 `users`

| Действие | Кто может | Логика |
|---|---|---|
| SELECT | все авторизованные | видят все строки, **кроме колонки `password`** (колонку исключить через отдельное представление `users_public`, RLS тут не поможет — она построчная) |
| INSERT | никто с клиента | регистрация выключена; новые пользователи заводятся вами через дашборд |
| UPDATE (свои поля: `name`, `bio`, `avatar_url`) | сам пользователь | `auth.uid() = id` |
| UPDATE (`role`, `blocked`, `verified_badge`) | только admin | `EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin')` |
| DELETE | только admin | то же условие |

```sql
create policy "users_select_all" on users
  for select using (true);  -- при условии, что password скрыт через view

create policy "users_update_self" on users
  for update using (auth.uid() = id);

create policy "users_admin_full" on users
  for all using (
    exists (select 1 from users u where u.id = auth.uid() and u.role = 'admin')
  );
```

### 4.2 `chats`

| Действие | Кто может | Логика |
|---|---|---|
| SELECT | участник чата | `id IN (SELECT chat_id FROM chat_members WHERE user_id = auth.uid())` |
| SELECT (открытые группы/каналы, для поиска) | все авторизованные | `is_open = true` — отдельная разрешающая политика вдобавок к предыдущей |
| INSERT (`type='private'` или `'group'`) | любой авторизованный | `owner_id = auth.uid()` |
| INSERT (`type='channel'`) | только admin | `owner_id = auth.uid() AND EXISTS (... role='admin')` |
| UPDATE (`is_open`, `owner_id`, удаление) | только admin | по ТЗ — даже не владелец группы, только сайт-админ |
| DELETE | только admin | — |

```sql
create policy "chats_select_member" on chats
  for select using (
    id in (select chat_id from chat_members where user_id = auth.uid())
  );

create policy "chats_select_open" on chats
  for select using (is_open = true);

create policy "chats_insert_own" on chats
  for insert with check (
    owner_id = auth.uid()
    and (type in ('private','group') or exists (
      select 1 from users where id = auth.uid() and role = 'admin'
    ))
  );

create policy "chats_admin_manage" on chats
  for update using (exists (select 1 from users where id = auth.uid() and role = 'admin'));

create policy "chats_admin_delete" on chats
  for delete using (exists (select 1 from users where id = auth.uid() and role = 'admin'));
```

### 4.3 `chat_members`

| Действие | Кто может | Логика |
|---|---|---|
| SELECT | участники того же чата | `chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = auth.uid())` |
| INSERT (сам себя, открытый чат) | любой авторизованный | `user_id = auth.uid() AND chat_id IN (SELECT id FROM chats WHERE is_open)` |
| INSERT (владелец добавляет других при создании) | владелец чата | `EXISTS (SELECT 1 FROM chats WHERE id = chat_id AND owner_id = auth.uid())` |
| UPDATE (своя строка: `unread_count`, `last_read_at`) | сам пользователь | `user_id = auth.uid()` |
| DELETE (выйти самому) | сам пользователь | `user_id = auth.uid()` |
| DELETE/UPDATE (управлять чужими) | admin или владелец чата | через подзапрос к `chats` |

### 4.4 `messages` — самое важное

| Действие | Кто может | Логика |
|---|---|---|
| SELECT | участник чата, где отправлено сообщение | `chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = auth.uid())` |
| SELECT (все сообщения) | admin | `EXISTS (... role='admin')` — отдельная политика, реализует «чтение чужих переписок» из ТЗ |
| INSERT | участник чата, `sender_id = auth.uid()` | плюс для `type='channel'` — доп. проверка, что `auth.uid()` это `owner_id` чата или admin |
| UPDATE (редактирование своего) | автор сообщения | `sender_id = auth.uid()` |
| UPDATE/DELETE (модерация — soft delete, удаление любых) | admin | реализует «удаление сообщений» из ТЗ админки |

```sql
create policy "messages_select_member" on messages
  for select using (
    chat_id in (select chat_id from chat_members where user_id = auth.uid())
  );

create policy "messages_select_admin" on messages
  for select using (exists (select 1 from users where id = auth.uid() and role = 'admin'));

create policy "messages_insert_member" on messages
  for insert with check (
    sender_id = auth.uid()
    and chat_id in (select chat_id from chat_members where user_id = auth.uid())
  );

create policy "messages_update_own" on messages
  for update using (sender_id = auth.uid());

create policy "messages_admin_moderate" on messages
  for update using (exists (select 1 from users where id = auth.uid() and role = 'admin'));
```

### 4.5 `announcements`

| Действие | Кто может | Логика |
|---|---|---|
| SELECT | все авторизованные | `true` |
| INSERT / UPDATE / DELETE | только admin | `EXISTS (... role='admin')` |

### 4.6 Storage — bucket `ichat-media`

Сейчас bucket публичный — это значит, что **скачивание файлов по прямой ссылке открыто всем**,
независимо от RLS на `storage.objects` (публичность бакета обходит RLS именно для чтения по
`getPublicUrl`). Если нужно, чтобы «свои файлы видели только свои» в буквальном смысле —
бакет придётся сделать **приватным** и переключить `attachments.js`, `voice.js`, `profile.js`
с `getPublicUrl` на `createSignedUrl` (временные подписанные ссылки). Это меняет не только
политики, но и код — сообщаю заранее, ничего не переключаю сейчас.

Если оставляем bucket публичным (проще, но файлы читаемы по прямой ссылке кем угодно, если
угадать/получить URL), RLS на `storage.objects` всё равно нужен для **записи**:

| Действие | Кто может | Логика |
|---|---|---|
| INSERT (загрузка) | участник чата | путь файла начинается с `chat_id/...`, и `chat_id` — из чатов, где состоит `auth.uid()` |
| INSERT (аватар) | сам пользователь | путь `avatars/{auth.uid()}_...` |
| UPDATE / DELETE | только загрузивший или admin | сверка по `owner` (Supabase Storage сам пишет `owner = auth.uid()` при загрузке, если есть сессия) |

```sql
create policy "media_insert_own_chat" on storage.objects
  for insert with check (
    bucket_id = 'ichat-media'
    and (storage.foldername(name))[1] in (
      select chat_id::text from chat_members where user_id = auth.uid()
    )
  );

create policy "media_delete_owner_or_admin" on storage.objects
  for delete using (
    bucket_id = 'ichat-media'
    and (owner = auth.uid() or exists (
      select 1 from users where id = auth.uid() and role = 'admin'
    ))
  );
```

---

## 5. Порядок действий, когда будете готовы

1. Сверить реальные названия таблиц/колонок в Supabase с этим документом.
2. Решить Вариант A vs Вариант B из раздела 1 (без этого «своё/чужое» не заработает по-настоящему).
3. Закрыть колонку `password` (раздел 2) — отдельно от RLS.
4. Включить `ENABLE ROW LEVEL SECURITY` на всех таблицах из раздела 3.
5. Создать политики по разделу 4, по одной таблице за раз, проверяя приложение после каждой
   (RLS может неожиданно скрыть данные, если политика написана уже, чем нужно).
6. Решить судьбу bucket `ichat-media` (публичный/приватный) и при необходимости обновить
   `attachments.js` / `voice.js` / `profile.js`.

Как скажете — могу подготовить то же самое под Вариант B, или помочь с шагом миграции на
Supabase Auth (Вариант A) без изменения внешнего вида экрана входа.
