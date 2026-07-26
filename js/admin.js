// js/admin.js
// Админ-панель: доступна только пользователю с role = 'admin'.
// Вкладки: Пользователи (блокировка/разблокировка, выдача галочек),
// Статистика, Объявления.
//
// ОЖИДАЕМАЯ СХЕМА (доп. к уже описанным): таблица `announcements`
// (id, author_id, content, created_at).

import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./auth.js";
import { BADGES as BADGE_DEFS } from "./badges.js";
import { logAction } from "./mod-log.js";

const screenChats = document.getElementById("screen-chats");
const screenProfile = document.getElementById("screen-profile");
const screenAdmin = document.getElementById("screen-admin");

const adminBtn = document.getElementById("profile-admin-btn");
const backBtn = document.getElementById("admin-back-btn");

const tabs = document.querySelectorAll(".admin-tab");
const panels = document.querySelectorAll(".admin-tab-panel");

const userSearchInput = document.getElementById("admin-user-search");
const userListEl = document.getElementById("admin-user-list");

const statTotalUsers = document.getElementById("stat-total-users");
const statOnlineUsers = document.getElementById("stat-online-users");
const statTotalChats = document.getElementById("stat-total-chats");
const statTotalMessages = document.getElementById("stat-total-messages");
const statBlockedUsers = document.getElementById("stat-blocked-users");

const announcementInput = document.getElementById("announcement-input");
const announcementSendBtn = document.getElementById("announcement-send-btn");
const announcementListEl = document.getElementById("announcement-list");

const newChannelName = document.getElementById("new-channel-name");
const newChannelCreateBtn = document.getElementById("new-channel-create-btn");
const segmentBtns = document.querySelectorAll(".segment-btn");
const adminGroupsList = document.getElementById("admin-groups-list");

const adminChatsSearch = document.getElementById("admin-chats-search");
const adminChatsList = document.getElementById("admin-chats-list");

const DEFAULT_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#3A3A3C"/><text x="32" y="40" font-size="26" fill="#98989D" text-anchor="middle" font-family="-apple-system,sans-serif">?</text></svg>`
  );

const BADGES = ["none", ...BADGE_DEFS.map((b) => b.key)];

let allUsersCache = [];

// Кнопка "Админ-панель" на экране профиля появляется только у role = 'admin'.
document.addEventListener("ichat:profile-rendered", (e) => {
  const isAdmin = e.detail?.role === "admin" && e.detail?.isOwn;
  adminBtn.classList.toggle("hidden", !isAdmin);
});

adminBtn.addEventListener("click", openAdminPanel);
backBtn.addEventListener("click", closeAdminPanel);

tabs.forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

function switchTab(name) {
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  panels.forEach((p) => p.classList.toggle("active", p.id === `admin-tab-${name}`));

  if (name === "users") loadUsers();
  if (name === "stats") loadStats();
  if (name === "announcements") loadAnnouncements();
  if (name === "groups") loadGroups();
  if (name === "allchats") loadAllChats();
  if (name === "modlog") loadModLog();
  if (name === "reports") loadReports();
  if (name === "callsmgmt") loadActiveCalls();
}

function openAdminPanel() {
  screenProfile.classList.remove("active");
  screenAdmin.classList.add("active");
  switchTab("users");
}

function closeAdminPanel() {
  screenAdmin.classList.remove("active");
  screenChats.classList.add("active");
}

/* === Пользователи === */
async function loadUsers() {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.warn("[Admin] не удалось загрузить пользователей:", error.message);
    return;
  }

  allUsersCache = data || [];
  renderUsers(allUsersCache);

  userSearchInput.oninput = () => {
    const q = userSearchInput.value.trim().toLowerCase();
    const filtered = !q
      ? allUsersCache
      : allUsersCache.filter(
          (u) => (u.username || "").toLowerCase().includes(q) || (u.name || "").toLowerCase().includes(q)
        );
    renderUsers(filtered);
  };
}

