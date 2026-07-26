// js/chat-view.js
// Экран переписки: загрузка истории, отправка текстовых сообщений, realtime,
// ответы (reply), статусы доставки/прочтения, индикатор "печатает...".
// Открывается по событию "ichat:open-chat" (диспатчится из js/chats.js).

import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./auth.js";
import { logAction } from "./mod-log.js";

const screenChats = document.getElementById("screen-chats");
const screenChat = document.getElementById("screen-chat");

const headerAvatar = document.getElementById("chat-header-avatar");
const headerName = document.getElementById("chat-header-name");
const headerStatus = document.getElementById("chat-header-status");
const backBtn = document.getElementById("chat-back-btn");

const messagesScroll = document.getElementById("messages-scroll");
const messagesList = document.getElementById("messages-list");

const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const voiceBtn = document.getElementById("voice-btn");

const replyPreview = document.getElementById("reply-preview");
const replyPreviewName = document.getElementById("reply-preview-name");
const replyPreviewText = document.getElementById("reply-preview-text");
const replyPreviewClose = document.getElementById("reply-preview-close");

const typingIndicator = document.getElementById("typing-indicator");
const typingIndicatorText = document.getElementById("typing-indicator-text");

const actionsSheet = document.getElementById("message-actions-sheet");
const actionsPreview = document.getElementById("message-actions-preview");
const forwardModal = document.getElementById("forward-modal");
const forwardChatList = document.getElementById("forward-chat-list");
const forwardEmpty = document.getElementById("forward-empty");
const forwardClose = document.getElementById("forward-close");
const composerEl = document.getElementById("composer");
const readonlyBanner = document.getElementById("readonly-banner");

const DEFAULT_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#3A3A3C"/><text x="32" y="40" font-size="26" fill="#98989D" text-anchor="middle" font-family="-apple-system,sans-serif">?</text></svg>`
  );

let activeChatId = null;
let activeChatInfo = null;
let messagesCache = [];
let replyTarget = null;
let messagesChannel = null;
let typingChannel = null;
let isAdminObserver = false;
let typingTimeout = null;
let othersTyping = new Map(); // userId -> имя, для группировки
let actionTargetMsg = null;
let editingMessageId = null;

document.addEventListener("ichat:open-chat", (e) => openChat(e.detail.chatId, !!e.detail.adminObserver));
backBtn.addEventListener("click", closeChat);

export function getActiveChatId() {
  return activeChatId;
}

export function refreshAfterExternalInsert(newMsg) {
  if (newMsg.chat_id !== activeChatId) return;
  messagesCache.push(newMsg);
  renderMessages();
  scrollToBottom();
}
replyPreviewClose.addEventListener("click", () => {
  if (editingMessageId) {
    cancelEdit();
  } else {
    clearReply();
  }
});

async function openChat(chatId, adminObserver = false) {
  activeChatId = chatId;
  isAdminObserver = adminObserver;
  messagesCache = [];
  replyTarget = null;
  editingMessageId = null;
  messagesList.innerHTML = "";
  clearReply();

  screenChats.classList.remove("active");
  screenChat.classList.add("active");

  await loadChatInfo(chatId);
  await loadMessages(chatId);
  if (!isAdminObserver) await markAsRead(chatId);
  subscribeToChat(chatId);
  scrollToBottom(false);
}

function closeChat() {
  screenChat.classList.remove("active");
  screenChats.classList.add("active");
  unsubscribeFromChat();
  activeChatId = null;
}

