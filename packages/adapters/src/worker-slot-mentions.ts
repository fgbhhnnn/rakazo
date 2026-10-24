/**
 * Worker slot names ("后台4") are internal: one slot runs task after task, so "由后台4执行" tells
 * the user nothing and is often wrong (the long-task test saw a task run by 后台3 credited to
 * 后台4). Dispatcher replies name tasks by title and #REF; slot mentions are removed. Counts such
 * as "后台3个任务" are not slot names and stay.
 */
const COUNT_UNIT = "(?:个|项|条|位|秒|分|小时|轮|次|%|％|\\.\\d)";
const BY_SLOT = new RegExp(
  `[，,、]?\\s*由\\s*(?:worker\\s*)?后台\\s*\\d+(?!\\s*${COUNT_UNIT})\\s*(?:号)?\\s*(?:执行|完成|运行|处理|负责|跑)?(?:的)?`,
  "g",
);
const SLOT = new RegExp(`后台\\s*\\d+(?!\\s*${COUNT_UNIT})(?:\\s*号)?`, "g");

export function withoutWorkerSlotMentions(text: string): string {
  return text
    .replace(BY_SLOT, "")
    .replace(SLOT, "后台")
    .replace(/（\s*）|\(\s*\)/g, "")
    .replace(/（\s*[，,、]\s*/g, "（")
    .replace(/[，,、]\s*）/g, "）");
}

/**
 * The slot-name filter for one writer: dispatcher text the user sees (final reply, mid-turn
 * narration, message_user) and everything a background worker sends its dispatcher (results,
 * status updates, the result file), so the name never reaches the user or the dispatcher's model.
 */
export function slotFree(applies: boolean): (text: string) => string {
  return applies ? withoutWorkerSlotMentions : (text) => text;
}
