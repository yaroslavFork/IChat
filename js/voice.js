// js/voice.js
// Запись голосовых сообщений через MediaRecorder API, загрузка в Supabase
// Storage и отправка сообщения типа "voice" с длительностью записи.
//
// ТРЕБУЕТСЯ: тот же публичный bucket "ichat-media", что и для вложений,
// а в таблице `messages` — колонка duration numeric (секунды).

import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./auth.js";
import { getActiveChatId } from "./chat-view.js";

const BUCKET = "ichat-media";

const voiceBtn = document.getElementById("voice-btn");
const composer = document.querySelector(".composer");
const messageInput = document.getElementById("message-input");

let mediaRecorder = null;
let recordedChunks = [];
let recordStartTime = 0;
let recordingIndicatorEl = null;
let stream = null;

voiceBtn.onclick = () => startRecording();

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert("Запись голосовых сообщений не поддерживается этим браузером.");
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert("Нужен доступ к микрофону, чтобы записать голосовое сообщение.");
    return;
  }

  recordedChunks = [];
  // audioBitsPerSecond ограничивает битрейт записи: для голоса 32kbps
  // более чем достаточно (речь разборчива), а вес файла в разы меньше
  // дефолтного битрейта браузера — заметно на мобильном интернете,
  // особенно для длинных голосовых.
  mediaRecorder = new MediaRecorder(stream, { audioBitsPerSecond: 32000 });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = handleRecordingStop;

  mediaRecorder.start();
  recordStartTime = Date.now();
  showRecordingUI(true);
}

function stopRecording(cancelled) {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  mediaRecorder._cancelled = cancelled;
  mediaRecorder.stop();
  stream?.getTracks().forEach((t) => t.stop());
}

async function handleRecordingStop() {
  showRecordingUI(false);
  const cancelled = mediaRecorder._cancelled;
  const durationSec = (Date.now() - recordStartTime) / 1000;

  if (cancelled || durationSec < 0.6 || recordedChunks.length === 0) {
    recordedChunks = [];
    return;
  }

  const blob = new Blob(recordedChunks, { type: "audio/webm" });
  recordedChunks = [];
  await uploadAndSendVoice(blob, durationSec);
}

async function uploadAndSendVoice(blob, durationSec) {
  const chatId = getActiveChatId();
  const me = getCurrentUser();
  if (!chatId || !me) return;

  const path = `${chatId}/voice_${Date.now()}.webm`;

  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: "audio/webm",
    cacheControl: "3600",
    upsert: false,
  });

  if (uploadError) {
    console.error("[Voice] Supabase Storage upload error:", uploadError);
    const parts = [
      uploadError.message || "Неизвестная ошибка",
      uploadError.statusCode ? `код: ${uploadError.statusCode}` : null,
    ].filter(Boolean);
    alert(
      `Не удалось отправить голосовое: ${parts.join(" · ")}\n\n` +
      `Если ошибка про "row-level security" или "Unauthorized" — на bucket "ichat-media" ` +
      `не хватает Storage Policy на INSERT для роли anon.`
    );
    return;
  }

  const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(path);

  const { error: insertError } = await supabase.from("messages").insert({
    chat_id: chatId,
    sender_id: me.id,
    content: "",
    type: "voice",
    status: "sent",
    file_url: publicUrlData.publicUrl,
    duration: Math.round(durationSec),
  });

  if (insertError) {
    console.warn("[Voice] не удалось создать сообщение:", insertError.message);
  }
}

/* === UI записи: замена композера на индикатор с таймером и кнопкой отмены === */
function showRecordingUI(isRecording) {
  if (isRecording) {
    recordingIndicatorEl = document.createElement("div");
    recordingIndicatorEl.className = "recording-indicator";
    recordingIndicatorEl.innerHTML = `
      <span class="recording-dot"></span>
      <span class="recording-time">0:00</span>
      <span style="flex:1"></span>
      <button type="button" class="recording-cancel">Отмена</button>
    `;
    messageInput.parentElement.classList.add("hidden");
    composer.insertBefore(recordingIndicatorEl, voiceBtn);

    const timeEl = recordingIndicatorEl.querySelector(".recording-time");
    const cancelBtn = recordingIndicatorEl.querySelector(".recording-cancel");

    const tick = () => {
      if (!mediaRecorder || mediaRecorder.state !== "recording") return;
      const sec = Math.floor((Date.now() - recordStartTime) / 1000);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      timeEl.textContent = `${m}:${s.toString().padStart(2, "0")}`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    cancelBtn.addEventListener("click", () => stopRecording(true));

    // Повторный тап по кнопке микрофона завершает запись и отправляет голосовое.
    voiceBtn.classList.add("recording-active");
    voiceBtn.onclick = () => stopRecording(false);
  } else {
    recordingIndicatorEl?.remove();
    recordingIndicatorEl = null;
    messageInput.parentElement.classList.remove("hidden");
    voiceBtn.classList.remove("recording-active");
    voiceBtn.onclick = () => startRecording();
  }
}
