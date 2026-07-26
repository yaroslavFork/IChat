// js/supabase-client.js
// Единый экземпляр Supabase-клиента для всего приложения.
// Официальный SDK подключается как ES-модуль с CDN (не является UI-фреймворком/библиотекой компонентов).
//
// УСТОЙЧИВОСТЬ К СБОЯМ CDN: раньше SDK грузился одним статическим
// импортом с esm.sh без какого-либо запасного варианта. Если этот
// импорт не проходил (нестабильный мобильный интернет, блокировка
// сети, временная недоступность CDN) — вся цепочка ES-модулей молча
// переставала выполняться целиком, и приложение оставалось перед
// пустым экраном без единого объяснения. Теперь пробуем основной CDN,
// а при неудаче — резервный (другой провайдер, jsdelivr). Top-level
// await здесь распространяет ожидание на все модули, которые
// импортируют supabase-client.js, само по себе, без необходимости
// что-либо менять в остальных файлах проекта.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

let createClient;
try {
  ({ createClient } = await import("https://esm.sh/@supabase/supabase-js@2"));
} catch (primaryError) {
  console.warn("[Supabase] основной CDN (esm.sh) недоступен, пробую резервный (jsdelivr):", primaryError);
  try {
    ({ createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"));
  } catch (fallbackError) {
    console.error("[Supabase] резервный CDN тоже недоступен:", fallbackError);
    throw fallbackError; // приложение не может работать без SDK — сторожевой скрипт в index.html покажет понятную ошибку
  }
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // Свою авторизацию по логину/паролю храним вручную в localStorage,
    // встроенный Supabase Auth не используем.
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  realtime: {
    params: { eventsPerSecond: 10 },
  },
});

/**
 * Небольшая обёртка для единообразной обработки ошибок Supabase-запросов.
 * Возвращает { data, error } как и обычный вызов, но пишет предупреждение в консоль.
 */
export async function safeQuery(promise) {
  const { data, error } = await promise;
  if (error) {
    console.warn("[Supabase] запрос завершился с ошибкой:", error.message);
  }
  return { data, error };
}
