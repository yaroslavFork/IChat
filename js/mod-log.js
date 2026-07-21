// js/mod-log.js
// Запись действий администратора в журнал (таблица moderation_log).
// Используется блокировками, галочками, группами/каналами и т.д.

import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./auth.js";

/**
 * Записывает одно действие в журнал модерации.
 * @param {string} action - короткий код действия, напр. "block_user", "grant_badge"
 * @param {string|null} targetUserId - на кого подействовали (если применимо)
 * @param {string} details - человекочитаемое пояснение для журнала
 */
export async function logAction(action, targetUserId, details) {
  const me = getCurrentUser();
  if (!me) return;

  const { error } = await supabase.from("moderation_log").insert({
    admin_id: me.id,
    action,
    target_user_id: targetUserId || null,
    details: details || null,
  });

  if (error) {
    // Журнал не должен блокировать основное действие — просто предупреждаем в консоли.
    console.warn("[ModLog] не удалось записать действие в журнал:", error.message);
  }
}