function renderUsers(users) {
  userListEl.innerHTML = "";
  const fragment = document.createDocumentFragment();

  users.forEach((user) => {
    const li = document.createElement("li");
    li.className = "admin-user-row";

    const badgePicker = BADGES.map((b) => {
      const label = b === "none" ? "Без галочки" : BADGE_DEFS.find((d) => d.key === b)?.label || b;
      const isActive = user.verified_badge === b || (b === "none" && !user.verified_badge);
      if (b === "none") {
        return `<span class="badge-dot dot-none ${isActive ? "active" : ""}" data-badge="none" title="${label}"></span>`;
      }
      return `<img class="badge-dot badge-dot-img ${isActive ? "active" : ""}" data-badge="${b}" title="${label}" src="icons/badges/icon-badge-${b}.svg" width="22" height="22" alt="${label}" />`;
    }).join("");

    li.innerHTML = `
      <img class="avatar avatar-sm" src="${user.avatar_url || DEFAULT_AVATAR}" alt="" />
      <div class="admin-user-info">
        <div class="admin-user-name">
          ${escapeHtml(user.name || user.username)}
          ${user.role === "admin" ? '<span class="admin-user-tag">admin</span>' : ""}
          ${user.online ? '<span class="admin-user-tag online">онлайн</span>' : ""}
          ${user.blocked ? '<span class="admin-user-tag blocked">блок</span>' : ""}
        </div>
        <div class="admin-user-login">@${escapeHtml(user.username)}</div>
        <div class="badge-picker">${badgePicker}</div>
      </div>
      <div class="admin-user-actions">
        <button class="admin-block-btn ${user.blocked ? "is-blocked" : ""}" data-action="toggle-block">
          ${user.blocked ? "Разблокировать" : "Заблокировать"}
        </button>
      </div>
    `;

    li.querySelectorAll(".badge-dot").forEach((dot) => {
      dot.addEventListener("click", () => setBadge(user, dot.dataset.badge, li));
    });

    li.querySelector('[data-action="toggle-block"]').addEventListener("click", () => toggleBlock(user, li));

    fragment.appendChild(li);
  });

  userListEl.appendChild(fragment);
}

let blockTargetUser = null;
let blockTargetRow = null;

async function toggleBlock(user, rowEl) {
  if (user.blocked) {
    // Досрочная разблокировка — без модалки, сразу.
    const { data, error } = await supabase
      .from("users")
      .update({ blocked: false, block_reason: null, block_comment: null, blocked_until: null })
      .eq("id", user.id)
      .select()
      .single();

    if (error) {
      console.error("[Admin] не удалось разблокировать пользователя:", error);
      alert(`Не удалось разблокировать: ${error.message}`);
      return;
    }

    Object.assign(user, data);
    updateBlockRowUI(user, rowEl);
    logAction("unblock_user", user.id, `Разблокирован пользователь @${user.username}`);
    return;
  }

  // Блокировка — открываем модалку выбора срока/причины.
  blockTargetUser = user;
  blockTargetRow = rowEl;
  document.getElementById("block-reason-input").value = "";
  document.getElementById("block-comment-input").value = "";
  document.getElementById("block-duration-select").value = "1d";
  document.getElementById("block-modal").classList.remove("hidden");
}

const DURATION_MS = {
  "1h": 3600_000,
  "12h": 12 * 3600_000,
  "1d": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
  forever: null,
};

const DURATION_LABEL = {
  "1h": "1 час",
  "12h": "12 часов",
  "1d": "1 день",
  "7d": "7 дней",
  "30d": "30 дней",
  forever: "навсегда",
};

document.getElementById("block-close").addEventListener("click", () => {
  document.getElementById("block-modal").classList.add("hidden");
});
document.getElementById("block-modal").addEventListener("click", (e) => {
  if (e.target.id === "block-modal") e.target.classList.add("hidden");
});

document.getElementById("block-confirm-btn").addEventListener("click", async () => {
  if (!blockTargetUser) return;

  const duration = document.getElementById("block-duration-select").value;
  const reason = document.getElementById("block-reason-input").value.trim();
  const comment = document.getElementById("block-comment-input").value.trim();
  const ms = DURATION_MS[duration];
  const blockedUntil = ms ? new Date(Date.now() + ms).toISOString() : null;
  const me = getCurrentUser();

  const { data, error } = await supabase
    .from("users")
    .update({
      blocked: true,
      block_reason: reason || null,
      block_comment: comment || null,
      blocked_until: blockedUntil,
      blocked_by: me.id,
    })
    .eq("id", blockTargetUser.id)
    .select()
    .single();

  document.getElementById("block-modal").classList.add("hidden");

  if (error) {
    console.error("[Admin] не удалось заблокировать пользователя:", error);
    alert(`Не удалось заблокировать: ${error.message}`);
    return;
  }

  Object.assign(blockTargetUser, data);
  updateBlockRowUI(blockTargetUser, blockTargetRow);
  logAction(
    "block_user",
    blockTargetUser.id,
    `Заблокирован @${blockTargetUser.username} на ${DURATION_LABEL[duration]}. Причина: ${reason || "не указана"}`
  );

  blockTargetUser = null;
  blockTargetRow = null;
});

