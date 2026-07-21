// js/groups.js
// Создание групп (любой пользователь) и экран информации о группе/канале
// (список участников, выход из группы).
//
// ОЖИДАЕМАЯ СХЕМА (доп. к уже описанным):
//   chats.type может быть 'private' | 'group' | 'channel'
//   chats.is_open boolean — открытая/закрытая группа или канал

import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./auth.js";

const screenChats = document.getElementById("screen-chats");
const screenChat = document.getElementById("screen-chat");
const screenGroupInfo = document.getElementById("screen-group-info");

const newGroupModal = document.getElementById("new-group-modal");
const newGroupNameInput = document.getElementById("new-group-name");
const newGroupSearchInput = document.getElementById("new-group-search");
const newGroupUserList = document.getElementById("new-group-user-list");
const newGroupSelectedCount = document.getElementById("new-group-selected-count");
const newGroupCreateBtn = document.getElementById("new-group-create-btn");
const newGroupCloseBtn = document.getElementById("new-group-close");

const chatMenuBtn = document.getElementById("chat-menu-btn");
const groupInfoBackBtn = document.getElementById("group-info-back-btn");
const groupInfoAvatar = document.getElementById("group-info-avatar");
const groupInfoName = document.getElementById("group-info-name");
const groupInfoType = document.getElementById("group-info-type");
const groupInfoMembers = document.getElementById("group-info-members");
const groupInfoLeaveBtn = document.getElementById("group-info-leave-btn");

const DEFAULT_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#3A3A3C"/><text x="32" y="40" font-size="26" fill="#98989D" text-anchor="middle" font-family="-apple-system,sans-serif">?</text></svg>`
  );

let selectedMembers = new Map(); // id -> user
let currentGroupChatId = null;

/* === Открытие модалки создания группы (вызывается из new-chat.js) === */
export function openNewGroupModal() {
  selectedMembers.clear();
  newGroupNameInput.value = "";
  newGroupSearchInput.value = "";
  updateSelectedCount();
  newGroupModal.classList.remove("hidden");
  runGroupUserSearch("");
}

newGroupCloseBtn.addEventListener("click", () => newGroupModal.classList.add("hidden"));
newGroupModal.addEventListener("click", (e) => {
  if (e.target === newGroupModal) newGroupModal.classList.add("hidden");
});

let groupSearchDebounce = null;
newGroupSearchInput.addEventListener("input", () => {
  clearTimeout(groupSearchDebounce);
  groupSearchDebounce = setTimeout(() => runGroupUserSearch(newGroupSearchInput.value), 250);
});

async function runGroupUserSearch(query) {
  const me = getCurrentUser();
  const q = query.trim();

  let request = supabase.from("users").select("id, username, name, avatar_url").neq("id", me.id).limit(30);
  if (q) request = request.or(`username.ilike.%${q}%,name.ilike.%${q}%`);

  const { data, error } = await request;
  if (error) {
    console.warn("[Groups] ошибка поиска пользователей:", error.message);
    renderGroupUserList([]);
    return;
  }
  renderGroupUserList(data || []);
}

function renderGroupUserList(users) {
  newGroupUserList.innerHTML = "";
  const fragment = document.createDocumentFragment();

  users.forEach((user) => {
    const li = document.createElement("li");
    li.className = "user-list-item" + (selectedMembers.has(user.id) ? " selected" : "");
    li.innerHTML = `
      <img class="avatar avatar-sm" src="${user.avatar_url || DEFAULT_AVATAR}" alt="" />
      <div>
        <div class="user-list-name">${escapeHtml(user.name || user.username)}</div>
        <div class="user-list-login">@${escapeHtml(user.username)}</div>
      </div>
      <span class="user-list-check"><span class="svg-icon svg-check"></span></span>
    `;
    li.addEventListener("click", () => {
      if (selectedMembers.has(user.id)) {
        selectedMembers.delete(user.id);
        li.classList.remove("selected");
      } else {
        selectedMembers.set(user.id, user);
        li.classList.add("selected");
      }
      updateSelectedCount();
    });
    fragment.appendChild(li);
  });

  newGroupUserList.appendChild(fragment);
}

