// js/chats.js
// Загрузка и отрисовка списка чатов на главном экране + realtime-обновления.
//
// ОЖИДАЕМАЯ СХЕМА БД (подгони под реальные названия колонок, если отличаются):
//   chats         (id, type: 'private'|'group'|'channel', name, avatar_url,
//                   owner_id, is_open, created_at)
//   chat_members  (id, chat_id, user_id, role, unread_count, last_read_at)
//   messages      (id, chat_id, sender_id, content, type, reply_to,
//                   forwarded_from, edited_at, deleted_at, status, created_at)
//   users         (id, username, password, name, avatar_url, online, last_seen,
//                   role, blocked, verified_badge, bio, created_at)

import { supabase } from "./supabase-client.js";

const chatListEl = document.getElementById("chat-list");
const chatListEmptyEl = document.getElementById("chat-list-empty");
const searchInput = document.getElementById("search-input");

let realtimeChannel = null;
let allChatsCache = [];
let currentUserRef = null;

const DEFAULT_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#3A3A3C"/><text x="32" y="40" font-size="26" fill="#98989D" text-anchor="middle" font-family="-apple-system,sans-serif">?</text></svg>`
  );

/** Публичная точка входа: вызывается после успешного входа в приложение. */
export async function initChatList(user) {
  currentUserRef = user;
  await loadChats();
  subscribeRealtime();

  searchInput.value = "";
  searchInput.oninput = () => renderChats(filterChats(searchInput.value));
}

/** Отписка от realtime и очистка состояния при выходе из аккаунта. */
export function teardownChatList() {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  allChatsCache = [];
  currentUserRef = null;
  chatListEl.innerHTML = "";
}

/**
 * Загружает чаты текущего пользователя вместе с последним сообщением
 * и данными собеседника (для приватных чатов).
 */
async function loadChats() {
  if (!currentUserRef) return;

  const { data: memberships, error } = await supabase
    .from("chat_members")
    .select("chat_id, unread_count, chats:chat_id (id, type, name, avatar_url, is_open, owner_id, created_at)")
    .eq("user_id", currentUserRef.id);

  if (error) {
    console.warn("[Chats] не удалось загрузить список чатов:", error.message);
    renderChats([]);
    return;
  }

  const chats = (memberships || [])
    .filter((m) => m.chats)
    .map((m) => ({ ...m.chats, unread_count: m.unread_count || 0 }));

  const enriched = await enrichChatsBatch(chats);

  enriched.sort((a, b) => {
    const at = a.last_message?.created_at || a.created_at;
    const bt = b.last_message?.created_at || b.created_at;
    return new Date(bt) - new Date(at);
  });

  allChatsCache = enriched;
  renderChats(allChatsCache);
}

/**
 * Догружает последнее сообщение и (для приватных чатов) собеседника для
 * ВСЕХ чатов списка ДВУМЯ запросами вместо 2×N (раньше на каждый чат
 * уходило по отдельному запросу last-message + отдельному запросу
 * "кто мой собеседник" — при 20 чатах это 40+ запросов на мобильном
 * интернете при каждом открытии приложения). Здесь один запрос тянет
 * недавние сообщения сразу по всем chat_id, другой — всех собеседников
 * сразу по всем приватным чатам, дальше группируем на клиенте.
 */
async function enrichChatsBatch(chats) {
  if (chats.length === 0) return [];

  const chatIds = chats.map((c) => c.id);
  const privateChatIds = chats.filter((c) => c.type === "private").map((c) => c.id);

  const [messagesRes, membersRes] = await Promise.all([
    supabase
      .from("messages")
      .select("id, chat_id, content, type, sender_id, created_at, status")
      .in("chat_id", chatIds)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(300),
    privateChatIds.length > 0
      ? supabase
          .from("chat_members")
          .select("chat_id, user_id, users:user_id (id, name, username, avatar_url, online)")
          .in("chat_id", privateChatIds)
          .neq("user_id", currentUserRef.id)
      : Promise.resolve({ data: [] }),
  ]);

  // Первое (самое новое) сообщение на каждый chat_id — т.к. messagesRes уже
  // отсортирован по created_at desc, достаточно взять первое вхождение.
  const lastMessageByChat = new Map();
  for (const msg of messagesRes.data || []) {
    if (!lastMessageByChat.has(msg.chat_id)) lastMessageByChat.set(msg.chat_id, msg);
  }

  const otherMemberByChat = new Map();
  for (const m of membersRes.data || []) {
    if (m.users) otherMemberByChat.set(m.chat_id, m.users);
  }

  return chats.map((chat) => {
    const result = { ...chat, last_message: lastMessageByChat.get(chat.id) || null };

    if (chat.type === "private") {
      const other = otherMemberByChat.get(chat.id);
      result.display_name = other?.name || other?.username || "Без имени";
      result.display_avatar = other?.avatar_url;
      result.online = !!other?.online;
    } else {
      result.display_name = chat.name;
      result.display_avatar = chat.avatar_url;
      result.online = false;
    }

    return result;
  });
}

  return result;
}