async function loadChatInfo(chatId) {
  const me = getCurrentUser();

  const { data: chat } = await supabase
    .from("chats")
    .select("id, type, name, avatar_url, owner_id")
    .eq("id", chatId)
    .maybeSingle();

  if (!chat) return;

  if (chat.type === "private" && isAdminObserver) {
    const { data: members } = await supabase
      .from("chat_members")
      .select("users:user_id (id, name, username, avatar_url)")
      .eq("chat_id", chatId);

    const names = (members || []).map((m) => m.users?.name || m.users?.username).filter(Boolean);
    activeChatInfo = {
      ...chat,
      display_name: names.join(" ↔ ") || "Личный чат",
      display_avatar: null,
      online: false,
      otherUserId: null,
    };
    window.__ichatActiveOtherUserId = null;
  } else if (chat.type === "private") {
    const { data: otherMember } = await supabase
      .from("chat_members")
      .select("users:user_id (id, name, username, avatar_url, online, last_seen)")
      .eq("chat_id", chatId)
      .neq("user_id", me.id)
      .maybeSingle();

    const other = otherMember?.users;
    activeChatInfo = {
      ...chat,
      display_name: other?.name || other?.username || "Без имени",
      display_avatar: other?.avatar_url,
      online: !!other?.online,
      otherUserId: other?.id,
    };
    window.__ichatActiveOtherUserId = other?.id || null;
  } else {
    activeChatInfo = {
      ...chat,
      display_name: chat.name,
      display_avatar: chat.avatar_url,
      online: false,
    };
    window.__ichatActiveOtherUserId = null;
  }

  headerAvatar.src = activeChatInfo.display_avatar || DEFAULT_AVATAR;
  headerName.textContent = activeChatInfo.display_name;
  headerStatus.textContent = activeChatInfo.online ? "в сети" : "";

  document.getElementById("call-voice-btn").classList.toggle("hidden", chat.type !== "private" || isAdminObserver);
  document.getElementById("call-video-btn").classList.toggle("hidden", chat.type !== "private" || isAdminObserver);

  await updatePostingPermission(chat, me);
}

/**
 * Для каналов писать могут только владелец чата и пользователи с role='admin'.
 * Группы и личные чаты — без ограничений.
 * ВАЖНО: это ограничение только в интерфейсе. Для настоящей защиты от прямых
 * запросов к Supabase нужна RLS-политика на таблице `messages` (настраивается
 * в дашборде Supabase, без написания SQL вручную здесь не создаём).
 */
async function updatePostingPermission(chat, me) {
  let canPost = true;

  if (isAdminObserver) {
    canPost = false;
  } else if (chat.type === "channel") {
    canPost = chat.owner_id === me.id || me.role === "admin";
  }

  composerEl.classList.toggle("hidden", !canPost);
  readonlyBanner.classList.toggle("hidden", canPost);
  readonlyBanner.textContent = isAdminObserver
    ? "Режим наблюдателя администратора — только чтение"
    : "Публиковать могут только администраторы канала";
}

async function loadMessages(chatId) {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    console.warn("[ChatView] не удалось загрузить сообщения:", error.message);
    return;
  }

  messagesCache = data || [];
  renderMessages();
}

function renderMessages() {
  const me = getCurrentUser();
  messagesList.innerHTML = "";
  const fragment = document.createDocumentFragment();

  messagesCache.forEach((msg) => {
    const isMine = msg.sender_id === me.id;
    const li = document.createElement("li");
    li.className = `msg-row ${isMine ? "mine" : "theirs"}`;
    li.dataset.msgId = msg.id;

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";

    if (msg.deleted_at) {
      bubble.innerHTML = `<span class="msg-deleted">Сообщение удалено</span>`;
    } else {
      let html = "";
      if (msg.forwarded_from) {
        html += `<span class="msg-forwarded">Переслано</span>`;
      }
      if (msg.reply_to) {
        const original = messagesCache.find((m) => m.id === msg.reply_to);
        if (original) {
          html += `<span class="msg-reply">${escapeHtml(truncate(original.content, 80))}</span>`;
        }
      }
      html += `<span class="msg-text">${renderContent(msg)}</span>`;
      html += `<span class="msg-meta">`;
      if (msg.edited_at) html += `<span class="msg-edited">изменено</span>`;
      html += `<span class="msg-time">${formatTime(msg.created_at)}</span>`;
      if (isMine) html += renderTicks(msg.status);
      html += `</span>`;
      bubble.innerHTML = html;
    }

    if (!msg.deleted_at) {
      attachLongPress(bubble, () => openMessageActions(msg));
    }

    li.appendChild(bubble);
    fragment.appendChild(li);
  });

  messagesList.appendChild(fragment);
  initVoicePlayers();
}

