// js/notifications.js
// Персональные уведомления внутри приложения: колокольчик со счётчиком,
// список, живая доставка через Supabase Realtime, отметка прочитанным.
//
// ЧЕСТНО ПРО ГРАНИЦЫ: это уведомление внутри приложения (работает, пока
// вкладка/приложение открыты, плюс сохраняется в истории на потом).
// Это не то же самое, что системный push, который будит закрытое
// приложение — для этого нужен сервер с приватным VAPID-ключом
// (см. js/push.js). Отправка такого push не может быть реализована
// только клиентским кодом без риска дать любому возможность слать
// поддельные push кому угодно.

import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./auth.js";

const bellBtn = document.getElementById("notifications-bell-btn");
const unreadBadge = document.getElementById("notifications-unread-badge");
const modal = document.getElementById("notifications-modal");
const closeBtn = document.getElementById("notifications-close");
const listEl = document.getElementById("notifications-list");
const emptyEl = document.getElementById("notifications-empty");

let realtimeChannel = null;
let cache = [];

export function initNotifications() {
  loadNotifications();
  subscribeRealtime();
}

export function teardownNotifications() {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel = null;
  cache = [];
  updateBadge();
}

bellBtn.addEventListener("click", () => {
  modal.classList.remove("hidden");
  loadNotifications();
});
closeBtn.addEventListener("click", () => modal.classList.add("hidden"));
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.add("hidden");
});

async function loadNotifications() {
  const me = getCurrentUser();
  if (!me) return;

  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .or(`recipient_id.eq.${me.id},recipient_id.is.null`)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("[Notifications] не удалось загрузить уведомления:", error);
    emptyEl.textContent = `Не удалось загрузить: ${error.message}. Проверьте таблицу "notifications" (sql/04_notifications.sql).`;
    emptyEl.classList.remove("hidden");
    listEl.innerHTML = "";
    return;
  }

  cache = data || [];
  renderList();
  updateBadge();
}

function renderList() {
  emptyEl.classList.toggle("hidden", cache.length > 0);
  listEl.innerHTML = "";

  cache.forEach((n) => {
    const li = document.createElement("li");
    li.className = "admin-user-row" + (n.read_at ? "" : " notification-row-unread");
    li.innerHTML = `
      <div class="admin-user-info">
        ${n.title ? `<div class="admin-user-name">${escapeHtml(n.title)}</div>` : ""}
        ${n.content ? `<div class="admin-user-login">${escapeHtml(n.content)}</div>` : ""}
        <div class="admin-user-login">${new Date(n.created_at).toLocaleString("ru-RU")}</div>
        ${n.link ? `<a href="${escapeHtml(n.link)}" target="_blank" rel="noopener" class="broadcast-preview-link">${escapeHtml(n.link)}</a>` : ""}
      </div>
    `;
    li.addEventListener("click", () => markRead(n));
    listEl.appendChild(li);
  });
}

async function markRead(n) {
  if (n.read_at) return;
  n.read_at = new Date().toISOString();
  renderList();
  updateBadge();

  const { error } = await supabase.from("notifications").update({ read_at: n.read_at }).eq("id", n.id);
  if (error) console.warn("[Notifications] не удалось отметить прочитанным:", error.message);
}

function updateBadge() {
  const unread = cache.filter((n) => !n.read_at).length;
  unreadBadge.textContent = unread > 9 ? "9+" : String(unread);
  unreadBadge.classList.toggle("hidden", unread === 0);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/** Живая доставка: новое уведомление сразу появляется в счётчике без перезагрузки. */
function subscribeRealtime() {
  const me = getCurrentUser();
  if (!me) return;

  realtimeChannel = supabase
    .channel(`notifications-${me.id}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "notifications" },
      (payload) => {
        const n = payload.new;
        if (n.recipient_id !== me.id && n.recipient_id !== null) return;
        cache.unshift(n);
        updateBadge();
      }
    )
    .subscribe();
}