function updateBlockRowUI(user, rowEl) {
  const btn = rowEl.querySelector('[data-action="toggle-block"]');
  btn.textContent = user.blocked ? "Разблокировать" : "Заблокировать";
  btn.classList.toggle("is-blocked", user.blocked);
  const tagBlocked = rowEl.querySelector(".admin-user-tag.blocked");
  if (user.blocked && !tagBlocked) {
    rowEl.querySelector(".admin-user-name").insertAdjacentHTML("beforeend", '<span class="admin-user-tag blocked">блок</span>');
  } else if (!user.blocked && tagBlocked) {
    tagBlocked.remove();
  }
}

async function setBadge(user, badge, rowEl) {
  const value = badge === "none" ? null : badge;
  const { data, error } = await supabase
    .from("users")
    .update({ verified_badge: value })
    .eq("id", user.id)
    .select()
    .single();

  if (error) {
    console.error("[Admin] не удалось изменить галочку:", error);
    alert(`Не удалось изменить галочку: ${error.message}`);
    return;
  }

  user.verified_badge = data.verified_badge;
  rowEl.querySelectorAll(".badge-dot").forEach((dot) => {
    dot.classList.toggle("active", dot.dataset.badge === (value || "none"));
  });

  logAction(
    value ? "grant_badge" : "remove_badge",
    user.id,
    value ? `Выдана галочка "${value}" пользователю @${user.username}` : `Снята галочка у @${user.username}`
  );
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/* === Статистика === */
async function loadStats() {
  const [{ count: totalUsers }, { count: onlineUsers }, { count: blockedUsers }, { count: totalChats }, { count: totalMessages }] =
    await Promise.all([
      supabase.from("users").select("*", { count: "exact", head: true }),
      supabase.from("users").select("*", { count: "exact", head: true }).eq("online", true),
      supabase.from("users").select("*", { count: "exact", head: true }).eq("blocked", true),
      supabase.from("chats").select("*", { count: "exact", head: true }),
      supabase.from("messages").select("*", { count: "exact", head: true }),
    ]);

  statTotalUsers.textContent = totalUsers ?? "—";
  statOnlineUsers.textContent = onlineUsers ?? "—";
  statBlockedUsers.textContent = blockedUsers ?? "—";
  statTotalChats.textContent = totalChats ?? "—";
  statTotalMessages.textContent = totalMessages ?? "—";
}

/* === Объявления === */
announcementSendBtn.addEventListener("click", sendAnnouncement);

async function sendAnnouncement() {
  const text = announcementInput.value.trim();
  if (!text) return;

  const me = getCurrentUser();
  const { error } = await supabase.from("announcements").insert({ author_id: me.id, content: text });

  if (error) {
    console.warn("[Admin] не удалось опубликовать объявление:", error.message);
    alert("Не удалось опубликовать. Проверьте, что таблица \"announcements\" существует.");
    return;
  }

  announcementInput.value = "";
  loadAnnouncements();
}

async function loadAnnouncements() {
  const { data, error } = await supabase
    .from("announcements")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    announcementListEl.innerHTML = "";
    return;
  }

  announcementListEl.innerHTML = "";
  (data || []).forEach((a) => {
    const li = document.createElement("li");
    li.className = "admin-user-row";
    li.innerHTML = `
      <div class="admin-user-info">
        <div class="admin-user-name">${escapeHtml(a.content)}</div>
        <div class="admin-user-login">${new Date(a.created_at).toLocaleString("ru-RU")}</div>
      </div>
    `;
    announcementListEl.appendChild(li);
  });
}

/* === Группы и каналы === */
let newChannelIsOpen = true;

segmentBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    segmentBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    newChannelIsOpen = btn.dataset.open === "true";
  });
});

newChannelCreateBtn.addEventListener("click", createChannel);

async function createChannel() {
  const me = getCurrentUser();
  const name = newChannelName.value.trim();

  if (!name) {
    alert("Введите название канала");
    return;
  }

  const { data: chat, error } = await supabase
    .from("chats")
    .insert({ type: "channel", name, owner_id: me.id, is_open: newChannelIsOpen })
    .select()
    .single();

  if (error || !chat) {
    console.error("[Admin] не удалось создать канал:", error);
    alert(`Не удалось создать канал: ${error?.message || "неизвестная ошибка"}`);
    return;
  }

  logAction("create_channel", null, `Создан канал "${name}" (${newChannelIsOpen ? "открытый" : "закрытый"})`);

  await supabase.from("chat_members").insert({
    chat_id: chat.id,
    user_id: me.id,
    role: "owner",
    unread_count: 0,
  });

  newChannelName.value = "";
  loadGroups();
}

