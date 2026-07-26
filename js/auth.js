// js/auth.js
// Авторизация через существующую таблицу `users` (логин + пароль в открытом виде).
// Supabase Auth не используется. Сессия хранится в localStorage и восстанавливается
// автоматически при повторном открытии сайта.

import { supabase } from "./supabase-client.js";
import { SESSION_KEY } from "./config.js";

let currentUser = null;

/**
 * Формирует человекочитаемое сообщение о блокировке для показа пользователю:
 * причина (если указана) и срок окончания (или "навсегда").
 */
function formatBlockMessage(user) {
  const parts = ["Аккаунт заблокирован."];
  if (user.block_reason) parts.push(`Причина: ${user.block_reason}.`);
  parts.push(
    user.blocked_until
      ? `Блокировка действует до ${new Date(user.blocked_until).toLocaleString("ru-RU")}.`
      : "Блокировка бессрочная."
  );
  return parts.join(" ");
}

/**
 * Если срок блокировки (blocked_until) уже прошёл — снимает блокировку в БД
 * и возвращает false (пользователь больше не заблокирован).
 * Если блокировка ещё активна (или бессрочная) — возвращает true.
 */
async function checkAndMaybeAutoUnblock(user) {
  if (!user.blocked_until) return true; // бессрочная блокировка — остаётся в силе

  const stillActive = new Date(user.blocked_until).getTime() > Date.now();
  if (stillActive) return true;

  // Срок истёк — снимаем блокировку автоматически.
  await supabase
    .from("users")
    .update({ blocked: false, block_reason: null, block_comment: null, blocked_until: null })
    .eq("id", user.id);

  user.blocked = false;
  return false;
}

/** Возвращает объект текущего пользователя (или null, если не авторизован). */
export function getCurrentUser() {
  return currentUser;
}

/** Сохраняет пользователя в памяти + localStorage (сессия). */
function persistSession(user) {
  currentUser = user;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ id: user.id, username: user.username }));
  } catch (e) {
    console.warn("[Auth] не удалось сохранить сессию:", e);
  }
}

/** Полностью очищает сессию. */
export function clearSession() {
  currentUser = null;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (e) {
    /* игнорируем */
  }
}

/**
 * Пытается восстановить сессию из localStorage при загрузке приложения.
 * Если пользователь есть в БД и не заблокирован — считаем сессию валидной.
 * Возвращает пользователя или null.
 */
export async function restoreSession() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch (e) {
    saved = null;
  }
  if (!saved || !saved.id) return null;

  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("id", saved.id)
    .maybeSingle();

  if (error || !data) {
    if (error) console.error("[Auth] Supabase error on restoreSession:", error);
    clearSession();
    return null;
  }
  if (data.blocked) {
    const stillBlocked = await checkAndMaybeAutoUnblock(data);
    if (stillBlocked) {
      clearSession();
      return null;
    }
  }

  currentUser = data;
  await touchOnlineStatus(true);
  return data;
}

/**
 * Вход по логину и паролю. Пароль сравнивается как обычный текст (по ТЗ проекта).
 * Возвращает { user, error } — при ошибке user равен null, error содержит текст для UI.
 */
export async function login(loginValue, passwordValue) {
  const cleanLogin = (loginValue || "").trim();
  const cleanPassword = passwordValue || "";

  if (!cleanLogin || !cleanPassword) {
    return { user: null, error: "Введите логин и пароль" };
  }

  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("username", cleanLogin)
    .maybeSingle();

  if (error) {
    console.error("[Auth] Supabase error on login:", error);
    const parts = [
      error.message || "Неизвестная ошибка",
      error.code ? `код: ${error.code}` : null,
      error.status ? `статус: ${error.status}` : null,
    ].filter(Boolean);
    return { user: null, error: parts.join(" · ") };
  }
  if (!data || data.password !== cleanPassword) {
    return { user: null, error: "Неверный логин или пароль" };
  }
  if (data.blocked) {
    const stillBlocked = await checkAndMaybeAutoUnblock(data);
    if (stillBlocked) {
      return { user: null, error: formatBlockMessage(data) };
    }
  }

  persistSession(data);
  await touchOnlineStatus(true);

  if (data.role === "admin") {
    supabase
      .from("moderation_log")
      .insert({ admin_id: data.id, action: "admin_login", details: `Вход администратора @${data.username}` })
      .then(({ error }) => {
        if (error) console.warn("[Auth] не удалось записать вход в журнал:", error.message);
      });
  }

  return { user: data, error: null };
}

/** Выход из аккаунта: очищаем сессию и статус "онлайн". */
export async function logout() {
  if (currentUser) {
    await touchOnlineStatus(false);
  }
  clearSession();
}

/** Обновляет статус онлайн/оффлайн и время последнего визита текущего пользователя. */
export async function touchOnlineStatus(isOnline) {
  if (!currentUser) return;
  try {
    await supabase
      .from("users")
      .update({ online: isOnline, last_seen: new Date().toISOString() })
      .eq("id", currentUser.id);
  } catch (e) {
    console.warn("[Auth] не удалось обновить онлайн-статус:", e);
  }
}

// Отмечаем пользователя оффлайн при закрытии/сворачивании вкладки.
// pagehide надёжнее beforeunload на мобильных браузерах (Safari/Chrome iOS
// не всегда гарантированно вызывают beforeunload при закрытии вкладки/свайпе).
// sendBeacon здесь не подходит: он всегда шлёт POST без возможности задать
// заголовок apikey, а Supabase REST для UPDATE требует PATCH + apikey —
// без них запрос получил бы 401 и просто не сработал бы. fetch с
// keepalive: true — единственный способ отправить полноценный
// авторизованный запрос при выгрузке страницы.
window.addEventListener("pagehide", () => {
  if (!currentUser) return;
  try {
    fetch(`${supabase.supabaseUrl}/rest/v1/users?id=eq.${currentUser.id}`, {
      method: "PATCH",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        apikey: supabase.supabaseKey,
        Authorization: `Bearer ${supabase.supabaseKey}`,
      },
      body: JSON.stringify({ online: false, last_seen: new Date().toISOString() }),
    });
  } catch (e) {
    /* лучшее из возможного при выгрузке страницы — не гарантия на 100% */
  }
});