/** Переключает иконку кнопки голосового плеера между play и pause. */
function setPlayIcon(btn, isPlaying) {
  const icon = btn.querySelector(".svg-icon");
  if (!icon) return;
  icon.classList.toggle("svg-play", !isPlaying);
  icon.classList.toggle("svg-pause", isPlaying);
}

/** Подключает воспроизведение/прогресс/скорость ко всем плеерам голосовых сообщений в DOM. */
function initVoicePlayers() {
  messagesList.querySelectorAll(".voice-player:not([data-ready])").forEach((el) => {
    el.dataset.ready = "1";
    const src = el.dataset.src;
    const playBtn = el.querySelector(".voice-play-btn");
    const progressFill = el.querySelector(".voice-progress-fill");
    const progressBar = el.querySelector(".voice-progress");
    const timeEl = el.querySelector(".voice-time");
    const speedBtn = el.querySelector(".voice-speed-btn");

    let audio = null;
    let speedIndex = 0;
    const speeds = [1, 1.5, 2];

    const ensureAudio = () => {
      if (audio) return audio;
      audio = new Audio(src);
      audio.addEventListener("timeupdate", () => {
        if (!audio.duration) return;
        progressFill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
        timeEl.textContent = formatDuration(audio.duration - audio.currentTime);
      });
      audio.addEventListener("ended", () => {
        playBtn.classList.remove("playing");
        setPlayIcon(playBtn, false);
        progressFill.style.width = "0%";
      });
      return audio;
    };

    playBtn.addEventListener("click", () => {
      const a = ensureAudio();
      if (a.paused) {
        a.play();
        playBtn.classList.add("playing");
        setPlayIcon(playBtn, true);
      } else {
        a.pause();
        playBtn.classList.remove("playing");
        setPlayIcon(playBtn, false);
      }
    });

    progressBar.addEventListener("click", (e) => {
      const a = ensureAudio();
      if (!a.duration) return;
      const rect = progressBar.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      a.currentTime = ratio * a.duration;
    });

    speedBtn.addEventListener("click", () => {
      speedIndex = (speedIndex + 1) % speeds.length;
      const a = ensureAudio();
      a.playbackRate = speeds[speedIndex];
      speedBtn.textContent = `${speeds[speedIndex]}×`;
    });
  });
}

/** Долгое нажатие (мышь/тач) на элементе — вызывает callback без срабатывания на обычный тап. */
function attachLongPress(el, callback, duration = 420) {
  let timer = null;
  let moved = false;

  const start = () => {
    moved = false;
    timer = setTimeout(() => {
      if (!moved) callback();
    }, duration);
  };
  const cancel = () => {
    clearTimeout(timer);
  };
  const onMove = () => { moved = true; cancel(); };

  el.addEventListener("mousedown", start);
  el.addEventListener("touchstart", start, { passive: true });
  ["mouseup", "mouseleave", "touchend", "touchcancel"].forEach((ev) => el.addEventListener(ev, cancel));
  ["mousemove", "touchmove"].forEach((ev) => el.addEventListener(ev, onMove));
}

/* === Меню действий с сообщением === */
function openMessageActions(msg) {
  const me = getCurrentUser();
  const isMine = msg.sender_id === me.id;
  const canModerate = isMine || me.role === "admin";

  actionTargetMsg = msg;
  actionsPreview.textContent = truncate(msg.content, 70) || "";

  actionsSheet.querySelectorAll(".action-row").forEach((btn) => {
    const action = btn.dataset.action;
    if (action === "edit") btn.classList.toggle("hidden", !isMine || msg.type !== "text");
    if (action === "delete") btn.classList.toggle("hidden", !canModerate);
    if (action === "reply" || action === "forward") btn.classList.toggle("hidden", isAdminObserver);
    if (action === "report") btn.classList.toggle("hidden", isMine || isAdminObserver);
  });

  actionsSheet.classList.remove("hidden");
}

function closeMessageActions() {
  actionsSheet.classList.add("hidden");
  actionTargetMsg = null;
}

