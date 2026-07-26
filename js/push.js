// js/push.js
// Подписка на push-уведомления (Web Push API) на стороне клиента.
//
// ВАЖНО: этот файл только ПОДПИСЫВАЕТ устройство и сохраняет подписку в базу.
// Чтобы уведомления реально приходили (новые сообщения, звонки, объявления),
// нужен ещё сервер, который будет слать push по сохранённым подпискам —
// это не может делать статический сайт на GitHub Pages. Подходящее место —
// Supabase Edge Function, вызываемая из database trigger при INSERT в
// `messages`/`calls`/`announcements` (см. docs/RLS-GUIDE.md и
// ecosystem-security/SECURITY-REFACTOR.md про серверную часть экосистемы).
//
// ОЖИДАЕМАЯ СХЕМА: таблица `push_subscriptions`
//   (id, user_id, endpoint text, subscription jsonb, created_at)

import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./auth.js";
import { VAPID_PUBLIC_KEY } from "./config.js";

const notificationsBtn = document.getElementById("profile-notifications-btn");

document.addEventListener("ichat:profile-rendered", (e) => {
  if (!e.detail?.isOwn) {
    notificationsBtn.classList.add("hidden");
    return;
  }
  notificationsBtn.classList.remove("hidden");
  updateButtonLabel();
});

notificationsBtn.addEventListener("click", async () => {
  if (Notification.permission === "granted") {
    await unsubscribe();
  } else {
    await subscribe();
  }
  updateButtonLabel();
});

function updateButtonLabel() {
  const granted = "Notification" in window && Notification.permission === "granted";
  const label = granted ? "Отключить уведомления" : "Включить уведомления";
  notificationsBtn.innerHTML = `<span class="svg-icon svg-notifications" style="width:17px;height:17px;vertical-align:-3px;margin-right:6px;"></span>${label}`;
}

async function subscribe() {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    alert("Этот браузер не поддерживает push-уведомления.");
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;

  const registration = await navigator.serviceWorker.ready;

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    } catch (e) {
      console.error("[Push] pushManager.subscribe() error:", e);
      alert(`Не удалось подписаться на уведомления: ${e.message || e.name}`);
      return;
    }
  }

  const me = getCurrentUser();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: me.id,
      endpoint: subscription.endpoint,
      subscription: subscription.toJSON(),
    },
    { onConflict: "endpoint" }
  );

  if (error) {
    console.error("[Push] не удалось сохранить подписку:", error);
    alert(`Не удалось сохранить подписку: ${error.message}. Проверьте, что таблица "push_subscriptions" существует (sql/00_create_tables.sql).`);
  }
}

async function unsubscribe() {
  if (!("serviceWorker" in navigator)) return;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();

  await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
}

/** Конвертирует VAPID-ключ из base64url в Uint8Array (формат, ожидаемый Push API). */
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
