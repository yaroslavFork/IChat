// js/calls.js
// Архитектура голосовых и видеозвонков на WebRTC.
// Сигналинг (обмен offer/answer/ICE) идёт через Supabase Realtime broadcast —
// отдельного сигнального сервера не нужно. Для установления соединения
// используется публичный STUN-сервер Google.
//
// ВАЖНО (ограничение): без TURN-сервера звонок может не установиться между
// участниками за "жёстким" NAT/симметричным роутером (для части мобильных
// сетей и корпоративных Wi-Fi). Для продакшена стоит добавить TURN
// (например, через Twilio NTS или self-hosted coturn) — это отдельная
// инфраструктура, не создаётся автоматически.
//
// ИСПРАВЛЕННЫЙ БАГ ("зависает на Соединение…"): раньше звонящий отправлял
// WebRTC offer сразу после получения своего локального медиапотока, не
// дожидаясь, пока собеседник (callee) примет звонок и создаст свой
// PeerConnection с локальными треками. Из-за этого offer мог быть обработан
// на стороне callee ДО того, как его локальный поток был готов — в ответ
// уходил answer без аудио/видео дорожек, либо (при более медленной сети)
// offer вообще терялся, так как Supabase Realtime broadcast не хранит
// события для подписчиков, которые ещё не успели подключиться к каналу.
// Теперь порядок строгий: callee сначала полностью готовит PeerConnection
// с локальными треками и только потом сигналит "ready" — и только после
// этого сигнала звонящий создаёт и отправляет offer.
//
// ОЖИДАЕМАЯ СХЕМА: таблица `calls`
//   (id, chat_id, caller_id, callee_id, type 'voice'|'video',
//    status 'ringing'|'accepted'|'declined'|'ended'|'missed',
//    started_at, ended_at, created_at)

import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./auth.js";

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const callVoiceBtn = document.getElementById("call-voice-btn");
const callVideoBtn = document.getElementById("call-video-btn");

const overlay = document.getElementById("call-overlay");
const remoteVideo = document.getElementById("call-remote-video");
const localVideo = document.getElementById("call-local-video");
const callAvatar = document.getElementById("call-avatar");
const callName = document.getElementById("call-name");
const callStatusText = document.getElementById("call-status-text");
const remoteAvatarOverlay = document.getElementById("call-remote-avatar-overlay");
const remoteAvatarImg = document.getElementById("call-remote-avatar-img");
const remoteStateBadges = document.getElementById("call-remote-state-badges");

const incomingActions = document.getElementById("call-incoming-actions");
const acceptBtn = document.getElementById("call-accept-btn");
const declineBtn = document.getElementById("call-decline-btn");

const activeControls = document.getElementById("call-active-controls");
const muteBtn = document.getElementById("call-mute-btn");
const camBtn = document.getElementById("call-cam-btn");
const hangupBtn = document.getElementById("call-hangup-btn");

const DEFAULT_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#3A3A3C"/><text x="32" y="40" font-size="26" fill="#98989D" text-anchor="middle" font-family="-apple-system,sans-serif">?</text></svg>`
  );

let pc = null;
let localStream = null;
let signalChannel = null;
let incomingChannel = null;
let activeCall = null; // { id, chatId, peerId, peerName, peerAvatar, type, role: 'caller'|'callee' }
let isMuted = false;
let isCamOff = false;
let callTimerInterval = null;
let offerSent = false;

/* === Глобальная подписка на входящие звонки === */
export function initIncomingCallListener() {
  const me = getCurrentUser();
  if (!me || incomingChannel) return;

  incomingChannel = supabase
    .channel(`calls:${me.id}`)
    .on("broadcast", { event: "incoming" }, (payload) => handleIncomingCall(payload.payload))
    .on("broadcast", { event: "cancelled" }, (payload) => {
      if (activeCall && activeCall.id === payload.payload.callId) {
        endCallUI("Звонок отменён");
      }
    })
    .subscribe();
}

export function teardownIncomingCallListener() {
  if (incomingChannel) supabase.removeChannel(incomingChannel);
  incomingChannel = null;
}

/** Подписывается на канал и возвращает промис, который резолвится когда канал реально готов (SUBSCRIBED). */
function subscribeAndWait(channel) {
  return new Promise((resolve) => {
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") resolve();
    });
  });
}

/* === Исходящий звонок: кнопки в шапке чата === */
callVoiceBtn.addEventListener("click", () => startOutgoingCall("voice"));
callVideoBtn.addEventListener("click", () => startOutgoingCall("video"));