function updateSelectedCount() {
  const n = selectedMembers.size;
  newGroupSelectedCount.textContent =
    n === 0 ? "Участники не выбраны" : `Выбрано участников: ${n}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

newGroupCreateBtn.addEventListener("click", createGroup);

async function createGroup() {
  const me = getCurrentUser();
  const name = newGroupNameInput.value.trim();

  if (!name) {
    alert("Введите название группы");
    return;
  }
  if (selectedMembers.size === 0) {
    alert("Выберите хотя бы одного участника");
    return;
  }

  const { data: chat, error: chatError } = await supabase
    .from("chats")
    .insert({ type: "group", name, owner_id: me.id, is_open: false })
    .select()
    .single();

  if (chatError || !chat) {
    console.warn("[Groups] не удалось создать группу:", chatError?.message);
    alert("Не удалось создать группу");
    return;
  }

  const members = [
    { chat_id: chat.id, user_id: me.id, role: "owner", unread_count: 0 },
    ...[...selectedMembers.keys()].map((uid) => ({
      chat_id: chat.id,
      user_id: uid,
      role: "member",
      unread_count: 0,
    })),
  ];

  const { error: membersError } = await supabase.from("chat_members").insert(members);
  if (membersError) {
    console.warn("[Groups] не удалось добавить участников:", membersError.message);
  }

  newGroupModal.classList.add("hidden");
  document.dispatchEvent(new CustomEvent("ichat:open-chat", { detail: { chatId: chat.id } }));
}

/* === Экран информации о группе/канале === */
chatMenuBtn.addEventListener("click", async () => {
  const chatId = window.__ichatActiveChatIdForMenu;
  if (chatId) await openGroupInfo(chatId);
});

// chat-view.js уведомляет о смене активного чата через это глобальное поле,
// чтобы кнопка меню знала, какой чат открыт (без циклических импортов).
document.addEventListener("ichat:open-chat", (e) => {
  window.__ichatActiveChatIdForMenu = e.detail.chatId;
});

groupInfoBackBtn.addEventListener("click", () => {
  screenGroupInfo.classList.remove("active");
  screenChat.classList.add("active");
});

async function openGroupInfo(chatId) {
  const { data: chat } = await supabase.from("chats").select("*").eq("id", chatId).maybeSingle();
  if (!chat || chat.type === "private") return; // у личных чатов своё меню (профиль собеседника)

  currentGroupChatId = chatId;

  groupInfoAvatar.src = chat.avatar_url || DEFAULT_AVATAR;
  groupInfoName.textContent = chat.name || "Без названия";
  groupInfoType.textContent =
    (chat.type === "channel" ? "Канал" : "Группа") + " · " + (chat.is_open ? "открытая" : "закрытая");

  const { data: members } = await supabase
    .from("chat_members")
    .select("role, users:user_id (id, name, username, avatar_url)")
    .eq("chat_id", chatId);

  groupInfoMembers.innerHTML = "";
  (members || []).forEach((m) => {
    if (!m.users) return;
    const li = document.createElement("li");
    li.className = "admin-user-row";
    li.innerHTML = `
      <img class="avatar avatar-sm" src="${m.users.avatar_url || DEFAULT_AVATAR}" alt="" />
      <div class="admin-user-info">
        <div class="admin-user-name">${escapeHtml(m.users.name || m.users.username)}</div>
        <div class="admin-user-login">@${escapeHtml(m.users.username)}</div>
      </div>
      ${m.role === "owner" ? '<span class="admin-user-tag">владелец</span>' : ""}
    `;
    groupInfoMembers.appendChild(li);
  });

  screenChat.classList.remove("active");
  screenGroupInfo.classList.add("active");
}

groupInfoLeaveBtn.addEventListener("click", async () => {
  if (!currentGroupChatId) return;
  const me = getCurrentUser();
  if (!confirm("Покинуть эту группу?")) return;

  const { error } = await supabase
    .from("chat_members")
    .delete()
    .eq("chat_id", currentGroupChatId)
    .eq("user_id", me.id);

  if (error) {
    console.warn("[Groups] не удалось покинуть группу:", error.message);
    return;
  }

  screenGroupInfo.classList.remove("active");
  screenChats.classList.add("active");
});