async function loadGroups() {
  const { data, error } = await supabase
    .from("chats")
    .select("*")
    .in("type", ["group", "channel"])
    .order("created_at", { ascending: false });

  if (error) {
    console.warn("[Admin] не удалось загрузить группы/каналы:", error.message);
    return;
  }

  renderGroups(data || []);
}

function renderGroups(chats) {
  adminGroupsList.innerHTML = "";
  const fragment = document.createDocumentFragment();

  chats.forEach((chat) => {
    const li = document.createElement("li");
    li.className = "admin-user-row";
    li.innerHTML = `
      <div class="admin-user-info">
        <div class="admin-user-name">
          ${escapeHtml(chat.name || "Без названия")}
          <span class="group-type-tag ${chat.is_open ? "open" : "closed"}">${chat.is_open ? "открыт" : "закрыт"}</span>
        </div>
        <div class="admin-user-login">${chat.type === "channel" ? "Канал" : "Группа"}</div>
      </div>
      <div class="admin-user-actions" style="flex-direction:column; align-items:flex-end; gap:4px;">
        <button class="admin-block-btn" data-action="add-member">Добавить участника</button>
        <button class="admin-block-btn" data-action="toggle-open">${chat.is_open ? "Закрыть" : "Открыть"}</button>
        <button class="admin-block-btn" data-action="change-owner">Сменить владельца</button>
        <button class="admin-block-btn is-blocked" data-action="delete">Удалить</button>
      </div>
    `;

    li.querySelector('[data-action="add-member"]').addEventListener("click", () => openAddMemberModal(chat));
    li.querySelector('[data-action="toggle-open"]').addEventListener("click", () => toggleGroupOpen(chat, li));
    li.querySelector('[data-action="delete"]').addEventListener("click", () => deleteGroup(chat, li));
    li.querySelector('[data-action="change-owner"]').addEventListener("click", () => changeGroupOwner(chat));

    fragment.appendChild(li);
  });

  adminGroupsList.appendChild(fragment);
}

/* === Администратор вручную добавляет участника в группу/канал === */
let addMemberTargetChat = null;
let addMemberSearchDebounce = null;

const addMemberModal = document.getElementById("add-member-modal");
const addMemberTitle = document.getElementById("add-member-title");
const addMemberSearchInput = document.getElementById("add-member-search");
const addMemberUserList = document.getElementById("add-member-user-list");
const addMemberEmpty = document.getElementById("add-member-empty");

function openAddMemberModal(chat) {
  addMemberTargetChat = chat;
  addMemberTitle.textContent = `Добавить в «${chat.name || "чат"}»`;
  addMemberSearchInput.value = "";
  addMemberModal.classList.remove("hidden");
  runAddMemberSearch("");
  addMemberSearchInput.focus();
}

document.getElementById("add-member-close").addEventListener("click", () => addMemberModal.classList.add("hidden"));
addMemberModal.addEventListener("click", (e) => {
  if (e.target === addMemberModal) addMemberModal.classList.add("hidden");
});

addMemberSearchInput.addEventListener("input", () => {
  clearTimeout(addMemberSearchDebounce);
  addMemberSearchDebounce = setTimeout(() => runAddMemberSearch(addMemberSearchInput.value), 250);
});

async function runAddMemberSearch(query) {
  const q = query.trim();
  let request = supabase.from("users").select("id, username, name, avatar_url").limit(30);
  if (q) request = request.or(`username.ilike.%${q}%,name.ilike.%${q}%`);

  const { data, error } = await request;
  if (error) {
    console.error("[Admin] ошибка поиска пользователей:", error);
    renderAddMemberList([]);
    return;
  }
  renderAddMemberList(data || []);
}

function renderAddMemberList(users) {
  addMemberUserList.innerHTML = "";
  addMemberEmpty.classList.toggle("hidden", users.length > 0);

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
    li.addEventListener("click", () => addMemberToChat(user));
    fragment.appendChild(li);
  });
  addMemberUserList.appendChild(fragment);
}