async function startOutgoingCall(type) {
  if (activeCall) return; // звонок уже идёт

  const chatId = window.__ichatActiveChatIdForMenu;
  const peerId = window.__ichatActiveOtherUserId;
  if (!chatId || !peerId) {
    alert("Звонки пока доступны только в личных чатах.");
    return;
  }

  const me = getCurrentUser();
  const { data: peer } = await supabase
    .from("users")
    .select("id, name, username, avatar_url")
    .eq("id", peerId)
    .maybeSingle();

  const { data: call, error } = await supabase
    .from("calls")
    .insert({ chat_id: chatId, caller_id: me.id, callee_id: peerId, type, status: "ringing" })
    .select()
    .single();

  if (error || !call) {
    console.error("[Calls] не удалось создать звонок:", error);
    alert(
      `Не удалось начать звонок: ${error?.message || "неизвестная ошибка"}. ` +
      `Проверьте, что таблица "calls" существует (см. sql/00_create_tables.sql) и добавлена в Realtime.`
    );
    return;
  }

  offerSent = false;
  activeCall = {
    id: call.id,
    chatId,
    peerId,
    peerName: peer?.name || peer?.username || "Пользователь",
    peerAvatar: peer?.avatar_url,
    type,
    role: "caller",
  };

  showOverlay({ ringing: true, incoming: false });

  // Важно: дожидаемся, пока канал сигналинга реально подключится,
  // прежде чем что-либо по нему отправлять.
  signalChannel = supabase.channel(`call-signal:${call.id}`);
  attachSignalHandlers(signalChannel);
  await subscribeAndWait(signalChannel);

  // Оповещаем собеседника о входящем звонке через его персональный канал —
  // тоже дожидаемся подписки, иначе broadcast может быть отправлен в пустоту.
  const notifyChannel = supabase.channel(`calls:${peerId}`);
  await subscribeAndWait(notifyChannel);
  notifyChannel.send({
    type: "broadcast",
    event: "incoming",
    payload: {
      callId: call.id,
      chatId,
      type,
      callerId: me.id,
      callerName: me.name || me.username,
      callerAvatar: me.avatar_url,
    },
  });
  supabase.removeChannel(notifyChannel);

  // Готовим свой медиапоток и PeerConnection заранее, но offer пока НЕ шлём —
  // ждём сигнала "ready" от собеседника (он пришлёт его, когда сам будет готов).
  await setupLocalMedia(type);
}

/* === Входящий звонок === */
function handleIncomingCall(payload) {
  if (activeCall) return; // уже в звонке — считаем недоступным (занято)

  offerSent = false;
  activeCall = {
    id: payload.callId,
    chatId: payload.chatId,
    peerId: payload.callerId,
    peerName: payload.callerName || "Пользователь",
    peerAvatar: payload.callerAvatar,
    type: payload.type,
    role: "callee",
  };

  signalChannel = supabase.channel(`call-signal:${payload.callId}`);
  attachSignalHandlers(signalChannel);
  signalChannel.subscribe();

  showOverlay({ ringing: false, incoming: true });
}

acceptBtn.addEventListener("click", acceptCall);
declineBtn.addEventListener("click", () => declineCall("declined"));

async function acceptCall() {
  if (!activeCall) return;

  await supabase.from("calls").update({ status: "accepted", started_at: new Date().toISOString() }).eq("id", activeCall.id);

  incomingActions.classList.add("hidden");
  activeControls.classList.remove("hidden");
  callStatusText.textContent = "Соединение…";

  // Сначала полностью готовим локальный поток и PeerConnection...
  await setupLocalMedia(activeCall.type);
  // ...и только теперь сообщаем звонящему, что можно слать offer.
  signalChannel.send({ type: "broadcast", event: "ready", payload: { from: getCurrentUser().id } });
}

async function declineCall(reason) {
  if (!activeCall) return;
  await supabase.from("calls").update({ status: reason, ended_at: new Date().toISOString() }).eq("id", activeCall.id);
  signalChannel?.send({ type: "broadcast", event: "hangup", payload: {} });
  endCallUI(reason === "declined" ? "Звонок отклонён" : "Звонок завершён");
}

