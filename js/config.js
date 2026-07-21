// js/config.js
// Единая точка конфигурации проекта IChat.
// Все остальные модули импортируют SUPABASE_URL и SUPABASE_ANON_KEY только отсюда.

export const SUPABASE_URL = "https://monyjcyypnqknrzzxjej.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vbnlqY3l5cG5xa25yenp4amVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxNTIyMTQsImV4cCI6MjA5NzcyODIxNH0.OQsb1EunHj8tXj22iGu4AJUc_DwgioAD8TnTNJ8PA9A";

// Название приложения и версия — используются в UI, PWA-манифесте и service worker для кэша.
export const APP_NAME = "IChat";
export const APP_VERSION = "1.9.0";
export const CACHE_NAME = `ichat-cache-v${APP_VERSION}`;

// Ключ localStorage, под которым хранится сессия пользователя (после входа по логину/паролю).
export const SESSION_KEY = "ichat_session";

// VAPID public key для Web Push подписки (js/push.js).
// Эта пара сгенерирована при подготовке проекта (EC P-256, стандартный
// формат Web Push). Приватный ключ НЕ хранится в этом файле и нигде в
// клиентском коде — он нужен только на сервере (Supabase Edge Function),
// который будет подписывать и отправлять push-уведомления. Секретно
// сохраните приватный ключ там, где будете разворачивать эту функцию
// (Supabase → Project Settings → Edge Functions → Secrets), и никогда
// не коммитьте его в репозиторий:
// VAPID_PRIVATE_KEY = "_sytcmwRFVF1prVhmuvwYGdeBXqL_my70zWNNAOOats"
export const VAPID_PUBLIC_KEY = "BBJf29adPMyculbBqD5T1CQMqV72xVMeYNvIYMB-YaIS2zH4X7xj850s23OrRVZ5VmmurxLT2F9yc52pRb5n8so";

// Палитра приложения (единый источник цветов, дублируется в CSS-переменных).
export const THEME = {
  bg: "#1B1C1E",
  card: "#5B5E63",
  metalLight: "#E4E8EA",
  metalDark: "#6E7278",
  text: "#FFFFFF",
  accent: "#3FCE69",
};