async function addMemberToChat(user) {
  if (!addMemberTargetChat) return;

  const { data: existing } = await supabase
    .from("chat_members")
    .select("id")
    .eq("chat_id", addMemberTargetChat.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing) {
    alert(`@${user.username} уже состоит в этом чате`);
    return;
  }

  const { error } = await supabase.from("chat_members").insert({
    chat_id: addMemberTargetChat.id,
    user_id: user.id,
    role: "member",
    unread_count: 0,
  });

  if (error) {
    console.error("[Admin] не удалось добавить участника:", error);
    alert(`Не удалось добавить участника: ${error.message}`);
    return;
  }

  logAction(
    "add_member",
    user.id,
    `Администратор добавил @${user.username} в «${addMemberTargetChat.name || addMemberTargetChat.id}»`
  );

  addMemberModal.classList.add("hidden");
  alert(`@${user.username} добавлен в «${addMemberTargetChat.name || "чат"}»`);
}

async function toggleGroupOpen(chat, rowEl) {
  const { data, error } = await supabase
    .from("chats")
    .update({ is_open: !chat.is_open })
    .eq("id", chat.id)
    .select()
    .single();

  if (error) {
    console.warn("[Admin] не удалось изменить видимость группы:", error.message);
    return;
  }

  chat.is_open = data.is_open;
  const tag = rowEl.querySelector(".group-type-tag");
  tag.textContent = chat.is_open ? "открыт" : "закрыт";
  tag.className = `group-type-tag ${chat.is_open ? "open" : "closed"}`;
  rowEl.querySelector('[data-action="toggle-open"]').textContent = chat.is_open ? "Закрыть" : "Открыть";
}

async function deleteGroup(chat, rowEl) {
  if (!confirm(`Удалить "${chat.name}"? Это действие необратимо.`)) return;

  const { error } = await supabase.from("chats").delete().eq("id", chat.id);
  if (error) {
    console.warn("[Admin] не удалось удалить группу:", error.message);
    return;
  }
  rowEl.remove();
}

async function changeGroupOwner(chat) {
  const login = prompt("Логин нового владельца:");
  if (!login) return;

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id")
    .eq("username", login.trim())
    .maybeSingle();

  if (userError || !user) {
    alert("Пользователь не найден");
    return;
  }

  const { error: chatError } = await supabase.from("chats").update({ owner_id: user.id }).eq("id", chat.id);
  if (chatError) {
    console.warn("[Admin] не удалось сменить владельца:", chatError.message);
    return;
  }

  // Убедимся, что новый владелец состоит в участниках с ролью owner
  await supabase
    .from("chat_members")
    .upsert({ chat_id: chat.id, user_id: user.id, role: "owner", unread_count: 0 }, { onConflict: "chat_id,user_id" });

  alert("Владелец изменён");
}

/* === Все переписки (админ читает любой чат) === */
let allChatsCache = [];

adminChatsSearch.addEventListener("input", () => {
  const q = adminChatsSearch.value.trim().toLowerCase();
  const filtered = !q
    ? allChatsCache
    : allChatsCache.filter((c) => (c.label || "").toLowerCase().includes(q));
  renderAllChats(filtered);
});

async function loadAllChats() {
  const { data: chats, error } = await supabase
    .from("chats")
    .select("id, type, name, avatar_url, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.warn("[Admin] не удалось загрузить чаты:", error.message);
    return;
  }

  // Для приватных чатов подставляем "Логин1 ↔ Логин2" вместо технического названия.
  const enriched = await Promise.all(
    (chats || []).map(async (chat) => {
      if (chat.type !== "private") {
        return { ...chat, label: chat.name || "Без названия" };
      }
      const { data: members } = await supabase
        .from("chat_members")
        .select("users:user_id (username)")
        .eq("chat_id", chat.id);
      const logins = (members || []).map((m) => m.users?.username).filter(Boolean);
      return { ...chat, label: logins.join(" ↔ ") || "Личный чат" };
    })
  );

  allChatsCache = enriched;
  renderAllChats(allChatsCache);
}

function renderAllChats(chats) {
  adminChatsList.innerHTML = "";
  const fragment = document.createDocumentFragment();

  chats.forEach((chat) => {
    const li = document.createElement("li");
    li.className = "admin-user-row";
    const typeLabel = chat.type === "private" ? "Личный чат" : chat.type === "channel" ? "Канал" : "Группа";
    li.innerHTML = `
      <div class="admin-user-info">
        <div class="admin-user-name">${escapeHtml(chat.label)}</div>
        <div class="admin-user-login">${typeLabel}</div>
      </div>
      <span class="admin-block-btn" data-action="open">Открыть</span>
    `;
    li.querySelector('[data-action="open"]').addEventListener("click", () => {
      closeAdminPanel();
      document.dispatchEvent(new CustomEvent("ichat:open-chat", { detail: { chatId: chat.id, adminObserver: true } }));
    });
    fragment.appendChild(li);
  });

  adminChatsList.appendChild(fragment);
}