/* === WebRTC сигналинг === */
function attachSignalHandlers(channel) {
  channel
    .on("broadcast", { event: "ready" }, async () => {
      // Приходит только звонящему, когда собеседник принял звонок и подготовил
      // свой PeerConnection с локальными треками — теперь безопасно слать offer.
      if (activeCall?.role !== "caller" || offerSent) return;
      offerSent = true;
      await createAndSendOffer();
    })
    .on("broadcast", { event: "offer" }, async (payload) => {
      if (activeCall?.role !== "callee") return;
      await ensurePeerConnection();
      await pc.setRemoteDescription(new RTCSessionDescription(payload.payload.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signalChannel.send({ type: "broadcast", event: "answer", payload: { sdp: answer } });
      callStatusText.textContent = "Соединение установлено";
      startCallTimer();
    })
    .on("broadcast", { event: "answer" }, async (payload) => {
      if (activeCall?.role !== "caller") return;
      await pc.setRemoteDescription(new RTCSessionDescription(payload.payload.sdp));
      callStatusText.textContent = "Соединение установлено";
      startCallTimer();
    })
    .on("broadcast", { event: "ice" }, async (payload) => {
      if (!pc || !payload.payload.candidate) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(payload.payload.candidate));
      } catch (e) {
        console.warn("[Calls] ошибка добавления ICE-кандидата:", e);
      }
    })
    .on("broadcast", { event: "state" }, (payload) => {
      // Собеседник включил/выключил микрофон или камеру — обновляем индикаторы.
      updateRemoteStateBadges(payload.payload);
    })
    .on("broadcast", { event: "hangup" }, () => endCallUI("Звонок завершён"));
}

async function ensurePeerConnection() {
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      signalChannel?.send({ type: "broadcast", event: "ice", payload: { candidate: e.candidate } });
    }
  };

  pc.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0];
    if (activeCall?.type === "video") {
      remoteVideo.classList.remove("hidden");
      remoteAvatarOverlay.classList.add("hidden");
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
      endCallDueToDisconnect();
    }
  };

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  return pc;
}

async function setupLocalMedia(type) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === "video",
    });
  } catch (e) {
    console.error("[Calls] getUserMedia error:", e);
    alert(
      `Нужен доступ к микрофону${type === "video" ? " и камере" : ""} для звонка ` +
      `(${e.name || "ошибка"}: ${e.message || "нет доступа к устройству"}).`
    );
    endCallUI("Нет доступа к устройствам");
    return;
  }

  if (type === "video") {
    localVideo.srcObject = localStream;
    localVideo.classList.remove("hidden");
    camBtn.classList.remove("hidden");
  }

  // PeerConnection создаётся здесь же (если ещё не создан) — важно, чтобы
  // localStream уже существовал к этому моменту, иначе треки не попадут
  // в исходящее соединение (в этом и была причина зависания звонка).
  await ensurePeerConnection();
}

async function createAndSendOffer() {
  await ensurePeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signalChannel.send({ type: "broadcast", event: "offer", payload: { sdp: offer } });
}

/* === UI === */
function showOverlay({ ringing, incoming }) {
  overlay.classList.remove("hidden");
  callAvatar.src = activeCall.peerAvatar || DEFAULT_AVATAR;
  remoteAvatarImg.src = activeCall.peerAvatar || DEFAULT_AVATAR;
  callName.textContent = activeCall.peerName;
  callStatusText.textContent = incoming
    ? (activeCall.type === "video" ? "Входящий видеозвонок…" : "Входящий звонок…")
    : "Вызов…";

  incomingActions.classList.toggle("hidden", !incoming);
  activeControls.classList.toggle("hidden", incoming);
  remoteVideo.classList.add("hidden");
  localVideo.classList.add("hidden");
  remoteAvatarOverlay.classList.add("hidden");
  camBtn.classList.toggle("hidden", activeCall.type !== "video");
  isMuted = false;
  isCamOff = false;
  muteBtn.classList.remove("active");
  camBtn.classList.remove("active");
  const muteIcon = muteBtn.querySelector(".svg-icon");
  muteIcon.classList.add("svg-mic");
  muteIcon.classList.remove("svg-mic-off");
  const camIcon = camBtn.querySelector(".svg-icon");
  camIcon.classList.add("svg-camera");
  camIcon.classList.remove("svg-camera-off");
  remoteStateBadges.innerHTML = "";
}

function startCallTimer() {
  let seconds = 0;
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    seconds++;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    callStatusText.textContent = `${m}:${s.toString().padStart(2, "0")}`;
  }, 1000);
}

/* === Мьют/камера — с оповещением собеседника === */
muteBtn.addEventListener("click", () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
  muteBtn.classList.toggle("active", isMuted);
  const icon = muteBtn.querySelector(".svg-icon");
  icon.classList.toggle("svg-mic", !isMuted);
  icon.classList.toggle("svg-mic-off", isMuted);
  broadcastState();
});

