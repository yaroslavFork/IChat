// js/attachments.js
// Загрузка вложений (фото, видео, документы) в Supabase Storage и отправка
// сообщения со ссылкой на файл.
//
// ТРЕБУЕТСЯ: публичный bucket в Supabase Storage с именем "ichat-media"
// (Storage → Create bucket → Public). Дополнительно в таблице `messages`
// нужны колонки: file_url text, file_name text, file_size int8.

import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./auth.js";
import { getActiveChatId } from "./chat-view.js";

const BUCKET = "ichat-media";

const attachBtn = document.getElementById("attach-btn");
const fileInput = document.getElementById("file-input");
const composer = document.querySelector(".composer");

attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = ""; // сброс, чтобы повторный выбор того же файла тоже сработал
  if (!file) return;
  await uploadAndSend(file);
});

/**
 * Сжимает изображение перед загрузкой: уменьшает до максимум 1600px по
 * длинной стороне и перекодирует в JPEG с качеством 0.82. Это не влияет
 * на визуальное качество в интерфейсе (сообщения и так показывают фото
 * уменьшенным), но на мобильном интернете экономит секунды на каждой
 * отправке — фото с современных камер весят по 3-8 МБ, сжатая версия
 * обычно укладывается в 200-500 КБ.
 * Если что-то пошло не так (например, HEIC/формат, который canvas не
 * умеет декодировать в этом браузере) — просто отдаём исходный файл,
 * чтобы не блокировать отправку.
 */
async function compressImage(file, maxDimension = 1600, quality = 0.82) {
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
    if (!blob || blob.size >= file.size) return file; // сжатие не помогло — используем оригинал

    return new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" });
  } catch (e) {
    console.warn("[Attachments] не удалось сжать изображение, отправляю оригинал:", e);
    return file;
  }
}

function detectType(file) {
  if (file.type.startsWith("image/")) return "photo";
  if (file.type.startsWith("video/")) return "video";
  return "document";
}

function showUploadingState(isUploading) {
  composer.classList.toggle("uploading", isUploading);
  attachBtn.disabled = isUploading;
}

async function uploadAndSend(file) {
  const chatId = getActiveChatId();
  const me = getCurrentUser();
  if (!chatId || !me) return;

  showUploadingState(true);

  try {
    const type = detectType(file);

    // Сжимаем фотографии перед загрузкой — на мобильном интернете фото
    // с камеры телефона (часто 3-8 МБ) заметно тормозили отправку.
    // Видео/документы/голосовые не трогаем: пережатие видео в браузере
    // без тяжёлых библиотек (ffmpeg.wasm и т.п.) не даёт надёжного
    // результата, а голосовые уже ограничены по битрейту при записи
    // (см. js/voice.js) — сжимать их повторно смысла нет.
    const uploadFile = type === "photo" ? await compressImage(file) : file;

    const safeName = file.name.replace(/[^\w.\-]+/g, "_");
    const path = `${chatId}/${Date.now()}_${safeName}`;

    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, uploadFile, {
      cacheControl: "3600",
      upsert: false,
    });

    if (uploadError) {
      console.error("[Attachments] Supabase Storage upload error:", uploadError);
      const parts = [
        uploadError.message || "Неизвестная ошибка",
        uploadError.statusCode ? `код: ${uploadError.statusCode}` : null,
        uploadError.error ? `тип: ${uploadError.error}` : null,
      ].filter(Boolean);
      alert(
        `Не удалось загрузить файл: ${parts.join(" · ")}\n\n` +
        `Если ошибка про "row-level security" или "Unauthorized" — значит на bucket "ichat-media" ` +
        `не хватает Storage Policy на INSERT для роли anon (публичность бакета разрешает только чтение).`
      );
      return;
    }

    const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(path);

    const { error: insertError } = await supabase.from("messages").insert({
      chat_id: chatId,
      sender_id: me.id,
      content: "",
      type,
      status: "sent",
      file_url: publicUrlData.publicUrl,
      file_name: file.name,
      file_size: uploadFile.size,
    });

    if (insertError) {
      console.warn("[Attachments] не удалось создать сообщение:", insertError.message);
    }
  } finally {
    showUploadingState(false);
  }
}
