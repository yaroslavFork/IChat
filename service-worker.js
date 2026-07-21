// service-worker.js — офлайн-кэш и обработка push-уведомлений для IChat

const CACHE_NAME = "ichat-cache-v1.9.0";

// Статические ресурсы оболочки приложения (App Shell), кэшируются при установке.
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/config.js",
  "./js/app.js",
  "./js/auth.js",
  "./js/supabase-client.js",
  "./js/chats.js",
  "./js/chat-view.js",
  "./js/new-chat.js",
  "./js/attachments.js",
  "./js/voice.js",
  "./js/profile.js",
  "./js/badges.js",
  "./js/badge-info.js",
  "./js/admin.js",
  "./js/mod-log.js",
  "./js/notifications.js",
  "./js/groups.js",
  "./js/calls.js",
  "./js/push.js",
  "./icons/icon-192.png",
  "./icons/ui/icon-admin.svg",
  "./icons/ui/icon-call-end.svg",
  "./icons/ui/icon-call.svg",
  "./icons/ui/icon-camera-off.svg",
  "./icons/ui/icon-camera.svg",
  "./icons/ui/icon-delete.svg",
  "./icons/ui/icon-document.svg",
  "./icons/ui/icon-download.svg",
  "./icons/ui/icon-file.svg",
  "./icons/ui/icon-mic-off.svg",
  "./icons/ui/icon-mic.svg",
  "./icons/ui/icon-notifications.svg",
  "./icons/ui/icon-pause.svg",
  "./icons/ui/icon-photo.svg",
  "./icons/ui/icon-pin.svg",
  "./icons/ui/icon-play.svg",
  "./icons/ui/icon-question.svg",
  "./icons/ui/icon-menu-dots.svg",
  "./icons/ui/icon-check.svg",
  "./icons/ui/icon-check-single.svg",
  "./icons/ui/icon-check-double.svg",
  "./icons/ui/icon-record.svg",
  "./icons/ui/icon-report.svg",
  "./icons/ui/icon-search.svg",
  "./icons/ui/icon-settings.svg",
  "./icons/ui/icon-upload.svg",
  "./icons/ui/icon-video-call.svg",
  "./icons/ui/icon-video.svg",
  "./icons/badges/icon-badge-black.svg",
  "./icons/badges/icon-badge-blue.svg",
  "./icons/badges/icon-badge-gold.svg",
  "./icons/badges/icon-badge-green.svg",
  "./icons/badges/icon-badge-purple.svg",
  "./icons/badges/icon-badge-red.svg",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        // Не роняем установку, если какой-то файл ещё не создан на этом этапе разработки
        console.warn("[SW] precache warning:", err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Стратегия: network-first для Supabase API/Realtime (всегда свежие данные),
// cache-first для статики приложения (быстрая загрузка + офлайн).
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") return;

  // Не кэшируем запросы к Supabase — данные должны быть всегда актуальны
  if (url.hostname.endsWith("supabase.co")) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: "offline" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === "basic") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          if (request.mode === "navigate") {
            return caches.match("./index.html");
          }
          return new Response("", { status: 408, statusText: "offline" });
        });
    })
  );
});

// === Push-уведомления ===
self.addEventListener("push", (event) => {
  let payload = { title: "IChat", body: "Новое уведомление", tag: "ichat-generic" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (e) {
    /* payload не JSON — используем значения по умолчанию */
  }

  const options = {
    body: payload.body,
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: payload.tag,
    data: payload.data || {},
    vibrate: [80, 40, 80],
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "./index.html";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.includes(location.origin));
      if (existing) {
        existing.focus();
        existing.navigate(targetUrl);
        return;
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