actionsSheet.addEventListener("click", (e) => {
  if (e.target === actionsSheet) return closeMessageActions();
  const btn = e.target.closest(".action-row");
  if (!btn) return;
  handleMessageAction(btn.dataset.action);
});

function handleMessageAction(action) {
  const msg = actionTargetMsg;
  closeMessageActions();
  if (!msg) return;

  switch (action) {
    case "reply":
      setReplyTarget(msg);
      break;
    case "forward":
      openForwardModal(msg);
      break;
    case "copy":
      navigator.clipboard?.writeText(msg.content || "").catch(() => {});
      break;
    case "edit":
      startEditMessage(msg);
      break;
    case "report":
      reportMessage(msg);
      break;
    case "delete":
      deleteMessage(msg);
      break;
    default:
      break;
  }
}

function renderContent(msg) {
  switch (msg.type) {
    case "photo":
      return `
        <img class="msg-photo" src="${escapeAttr(msg.file_url)}" alt="${escapeAttr(msg.content || "Фото")}" loading="lazy" />
        ${msg.content ? `<span class="msg-caption">${escapeHtml(msg.content)}</span>` : ""}
      `;
    case "video":
      return `
        <video class="msg-video" src="${escapeAttr(msg.file_url)}" controls preload="metadata"></video>
        ${msg.content ? `<span class="msg-caption">${escapeHtml(msg.content)}</span>` : ""}
      `;
    case "document":
      return `
        <a class="msg-document" href="${escapeAttr(msg.file_url)}" target="_blank" rel="noopener">
          <span class="msg-document-icon"><span class="svg-icon svg-document" style="width:18px;height:18px;background-color:currentColor;"></span></span>
          <span class="msg-document-info">
            <span class="msg-document-name">${escapeHtml(msg.file_name || "Документ")}</span>
            <span class="msg-document-size">${formatFileSize(msg.file_size)}</span>
          </span>
        </a>
      `;
    case "voice":
      return renderVoicePlayer(msg);
    default:
      return escapeHtml(msg.content || "");
  }
}

function escapeAttr(str) {
  return escapeHtml(str || "");
}

function formatFileSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " КБ";
  return (bytes / (1024 * 1024)).toFixed(1) + " МБ";
}