function filterChats(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return allChatsCache;
  return allChatsCache.filter((c) => (c.display_name || "").toLowerCase().includes(q));
}

function formatTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function lastMessagePreview(chat) {
  const msg = chat.last_message;
  if (!msg) return "Нет сообщений";
  const prefix = msg.sender_id === currentUserRef?.id ? "Вы: " : "";
  switch (msg.type) {
    case "photo": return prefix + "📷 Фото";
    case "video": return prefix + "🎬 Видео";
    case "document": return prefix + "📄 Документ";
    case "voice": return prefix + "🎤 Голосовое сообщение";
    default: return prefix + (msg.content || "");
  }
}

function renderChats(chats) {
  chatListEl.innerHTML = "";
  chatListEmptyEl.classList.toggle("hidden", chats.length > 0);

  const fragment = document.createDocumentFragment();

  chats.forEach((chat) => {
    const li = document.createElement("li");
    li.className = "chat-item";
    li.dataset.chatId = chat.id;

    li.innerHTML = `
      <div class="avatar-wrap">
        <img class="avatar" src="${chat.display_avatar || DEFAULT_AVATAR}" alt="" />
        ${chat.online ? '<span class="online-dot"></span>' : ""}
      </div>
      <div class="chat-item-body">
        <div class="chat-item-top">
          <span class="chat-item-name">${escapeHtml(chat.display_name || "Без имени")}</span>
          <span class="chat-item-time">${formatTime(chat.last_message?.created_at || chat.created_at)}</span>
        </div>
        <div class="chat-item-bottom">
          <span class="chat-item-last">${escapeHtml(lastMessagePreview(chat))}</span>
          ${chat.unread_count > 0 ? `<span class="unread-badge">${chat.unread_count}</span>` : ""}
        </div>
      </div>
    `;

    li.addEventListener("click", () => openChat(chat.id));
    fragment.appendChild(li);
  });

  chatListEl.appendChild(fragment);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// Открытие конкретного чата реализуется в js/chat-view.js (следующий шаг).
function openChat(chatId) {
  document.dispatchEvent(new CustomEvent("ichat:open-chat", { detail: { chatId } }));
}

/** Подписка на realtime: новые/изменённые сообщения обновляют превью и сортировку списка. */
function subscribeRealtime() {
  if (!currentUserRef) return;

  realtimeChannel = supabase
    .channel(`chat-list-${currentUserRef.id}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "messages" },
      (payload) => {
        // Postgres Realtime не умеет фильтровать по "chat_id IN (мои чаты)"
        // на сервере — фильтруем на клиенте и, если сообщение не из наших
        // чатов, вообще ничего не делаем (раньше здесь был loadChats() без
        // всякой проверки — то есть КАЖДОЕ сообщение у ЛЮБОГО пользователя
        // в системе вызывало полную перезагрузку списка чатов со всеми
        // N дополнительными запросами у ВСЕХ подключённых клиентов
        // одновременно — на мобильном интернете это было особенно заметно).
        const msg = payload.new || payload.old;
        if (!msg || !allChatsCache.some((c) => c.id === msg.chat_id)) return;
        patchChatPreview(msg);
      }
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "chat_members", filter: `user_id=eq.${currentUserRef.id}` },
      () => loadChats()
    )
    .subscribe();
}

/**
 * Точечно обновляет превью одного чата (последнее сообщение, время,
 * сортировку) по данным из realtime-события, БЕЗ повторных запросов
 * к Supabase — вместо прежнего полного loadChats() на каждое сообщение.
 */
function patchChatPreview(msg) {
  const chat = allChatsCache.find((c) => c.id === msg.chat_id);
  if (!chat) return;

  chat.last_message = {
    id: msg.id,
    content: msg.content,
    type: msg.type,
    sender_id: msg.sender_id,
    created_at: msg.created_at,
    status: msg.status,
  };

  allChatsCache.sort((a, b) => {
    const at = a.last_message?.created_at || a.created_at;
    const bt = b.last_message?.created_at || b.created_at;
    return new Date(bt) - new Date(at);
  });

  renderChats(filterChats(searchInput.value));
}
