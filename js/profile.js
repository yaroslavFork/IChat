// js/profile.js
// Экран профиля: свой профиль (с редактированием) и чужой (только просмотр).
// Открывается по клику на аватар в шапке списка чатов (свой) или по клику
// на шапку экрана переписки (профиль собеседника).

import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./auth.js";
import { handleLogoutClick } from "./app.js";
import { openBadgeInfo } from "./badge-info.js";

const BUCKET = "ichat-media";

const screenChats = document.getElementById("screen-chats");
const screenChat = document.getElementById("screen-chat");
const screenProfile = document.getElementById("screen-profile");

const openProfileBtn = document.getElementById("open-profile");
const chatHeaderInfo = document.getElementById("chat-header-info");

const backBtn = document.getElementById("profile-back-btn");
const editBtn = document.getElementById("profile-edit-btn");
const saveBtn = document.getElementById("profile-save-btn");
const logoutBtn = document.getElementById("profile-logout-btn");

const avatarEl = document.getElementById("profile-avatar");
const avatarWrap = document.querySelector(".profile-avatar-wrap");
const avatarInput = document.getElementById("profile-avatar-input");

const nameHeroEl = document.getElementById("profile-name");
const badgeEl = document.getElementById("profile-badge");
const badgeInfoBtn = document.getElementById("profile-badge-info-btn");
const loginEl = document.getElementById("profile-login");
const onlineEl = document.getElementById("profile-online-status");

const bioView = document.getElementById("profile-bio-view");
const bioEdit = document.getElementById("profile-bio-edit");
const nameView = document.getElementById("profile-name-view");
const nameEdit = document.getElementById("profile-name-edit");
const idView = document.getElementById("profile-id-view");
const createdView = document.getElementById("profile-created-view");

const DEFAULT_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#3A3A3C"/><text x="32" y="40" font-size="26" fill="#98989D" text-anchor="middle" font-family="-apple-system,sans-serif">?</text></svg>`
  );

let viewedUser = null;
let isOwnProfile = false;
let cameFromScreen = null;
let isEditing = false;

openProfileBtn.addEventListener("click", () => openProfile(getCurrentUser().id, screenChats));
chatHeaderInfo.addEventListener("click", () => {
  if (window.__ichatActiveOtherUserId) {
    openProfile(window.__ichatActiveOtherUserId, screenChat);
  }
});

backBtn.addEventListener("click", closeProfile);
editBtn.addEventListener("click", () => setEditing(true));
saveBtn.addEventListener("click", saveProfile);
logoutBtn.addEventListener("click", handleLogoutClick);
avatarInput.addEventListener("change", handleAvatarChange);

async function openProfile(userId, fromScreen) {
  const me = getCurrentUser();
  isOwnProfile = userId === me.id;
  cameFromScreen = fromScreen;

  const { data } = await supabase.from("users").select("*").eq("id", userId).maybeSingle();
  if (!data) return;

  viewedUser = data;
  renderProfile();
  setEditing(false);

  screenChats.classList.remove("active");
  screenChat.classList.remove("active");
  screenProfile.classList.add("active");
}

function closeProfile() {
  screenProfile.classList.remove("active");
  (cameFromScreen || screenChats).classList.add("active");
  setEditing(false);
}

function renderProfile() {
  const u = viewedUser;

  avatarEl.src = u.avatar_url || DEFAULT_AVATAR;
  nameHeroEl.textContent = u.name || u.username || "Без имени";
  loginEl.textContent = "@" + (u.username || "");
  onlineEl.textContent = u.online ? "в сети" : u.last_seen ? "был(а) " + formatDate(u.last_seen) : "";

  renderBadge(u.verified_badge);

  bioView.textContent = u.bio || "Не указано";
  nameView.textContent = u.name || u.username || "";
  idView.textContent = u.id;
  createdView.textContent = u.created_at ? formatDate(u.created_at) : "—";

  bioEdit.value = u.bio || "";
  nameEdit.value = u.name || "";

  editBtn.classList.toggle("hidden", !isOwnProfile);
  logoutBtn.classList.toggle("hidden", !isOwnProfile);
  avatarWrap.classList.toggle("editable", isOwnProfile);

  document.dispatchEvent(
    new CustomEvent("ichat:profile-rendered", { detail: { role: u.role, isOwn: isOwnProfile } })
  );
}

