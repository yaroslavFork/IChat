// js/app.js
// Точка входа IChat: инициализация приложения, переключение экранов,
// обработка формы входа, регистрация service worker.

import { restoreSession, login, logout, getCurrentUser } from "./auth.js";
import { supabase } from "./supabase-client.js";
import { initChatList, teardownChatList } from "./chats.js";
import "./chat-view.js";
import "./new-chat.js";
import "./attachments.js";
import "./voice.js";
import "./profile.js";
import "./badge-info.js";
import "./admin.js";
import "./groups.js";
import { initIncomingCallListener, teardownIncomingCallListener } from "./calls.js";
import "./push.js";
import { initNotifications, teardownNotifications } from "./notifications.js";

const splashScreen = document.getElementById("splash-screen");
const authScreen = document.getElementById("auth-screen");
const appRoot = document.getElementById("app-root");

const authForm = document.getElementById("auth-form");
const loginInput = document.getElementById("login-input");
const passwordInput = document.getElementById("password-input");
const authError = document.getElementById("auth-error");
const authSubmit = document.getElementById("auth-submit");
const togglePasswordBtn = document.getElementById("toggle-password-btn");

togglePasswordBtn.addEventListener("click", () => {
  const showing = passwordInput.type === "text";
  passwordInput.type = showing ? "password" : "text";
  togglePasswordBtn.classList.toggle("showing", !showing);
  togglePasswordBtn.setAttribute("aria-label", showing ? "Показать пароль" : "Скрыть пароль");
  passwordInput.focus({ preventScroll: true });
});

const myAvatar = document.getElementById("my-avatar");

const DEFAULT_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#3A3A3C"/><text x="32" y="40" font-size="26" fill="#98989D" text-anchor="middle" font-family="-apple-system,sans-serif">?</text></svg>`
  );

function showAuthScreen() {
  authScreen.classList.remove("hidden");
  appRoot.classList.add("hidden");
}

function showApp(user) {
  // Сначала гарантированно показываем сам экран — это не должно зависеть
  // от того, успешно ли отработают под-модули ниже.
  authScreen.classList.add("hidden");
  appRoot.classList.remove("hidden");
  myAvatar.src = user.avatar_url || DEFAULT_AVATAR;
  myAvatar.alt = user.name || user.username || "";

  // Каждый под-модуль инициализируем отдельно: если один из них упадёт
  // (например, из-за отсутствующей таблицы в Supabase), это не должно
  // ломать остальные и уж тем более не должно оставлять пользователя
  // перед пустым экраном — сам список чатов к этому моменту уже показан.
  try {
    initChatList(user);
  } catch (err) {
    console.error("[App] ошибка инициализации списка чатов:", err);
  }
  try {
    initIncomingCallListener();
  } catch (err) {
    console.error("[App] ошибка инициализации звонков:", err);
  }
  try {
    initNotifications();
  } catch (err) {
    console.error("[App] ошибка инициализации уведомлений:", err);
  }
}

function hideSplash() {
  // Ждём завершения css-анимации, затем убираем узел из потока полностью
  setTimeout(() => splashScreen.classList.add("hidden"), 700);
}

function setAuthLoading(isLoading) {
  authSubmit.disabled = isLoading;
  authSubmit.innerHTML = isLoading
    ? '<span class="spinner"></span>'
    : '<span class="btn-label">Войти</span>';
}

function showAuthError(message) {
  authError.textContent = message;
  authError.classList.toggle("hidden", !message);
}

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("");
  setAuthLoading(true);

  const { user, error } = await login(loginInput.value, passwordInput.value);

  setAuthLoading(false);

  if (error || !user) {
    showAuthError(error || "Не удалось войти");
    return;
  }

  passwordInput.value = "";
  showApp(user);
});

// Кнопка "Выйти" будет добавлена на экране профиля (следующие файлы),
// здесь заранее объявляем обработчик, который экран профиля сможет переиспользовать.
export async function handleLogoutClick() {
  const me = getCurrentUser();
  if (me?.role === "admin") {
    supabase
      .from("moderation_log")
      .insert({ admin_id: me.id, action: "admin_logout", details: `Выход администратора @${me.username}` })
      .then(({ error }) => {
        if (error) console.warn("[App] не удалось записать выход в журнал:", error.message);
      });
  }
  teardownChatList();
  teardownIncomingCallListener();
  teardownNotifications();
  await logout();
  showAuthScreen();
}

async function bootstrap() {
  // Регистрируем service worker (офлайн-кэш, push-уведомления)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch((err) => {
      console.warn("[SW] регистрация не удалась:", err);
    });

    // Как только активируется новая версия service worker (после редеплоя), сразу
    // перезагружаем страницу один раз — иначе браузер может показывать старую
    // закэшированную версию, пока пользователь не обновит страницу вручную.
    //
    // ВАЖНО (исправленный баг): раньше здесь была обычная переменная
    // `let reloadedForUpdate = false`, которая обнуляется при каждой
    // перезагрузке страницы — то есть если controllerchange срабатывал
    // повторно после reload по любой причине, защита от повторного
    // срабатывания не работала вообще, и получался бесконечный цикл
    // "загрузка → перезагрузка → загрузка → перезагрузка", который
    // выглядит как "мелькнула главная и тут же перезагрузка", а иногда
    // страница даже не успевает нормально доинициализироваться и
    // остаётся пустой/серой. sessionStorage переживает reload и
    // гарантирует не больше одной автоперезагрузки за вкладку.
    //
    // Второй исправленный момент: controllerchange срабатывает даже при
    // самом первом визите (переход от "нет активного SW" к "есть") — то
    // есть раньше перезагрузка происходила лишний раз для КАЖДОГО нового
    // посетителя, хотя обновлять было ещё нечего. Теперь реагируем только
    // если до регистрации уже был активный контроллер (значит это
    // повторный визит и реально вышло обновление).
    const hadControllerBefore = !!navigator.serviceWorker.controller;

    if (hadControllerBefore) {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (sessionStorage.getItem("ichat_sw_reloaded")) return;
        sessionStorage.setItem("ichat_sw_reloaded", "1");
        window.location.reload();
      });
    }
  }

  // try/catch здесь принципиален: splash-экран исчезает по чистой CSS-анимации
  // (1.6с) независимо от того, успешно ли отработал JS. Если restoreSession()
  // упадёт необработанной ошибкой — ни экран входа, ни главный экран не
  // покажутся, а splash всё равно скроется сам, оставив голый фон body
  // (тёмно-графитовый — воспринимается как "просто серый экран"). Поэтому
  // при любой ошибке гарантированно показываем хотя бы экран входа.
  let user = null;
  try {
    user = await restoreSession();
  } catch (err) {
    console.error("[App] ошибка при восстановлении сессии:", err);
  }

  if (user) {
    showApp(user);
  } else {
    showAuthScreen();
  }

  hideSplash();
}

bootstrap();

// На случай, если другим модулям понадобится быстрый доступ к текущему пользователю
export { getCurrentUser };
