// js/new-chat.js
// Модалка создания нового чата: поиск пользователя по логину/имени,
// открытие уже существующего приватного чата или создание нового.

import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./auth.js";
import { openNewGroupModal } from "./groups.js";

const modal = document.getElementById("new-chat-modal");
const openBtn = document.getElementById("new-chat-btn");
const closeBtn = document.getElementById("new-chat-close");
const searchInput = document.getElementById("new-chat-search");
const userListEl = document.getElementById("new-chat-user-list");
const emptyEl = document.getElementById("new-chat-empty");
const newGroupBtn = document.getElementById("new-group-btn");

const openChannelsList = document.getElementById("open-channels-list");
const openChannelsEmpty = document.getElementById("open-channels-empty");

const DEFAULT_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#3A3A3C"/><text x="32" y="40" font-size="26" fill="#98989D" text-anchor="middle" font-family="-apple-system,sans-serif">?</text></svg>`
  );

let searchDebounce = null;

openBtn.addEventListener("click", openModal);
closeBtn.addEventListener("click", closeModal);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});

searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    runSearch(searchInput.value);
    runOpenChannelsSearch(searchInput.value);
  }, 250);
});

// Открывает модалку создания группы (см. js/groups.js).
newGroupBtn.addEventListener("click", () => {
  closeModal();
  openNewGroupModal();
});

function openModal() {
  modal.classList.remove("hidden");
  searchInput.value = "";
  userListEl.innerHTML = "";
  emptyEl.classList.add("hidden");
  searchInput.focus();
  runSearch("");
  runOpenChannelsSearch("");
}

function closeModal() {
  modal.classList.add("hidden");
}

async function runSearch(query) {
  const me = getCurrentUser();
  const q = query.trim();

  let request = supabase
    .from("users")
    .select("id, username, name, avatar_url, online")
    .neq("id", me.id)
    .limit(30);

  if (q) {
    request = request.or(`username.ilike.%${q}%,name.ilike.%${q}%`);
  }

  const { data, error } = await request;

  if (error) {
    console.warn("[NewChat] ошибка поиска пользователей:", error.message);
    renderUsers([]);
    return;
  }

  renderUsers(data || []);
}

function renderUsers(users) {
  userListEl.innerHTML = "";
  emptyEl.classList.toggle("hidden", users.length > 0);

  const fragment = document.createDocumentFragment();
  users.forEach((user) => {
    const li = document.createElement("li");
    li.className = "user-list-item";
    li.innerHTML = `
      <img class="avatar avatar-sm" src="${user.avatar_url || DEFAULT_AVATAR}" alt="" />
      <div>
        <div class="user-list-name">${escapeHtml(user.name || user.username)}</div>
        <div class="user-list-login">@${escapeHtml(user.username)}</div>
      </div>
    `;
    li.addEventListener("click", () => selectUser(user));
    fragment.appendChild(li);
  });
  userListEl.appendChild(fragment);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

async function selectUser(otherUser) {
  const me = getCurrentUser();
  const chatId = await findOrCreatePrivateChat(me.id, otherUser.id);
  closeModal();
  if (chatId) {
    document.dispatchEvent(new CustomEvent("ichat:open-chat", { detail: { chatId } }));
  }
}

/**
 * Ищет существующий приватный чат между двумя пользователями.
 * Если не найден — создаёт новую запись в `chats` и добавляет обоих в `chat_members`.
 */
async function findOrCreatePrivateChat(myId, otherId) {
  const { data: myChats } = await supabase
    .from("chat_members")
    .select("chat_id")
    .eq("user_id", myId);

  const myChatIds = (myChats || []).map((c) => c.chat_id);

  if (myChatIds.length > 0) {
    const { data: sharedMemberships } = await supabase
      .from("chat_members")
      .select("chat_id")
      .eq("user_id", otherId)
      .in("chat_id", myChatIds);

    const sharedChatIds = (sharedMemberships || []).map((c) => c.chat_id);

    if (sharedChatIds.length > 0) {
      const { data: existingPrivate } = await supabase
        .from("chats")
        .select("id")
        .eq("type", "private")
        .in("id", sharedChatIds)
        .maybeSingle();

      if (existingPrivate) return existingPrivate.id;
    }
  }

  const { data: newChat, error: createError } = await supabase
    .from("chats")
    .insert({ type: "private", owner_id: myId })
    .select()
    .single();

  if (createError || !newChat) {
    console.warn("[NewChat] не удалось создать чат:", createError?.message);
    return null;
  }

  const { error: membersError } = await supabase.from("chat_members").insert([
    { chat_id: newChat.id, user_id: myId, role: "member", unread_count: 0 },
    { chat_id: newChat.id, user_id: otherId, role: "member", unread_count: 0 },
  ]);

  if (membersError) {
    console.warn("[NewChat] не удалось добавить участников чата:", membersError.message);
    return null;
  }

  return newChat.id;
}

/* === Открытые группы и каналы (доступны для подписки любому пользователю) === */
async function runOpenChannelsSearch(query) {
  const q = query.trim();

  let request = supabase
    .from("chats")
    .select("id, type, name, avatar_url")
    .in("type", ["group", "channel"])
    .eq("is_open", true)
    .limit(30);

  if (q) request = request.ilike("name", `%${q}%`);

  const { data, error } = await request;
  if (error) {
    console.warn("[NewChat] ошибка поиска открытых чатов:", error.message);
    renderOpenChannels([]);
    return;
  }
  renderOpenChannels(data || []);
}

function renderOpenChannels(chats) {
  openChannelsList.innerHTML = "";
  openChannelsEmpty.classList.toggle("hidden", chats.length > 0);

  const fragment = document.createDocumentFragment();
  chats.forEach((chat) => {
    const li = document.createElement("li");
    li.className = "user-list-item";
    li.innerHTML = `
      <img class="avatar avatar-sm" src="${chat.avatar_url || DEFAULT_AVATAR}" alt="" />
      <div>
        <div class="user-list-name">${escapeHtml(chat.name || "Без названия")}</div>
        <div class="user-list-login">${chat.type === "channel" ? "Канал" : "Группа"} · открытый</div>
      </div>
    `;
    li.addEventListener("click", () => joinOpenChat(chat.id));
    fragment.appendChild(li);
  });
  openChannelsList.appendChild(fragment);
}

async function joinOpenChat(chatId) {
  const me = getCurrentUser();

  const { data: existing } = await supabase
    .from("chat_members")
    .select("chat_id")
    .eq("chat_id", chatId)
    .eq("user_id", me.id)
    .maybeSingle();

  if (!existing) {
    const { error } = await supabase
      .from("chat_members")
      .insert({ chat_id: chatId, user_id: me.id, role: "member", unread_count: 0 });

    if (error) {
      console.warn("[NewChat] не удалось подписаться на чат:", error.message);
      return;
    }
  }

  closeModal();
  document.dispatchEvent(new CustomEvent("ichat:open-chat", { detail: { chatId } }));
}