function renderBadge(badge) {
  if (!badge || badge === "none") {
    badgeEl.classList.add("hidden");
    badgeInfoBtn.classList.add("hidden");
    return;
  }
  badgeEl.src = `icons/badges/icon-badge-${badge}.svg`;
  badgeEl.className = "profile-badge";
  badgeEl.classList.remove("hidden");
  badgeInfoBtn.classList.remove("hidden");
  badgeInfoBtn.onclick = () => openBadgeInfo(badge);
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" });
}

function setEditing(editing) {
  isEditing = editing && isOwnProfile;

  bioView.classList.toggle("hidden", isEditing);
  bioEdit.classList.toggle("hidden", !isEditing);
  nameView.classList.toggle("hidden", isEditing);
  nameEdit.classList.toggle("hidden", !isEditing);
  saveBtn.classList.toggle("hidden", !isEditing);
  editBtn.classList.toggle("hidden", isEditing || !isOwnProfile);

  if (isEditing) {
    avatarWrap.onclick = () => avatarInput.click();
  } else {
    avatarWrap.onclick = null;
  }
}

async function saveProfile() {
  if (!isOwnProfile || !viewedUser) return;

  const updates = {
    name: nameEdit.value.trim(),
    bio: bioEdit.value.trim(),
  };

  const { data, error } = await supabase
    .from("users")
    .update(updates)
    .eq("id", viewedUser.id)
    .select()
    .single();

  if (error) {
    console.warn("[Profile] не удалось сохранить профиль:", error.message);
    return;
  }

  viewedUser = data;
  renderProfile();
  setEditing(false);

  // Обновляем аватар в шапке списка чатов, если он виден
  const myAvatar = document.getElementById("my-avatar");
  if (myAvatar) myAvatar.src = data.avatar_url || DEFAULT_AVATAR;
}

/** Сжимает аватар до 400px по длинной стороне, JPEG качество 0.85 — та же логика, что и для фото в чате (js/attachments.js), продублирована здесь намеренно: модули не имеют общих зависимостей друг от друга по дизайну проекта. */
async function compressAvatarImage(file, maxDimension = 400, quality = 0.85) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob || blob.size >= file.size) return file;

    return new File([blob], "avatar.jpg", { type: "image/jpeg" });
  } catch (e) {
    console.warn("[Profile] не удалось сжать аватар, отправляю оригинал:", e);
    return file;
  }
}

async function handleAvatarChange() {
  const file = avatarInput.files?.[0];
  avatarInput.value = "";
  if (!file || !viewedUser) return;

  // Аватар в интерфейсе показывается максимум ~110px — небольшой размер
  // (400px) с запасом на retina-экраны экономит трафик при каждой смене
  // фото профиля на мобильном интернете.
  const compressed = await compressAvatarImage(file);

  const path = `avatars/${viewedUser.id}_${Date.now()}.jpg`;

  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, compressed, {
    cacheControl: "3600",
    upsert: true,
  });

  if (uploadError) {
    console.error("[Profile] Supabase Storage upload error:", uploadError);
    const parts = [
      uploadError.message || "Неизвестная ошибка",
      uploadError.statusCode ? `код: ${uploadError.statusCode}` : null,
    ].filter(Boolean);
    alert(
      `Не удалось загрузить фото: ${parts.join(" · ")}\n\n` +
      `Если ошибка про "row-level security" или "Unauthorized" — на bucket "ichat-media" ` +
      `не хватает Storage Policy на INSERT/UPDATE для роли anon.`
    );
    return;
  }

  const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(path);

  const { data, error } = await supabase
    .from("users")
    .update({ avatar_url: publicUrlData.publicUrl })
    .eq("id", viewedUser.id)
    .select()
    .single();

  if (error) {
    console.warn("[Profile] не удалось сохранить ссылку на аватар:", error.message);
    return;
  }

  viewedUser = data;
  renderProfile();

  const myAvatar = document.getElementById("my-avatar");
  if (myAvatar) myAvatar.src = data.avatar_url || DEFAULT_AVATAR;
}