/* === Журнал действий === */
const ACTION_LABELS = {
  admin_login: "Вход администратора",
  admin_logout: "Выход администратора",
  block_user: "Блокировка пользователя",
  unblock_user: "Разблокировка пользователя",
  grant_badge: "Выдача галочки",
  remove_badge: "Снятие галочки",
  create_channel: "Создание канала",
  delete_message: "Удаление сообщения",
  add_member: "Добавление участника",
  end_call: "Завершение звонка",
  end_all_calls: "Завершение всех звонков",
  mass_notification: "Массовая рассылка",
  send_notification: "Персональное уведомление",
};

let modLogCache = [];

document.getElementById("modlog-search").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  const filtered = !q
    ? modLogCache
    : modLogCache.filter(
        (l) => (l.action || "").toLowerCase().includes(q) || (l.details || "").toLowerCase().includes(q)
      );
  renderModLog(filtered);
});

async function loadModLog() {
  const { data, error } = await supabase
    .from("moderation_log")
    .select("*, admin:admin_id (username), target:target_user_id (username)")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("[Admin] не удалось загрузить журнал:", error);
    document.getElementById("modlog-list").innerHTML =
      `<li class="modal-empty">Не удалось загрузить журнал: ${escapeHtml(error.message)}. Проверьте, что таблица "moderation_log" существует (sql/03_moderation.sql).</li>`;
    return;
  }

  modLogCache = data || [];
  renderModLog(modLogCache);
}

function renderModLog(entries) {
  const list = document.getElementById("modlog-list");
  list.innerHTML = "";
  entries.forEach((e) => {
    const li = document.createElement("li");
    li.className = "admin-user-row";
    li.innerHTML = `
      <div class="admin-user-info">
        <div class="admin-user-name">${escapeHtml(ACTION_LABELS[e.action] || e.action)}</div>
        <div class="admin-user-login">
          ${e.admin?.username ? "@" + escapeHtml(e.admin.username) : "система"}
          ${e.target?.username ? " → @" + escapeHtml(e.target.username) : ""}
          · ${new Date(e.created_at).toLocaleString("ru-RU")}
        </div>
        ${e.details ? `<div class="admin-user-login">${escapeHtml(e.details)}</div>` : ""}
      </div>
    `;
    list.appendChild(li);
  });
}

/* === Жалобы === */
async function loadReports() {
  const { data, error } = await supabase
    .from("reports")
    .select("*, reporter:reporter_id (username)")
    .order("created_at", { ascending: false });

  const list = document.getElementById("reports-list");
  const empty = document.getElementById("reports-empty");

  if (error) {
    console.error("[Admin] не удалось загрузить жалобы:", error);
    list.innerHTML = "";
    empty.textContent = `Не удалось загрузить жалобы: ${error.message}. Проверьте таблицу "reports" (sql/03_moderation.sql).`;
    empty.classList.remove("hidden");
    return;
  }

  const reports = data || [];
  empty.classList.toggle("hidden", reports.length > 0);
  list.innerHTML = "";

  reports.forEach((r) => {
    const li = document.createElement("li");
    li.className = "admin-user-row";
    const statusLabel = { pending: "На рассмотрении", resolved: "Рассмотрено", dismissed: "Отклонено" }[r.status] || r.status;
    li.innerHTML = `
      <div class="admin-user-info">
        <div class="admin-user-name">
          Жалоба на ${r.target_type === "user" ? "пользователя" : r.target_type === "message" ? "сообщение" : r.target_type === "group" ? "группу" : "канал"}
          <span class="admin-user-tag ${r.status === "pending" ? "" : r.status === "resolved" ? "online" : "blocked"}">${statusLabel}</span>
        </div>
        <div class="admin-user-login">От @${escapeHtml(r.reporter?.username || "неизвестно")} · ${new Date(r.created_at).toLocaleString("ru-RU")}</div>
        <div class="admin-user-login">${escapeHtml(r.reason)}</div>
      </div>
      <div class="admin-user-actions" style="flex-direction:column; align-items:flex-end; gap:4px;">
        ${r.status === "pending" ? `
          <button class="admin-block-btn" data-action="resolve">Рассмотрено</button>
          <button class="admin-block-btn" data-action="dismiss">Отклонить</button>
        ` : ""}
      </div>
    `;

    li.querySelector('[data-action="resolve"]')?.addEventListener("click", () => updateReportStatus(r.id, "resolved", li));
    li.querySelector('[data-action="dismiss"]')?.addEventListener("click", () => updateReportStatus(r.id, "dismissed", li));

    list.appendChild(li);
  });
}