function renderVoicePlayer(msg) {
  const duration = msg.duration ? formatDuration(msg.duration) : "0:00";
  return `
    <div class="voice-player" data-src="${escapeAttr(msg.file_url)}">
      <button class="voice-play-btn" type="button" aria-label="Воспроизвести"><span class="svg-icon svg-play" style="background-color:currentColor;"></span></button>
      <div class="voice-progress"><div class="voice-progress-fill"></div></div>
      <span class="voice-time">${duration}</span>
      <button class="voice-speed-btn" type="button">1×</button>
    </div>
  `;
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function renderTicks(status) {
  // Одна галочка — отправлено, две серые — доставлено, две акцентного цвета — прочитано
  if (status === "read") {
    return `<span class="msg-ticks msg-ticks-read"><span class="svg-icon svg-check-double"></span></span>`;
  }
  if (status === "delivered") {
    return `<span class="msg-ticks"><span class="svg-icon svg-check-double"></span></span>`;
  }
  return `<span class="msg-ticks"><span class="svg-icon svg-check-single"></span></span>`;
}

function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n) + "…" : str;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function scrollToBottom(smooth = true) {
  messagesScroll.scrollTo({ top: messagesScroll.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

/* === Ответ на сообщение === */
function setReplyTarget(msg) {
  const me = getCurrentUser();
  replyTarget = msg;
  replyPreviewName.textContent = msg.sender_id === me.id ? "Вы" : activeChatInfo?.display_name || "";
  replyPreviewText.textContent = truncate(msg.content, 60);
  replyPreview.classList.remove("hidden");
  messageInput.focus();
}

function clearReply() {
  replyTarget = null;
  replyPreview.classList.add("hidden");
}

/* === Жалоба на сообщение === */
async function reportMessage(msg) {
  const reason = prompt("Опишите причину жалобы:");
  if (!reason || !reason.trim()) return;

  const me = getCurrentUser();
  const { error } = await supabase.from("reports").insert({
    reporter_id: me.id,
    target_type: "message",
    target_id: msg.id,
    reason: reason.trim(),
  });

  if (error) {
    console.error("[ChatView] не удалось отправить жалобу:", error);
    alert(`Не удалось отправить жалобу: ${error.message}`);
    return;
  }
  alert("Жалоба отправлена администрации");
}

/* === Редактирование === */
function startEditMessage(msg) {
  editingMessageId = msg.id;
  clearReply();
  messageInput.value = msg.content || "";
  messageInput.focus();
  autoResizeTextarea();
  updateComposerButtons();
  showEditBanner(true);
}

function cancelEdit() {
  editingMessageId = null;
  messageInput.value = "";
  updateComposerButtons();
  showEditBanner(false);
}

function showEditBanner(show) {
  replyPreview.classList.toggle("hidden", !show);
  if (show) {
    replyPreviewName.textContent = "Редактирование";
    replyPreviewText.textContent = "Изменить сообщение";
  }
}

/* === Удаление (мягкое) === */
async function deleteMessage(msg) {
  const me = getCurrentUser();
  const { data, error } = await supabase
    .from("messages")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", msg.id)
    .select()
    .single();

  if (error) {
    console.error("[ChatView] не удалось удалить сообщение:", error);
    alert(`Не удалось удалить сообщение: ${error.message}`);
    return;
  }

  // Если админ удаляет чужое сообщение (модерация) — фиксируем в журнале.
  if (msg.sender_id !== me.id && me.role === "admin") {
    logAction("delete_message", msg.sender_id, `Удалено сообщение пользователя в чате ${msg.chat_id}`);
  }

  const idx = messagesCache.findIndex((m) => m.id === msg.id);
  if (idx !== -1) messagesCache[idx] = data;
  renderMessages();
}

/* === Пересылка === */
async function openForwardModal(msg) {
  actionTargetMsg = msg; // сохраняем на время выбора чата
  forwardModal.classList.remove("hidden");
  forwardChatList.innerHTML = "";

  const me = getCurrentUser();
  const { data: memberships } = await supabase
    .from("chat_members")
    .select("chat_id, chats:chat_id (id, type, name, avatar_url)")
    .eq("user_id", me.id);

  const chats = (memberships || []).filter((m) => m.chats).map((m) => m.chats);
  forwardEmpty.classList.toggle("hidden", chats.length > 0);

  const fragment = document.createDocumentFragment();
  chats.forEach((chat) => {
    const li = document.createElement("li");
    li.className = "user-list-item";
    li.innerHTML = `
      <img class="avatar avatar-sm" src="${chat.avatar_url || DEFAULT_AVATAR}" alt="" />
      <div class="user-list-name">${escapeHtml(chat.name || "Чат")}</div>
    `;
    li.addEventListener("click", () => forwardToChat(chat.id));
    fragment.appendChild(li);
  });
  forwardChatList.appendChild(fragment);
}

async function forwardToChat(targetChatId) {
  const me = getCurrentUser();
  const original = actionTargetMsg;
  forwardModal.classList.add("hidden");
  if (!original) return;

  const { error } = await supabase.from("messages").insert({
    chat_id: targetChatId,
    sender_id: me.id,
    content: original.content,
    type: original.type,
    status: "sent",
    forwarded_from: original.sender_id,
  });

  if (error) {
    console.warn("[ChatView] не удалось переслать сообщение:", error.message);
  }
  actionTargetMsg = null;
  if (targetChatId === activeChatId) {
    await loadMessages(activeChatId);
    scrollToBottom();
  }
}

forwardClose.addEventListener("click", () => forwardModal.classList.add("hidden"));
forwardModal.addEventListener("click", (e) => {
  if (e.target === forwardModal) forwardModal.classList.add("hidden");
});
function updateComposerButtons() {
  const hasText = messageInput.value.trim().length > 0;
  sendBtn.classList.toggle("hidden", !hasText);
  voiceBtn.classList.toggle("hidden", hasText);
}

messageInput.addEventListener("input", () => {
  updateComposerButtons();
  autoResizeTextarea();
  broadcastTyping();
});

messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);

function autoResizeTextarea() {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 100) + "px";
}

async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !activeChatId) return;

  if (editingMessageId) {
    await saveEditedMessage(editingMessageId, text);
    return;
  }

  const me = getCurrentUser();
  const payload = {
    chat_id: activeChatId,
    sender_id: me.id,
    content: text,
    type: "text",
    status: "sent",
    reply_to: replyTarget ? replyTarget.id : null,
  };

  messageInput.value = "";
  updateComposerButtons();
  autoResizeTextarea();
  clearReply();

  const { data, error } = await supabase.from("messages").insert(payload).select().single();

  if (error) {
    console.warn("[ChatView] не удалось отправить сообщение:", error.message);
    return;
  }

  messagesCache.push(data);
  renderMessages();
  scrollToBottom();
}