camBtn.addEventListener("click", () => {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach((t) => (t.enabled = !isCamOff));
  camBtn.classList.toggle("active", isCamOff);
  const icon = camBtn.querySelector(".svg-icon");
  icon.classList.toggle("svg-camera", !isCamOff);
  icon.classList.toggle("svg-camera-off", isCamOff);
  broadcastState();
});

function broadcastState() {
  signalChannel?.send({
    type: "broadcast",
    event: "state",
    payload: { audioMuted: isMuted, videoOff: isCamOff },
  });
}

/** Показывает у собеседника значки "микрофон выключен"/"камера выключена" и аватар вместо видео, если камера выключена. */
function updateRemoteStateBadges(state) {
  remoteStateBadges.innerHTML = "";
  if (state.audioMuted) {
    remoteStateBadges.insertAdjacentHTML(
      "beforeend",
      `<span class="call-state-badge" title="Микрофон выключен"><span class="svg-icon svg-mic-off" style="background-color:#fff;width:16px;height:16px;"></span></span>`
    );
  }
  if (activeCall?.type === "video") {
    remoteAvatarOverlay.classList.toggle("hidden", !state.videoOff);
    if (state.videoOff) {
      remoteStateBadges.insertAdjacentHTML(
        "beforeend",
        `<span class="call-state-badge" title="Камера выключена"><span class="svg-icon svg-camera-off" style="background-color:#fff;width:16px;height:16px;"></span></span>`
      );
    }
  }
}

hangupBtn.addEventListener("click", async () => {
  if (activeCall) {
    await supabase.from("calls").update({ status: "ended", ended_at: new Date().toISOString() }).eq("id", activeCall.id);
    signalChannel?.send({ type: "broadcast", event: "hangup", payload: {} });
  }
  endCallUI("Звонок завершён");
});

/**
 * Вызывается при обрыве WebRTC-соединения (onconnectionstatechange).
 * В отличие от простого endCallUI, ЭТА функция ещё и помечает звонок
 * завершённым в базе — раньше при обрыве связи (например, у собеседника
 * закрылось приложение) статус в таблице calls так и оставался
 * "accepted" навсегда, из-за чего в админ-панели звонок "висел"
 * с постоянно растущим таймером, даже если разговор давно закончился.
 */
async function endCallDueToDisconnect() {
  if (activeCall) {
    try {
      await supabase
        .from("calls")
        .update({ status: "ended", ended_at: new Date().toISOString() })
        .eq("id", activeCall.id);
    } catch (e) {
      console.warn("[Calls] не удалось обновить статус звонка при обрыве связи:", e);
    }
  }
  endCallUI("Связь прервана");
}

function endCallUI(statusText) {
  callStatusText.textContent = statusText;
  clearInterval(callTimerInterval);

  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;

  if (pc) {
    pc.close();
    pc = null;
  }
  if (signalChannel) {
    supabase.removeChannel(signalChannel);
    signalChannel = null;
  }

  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
  activeCall = null;
  offerSent = false;

  setTimeout(() => {
    overlay.classList.add("hidden");
  }, 900);
}

/**
 * Лучшая попытка пометить звонок завершённым, если человек закрывает
 * вкладку/приложение прямо во время звонка (обычный await-запрос в
 * этот момент браузер может не успеть отправить — sendBeacon рассчитан
 * именно на отправку данных при выгрузке страницы). Это не гарантия
 * на 100% (например, если браузер убит принудительно), поэтому
 * отдельно есть подстраховка — авточистка зависших звонков в
 * js/admin.js (loadActiveCalls), см. комментарий там.
 */
window.addEventListener("pagehide", () => {
  if (!activeCall) return;
  try {
    // sendBeacon здесь не подходит: он всегда шлёт POST и не умеет
    // произвольные заголовки, а Supabase REST для UPDATE требует PATCH
    // и заголовок apikey — без него запрос просто получит 401.
    // fetch(..., { keepalive: true }) — единственный браузерный способ
    // отправить полноценный авторизованный запрос при выгрузке страницы.
    fetch(`${supabase.supabaseUrl}/rest/v1/calls?id=eq.${activeCall.id}`, {
      method: "PATCH",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        apikey: supabase.supabaseKey,
        Authorization: `Bearer ${supabase.supabaseKey}`,
      },
      body: JSON.stringify({ status: "ended", ended_at: new Date().toISOString() }),
    });
  } catch (e) {
    /* лучшее из возможного при выгрузке страницы — не гарантия на 100% */
  }
});