async function updateReportStatus(reportId, status, li) {
  const me = getCurrentUser();
  const { error } = await supabase
    .from("reports")
    .update({ status, resolved_at: new Date().toISOString(), resolved_by: me.id })
    .eq("id", reportId);

  if (error) {
    console.error("[Admin] не удалось обновить жалобу:", error);
    alert(`Не удалось обновить жалобу: ${error.message}`);
    return;
  }
  loadReports();
}

/* === Массовые уведомления (рассылка) === */
const broadcastTitle = document.getElementById("broadcast-title-input");
const broadcastText = document.getElementById("broadcast-text-input");
const broadcastLink = document.getElementById("broadcast-link-input");
const broadcastPreview = document.getElementById("broadcast-preview");

function renderBroadcastPreview() {
  const title = broadcastTitle.value.trim();
  const text = broadcastText.value.trim();
  const link = broadcastLink.value.trim();

  if (!title && !text) {
    broadcastPreview.innerHTML = `<span class="broadcast-preview-empty">Предпросмотр появится здесь</span>`;
    return;
  }

  broadcastPreview.innerHTML = `
    ${title ? `<div class="broadcast-preview-title">${escapeHtml(title)}</div>` : ""}
    ${text ? `<div class="broadcast-preview-text">${escapeHtml(text)}</div>` : ""}
    ${link ? `<a class="broadcast-preview-link" href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(link)}</a>` : ""}
  `;
}

[broadcastTitle, broadcastText, broadcastLink].forEach((el) => el.addEventListener("input", renderBroadcastPreview));
renderBroadcastPreview();

document.getElementById("broadcast-target-select").addEventListener("change", (e) => {
  document.getElementById("broadcast-user-input").classList.toggle("hidden", e.target.value !== "user");
});

document.getElementById("broadcast-send-btn").addEventListener("click", async () => {
  const title = broadcastTitle.value.trim();
  const text = broadcastText.value.trim();
  const link = broadcastLink.value.trim();
  const target = document.getElementById("broadcast-target-select").value;
  const usernameInput = document.getElementById("broadcast-user-input").value.trim();

  if (!title && !text) {
    alert("Введите заголовок или текст уведомления");
    return;
  }

  const me = getCurrentUser();

  // Персонально одному пользователю — точечная запись в notifications
  // (виден только этому пользователю через колокольчик, доставляется
  // мгновенно, если он сейчас в сети, см. js/notifications.js).
  if (target === "user") {
    if (!usernameInput) {
      alert("Введите логин пользователя");
      return;
    }

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, username")
      .eq("username", usernameInput)
      .maybeSingle();

    if (userError || !user) {
      alert("Пользователь не найден");
      return;
    }

    const { error } = await supabase.from("notifications").insert({
      recipient_id: user.id,
      sender_id: me.id,
      title: title || null,
      content: text || null,
      link: link || null,
    });

    if (error) {
      console.error("[Admin] не удалось отправить уведомление:", error);
      alert(
        `Не удалось отправить: ${error.message}. Проверьте, что таблица "notifications" существует (sql/04_notifications.sql).`
      );
      return;
    }

    logAction("send_notification", user.id, `Персональное уведомление для @${user.username}: "${title || text.slice(0, 40)}"`);
  } else {
    // Групповая рассылка (всем/админам/по галочке) — публикуем как объявление,
    // видимое в истории объявлений админ-панели.
    const content = [title, text, link].filter(Boolean).join("\n");
    const { error } = await supabase.from("announcements").insert({ author_id: me.id, content });

    if (error) {
      console.error("[Admin] не удалось отправить рассылку:", error);
      alert(`Не удалось отправить: ${error.message}`);
      return;
    }

    logAction("mass_notification", null, `Рассылка "${title || text.slice(0, 40)}" — цель: ${target}`);
  }

  broadcastTitle.value = "";
  broadcastText.value = "";
  broadcastLink.value = "";
  document.getElementById("broadcast-user-input").value = "";
  renderBroadcastPreview();
  alert(target === "user" ? "Уведомление отправлено" : "Объявление опубликовано");
});

/* === Управление звонками === */

/**
 * Подстраховка от "зависших" звонков (как на скриншоте с длительностью
 * 1090:44) — на случай, если ни onconnectionstatechange, ни pagehide
 * в js/calls.js не сработали (например, приложение убито системой,
 * телефон разрядился, оборвалась сеть без разрыва до состояния
 * "failed"). Эвристика: "ringing" дольше 2 минут — точно пропущенный
 * звонок; "accepted" дольше 4 часов — разговор такой длины на практике
 * не бывает, значит соединение оборвалось без корректного завершения.
 */