async function saveEditedMessage(msgId, text) {
  const { data, error } = await supabase
    .from("messages")
    .update({ content: text, edited_at: new Date().toISOString() })
    .eq("id", msgId)
    .select()
    .single();

  cancelEdit();

  if (error) {
    console.warn("[ChatView] не удалось сохранить изменения:", error.message);
    return;
  }

  const idx = messagesCache.findIndex((m) => m.id === msgId);
  if (idx !== -1) messagesCache[idx] = data;
  renderMessages();
}

/* === Пометка прочитанным === */
async function markAsRead(chatId) {
  const me = getCurrentUser();
  await supabase
    .from("messages")
    .update({ status: "read" })
    .eq("chat_id", chatId)
    .neq("sender_id", me.id)
    .neq("status", "read");

  await supabase
    .from("chat_members")
    .update({ unread_count: 0, last_read_at: new Date().toISOString() })
    .eq("chat_id", chatId)
    .eq("user_id", me.id);
}

/* === Realtime: новые сообщения + статусы + typing === */
function subscribeToChat(chatId) {
  messagesChannel = supabase
    .channel(`chat-${chatId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` },
      (payload) => {
        messagesCache.push(payload.new);
        renderMessages();
        scrollToBottom();
        markAsRead(chatId);
      }
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` },
      (payload) => {
        const idx = messagesCache.findIndex((m) => m.id === payload.new.id);
        if (idx !== -1) messagesCache[idx] = payload.new;
        renderMessages();
      }
    )
    .subscribe();

  typingChannel = supabase
    .channel(`typing-${chatId}`)
    .on("broadcast", { event: "typing" }, (payload) => {
      const me = getCurrentUser();
      if (payload.payload.userId === me.id) return;
      othersTyping.set(payload.payload.userId, payload.payload.name);
      renderTypingIndicator();
      clearTimeout(othersTyping.get(`timeout_${payload.payload.userId}`));
      const t = setTimeout(() => {
        othersTyping.delete(payload.payload.userId);
        renderTypingIndicator();
      }, 3000);
      othersTyping.set(`timeout_${payload.payload.userId}`, t);
    })
    .subscribe();
}

function unsubscribeFromChat() {
  if (messagesChannel) supabase.removeChannel(messagesChannel);
  if (typingChannel) supabase.removeChannel(typingChannel);
  messagesChannel = null;
  typingChannel = null;
  othersTyping.clear();
  renderTypingIndicator();
}

function broadcastTyping() {
  if (!typingChannel || !activeChatId) return;
  clearTimeout(typingTimeout);
  const me = getCurrentUser();
  typingChannel.send({
    type: "broadcast",
    event: "typing",
    payload: { userId: me.id, name: me.name || me.username },
  });
}

function renderTypingIndicator() {
  const names = [...othersTyping.entries()]
    .filter(([key]) => !key.startsWith("timeout_"))
    .map(([, name]) => name);

  if (names.length === 0) {
    typingIndicator.classList.add("hidden");
    return;
  }
  typingIndicatorText.textContent = names.length === 1 ? `${names[0]} печатает…` : "печатают…";
  typingIndicator.classList.remove("hidden");
}