async function cleanupStaleCalls() {
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  await supabase
    .from("calls")
    .update({ status: "missed", ended_at: new Date().toISOString() })
    .eq("status", "ringing")
    .lt("created_at", twoMinutesAgo);

  await supabase
    .from("calls")
    .update({ status: "ended", ended_at: new Date().toISOString() })
    .eq("status", "accepted")
    .lt("started_at", fourHoursAgo);
}

document.getElementById("callsmgmt-refresh-btn").addEventListener("click", loadActiveCalls);
document.getElementById("callsmgmt-endall-btn").addEventListener("click", endAllCalls);

async function endAllCalls() {
  const { data, error } = await supabase.from("calls").select("id").in("status", ["ringing", "accepted"]);

  if (error || !data || data.length === 0) {
    if (error) console.error("[Admin] не удалось получить список звонков:", error);
    return;
  }

  if (!confirm(`Завершить ${data.length} активных звонков?`)) return;

  for (const call of data) {
    await endCallAsAdminSilent(call.id);
  }

  logAction("end_all_calls", null, `Администратор завершил все активные звонки (${data.length})`);
  loadActiveCalls();
}

async function endCallAsAdminSilent(callId) {
  await supabase.from("calls").update({ status: "ended", ended_at: new Date().toISOString() }).eq("id", callId);
  const killChannel = supabase.channel(`call-signal:${callId}`);
  killChannel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      killChannel.send({ type: "broadcast", event: "hangup", payload: { byAdmin: true } });
      setTimeout(() => supabase.removeChannel(killChannel), 500);
    }
  });
}

async function loadActiveCalls() {
  await cleanupStaleCalls();

  const { data, error } = await supabase
    .from("calls")
    .select("*, caller:caller_id (username), callee:callee_id (username)")
    .in("status", ["ringing", "accepted"])
    .order("created_at", { ascending: false });

  const list = document.getElementById("callsmgmt-list");
  const empty = document.getElementById("callsmgmt-empty");

  if (error) {
    console.error("[Admin] не удалось загрузить звонки:", error);
    list.innerHTML = "";
    empty.textContent = `Не удалось загрузить звонки: ${error.message}`;
    empty.classList.remove("hidden");
    return;
  }

  const calls = data || [];
  empty.classList.toggle("hidden", calls.length > 0);
  list.innerHTML = "";

  calls.forEach((c) => {
    const li = document.createElement("li");
    li.className = "admin-user-row";
    const started = c.started_at ? new Date(c.started_at) : null;
    const durationSec = started ? Math.round((Date.now() - started.getTime()) / 1000) : null;
    li.innerHTML = `
      <div class="admin-user-info">
        <div class="admin-user-name">@${escapeHtml(c.caller?.username || "?")} ↔ @${escapeHtml(c.callee?.username || "?")}</div>
        <div class="admin-user-login">
          ${c.type === "video" ? "Видеозвонок" : "Аудиозвонок"} · ${c.status === "ringing" ? "вызов" : "идёт"}
          ${durationSec !== null ? ` · ${Math.floor(durationSec / 60)}:${(durationSec % 60).toString().padStart(2, "0")}` : ""}
        </div>
      </div>
      <button class="admin-block-btn is-blocked" data-action="end-call">Завершить</button>
    `;
    li.querySelector('[data-action="end-call"]').addEventListener("click", () => endCallAsAdmin(c.id, li));
    list.appendChild(li);
  });
}

async function endCallAsAdmin(callId, li) {
  const { error } = await supabase
    .from("calls")
    .update({ status: "ended", ended_at: new Date().toISOString() })
    .eq("id", callId);

  if (error) {
    console.error("[Admin] не удалось завершить звонок:", error);
    alert(`Не удалось завершить звонок: ${error.message}`);
    return;
  }

  // Реально обрываем живое WebRTC-соединение: отправляем "hangup" в тот же
  // сигнальный канал, которым пользуются оба участника звонка (js/calls.js
  // слушает событие "hangup" на канале call-signal:{callId}).
  const killChannel = supabase.channel(`call-signal:${callId}`);
  killChannel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      killChannel.send({ type: "broadcast", event: "hangup", payload: { byAdmin: true } });
      setTimeout(() => supabase.removeChannel(killChannel), 500);
    }
  });

  logAction("end_call", null, `Администратор принудительно завершил звонок ${callId}`);
  li.remove();
}
