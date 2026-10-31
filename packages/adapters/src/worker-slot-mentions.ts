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

/** Marks where a slot mention was removed, so only brackets emptied by that removal go. */
const GONE = "\uE000";
const EMPTIED_PAIR = new RegExp(`[（(][\\s，,、${GONE}]*${GONE}[\\s，,、${GONE}]*[）)]`, "g");
const OPEN_SEPARATOR = new RegExp(`([（(])\\s*${GONE}\\s*[，,、]\\s*`, "g");
const SEPARATOR_CLOSE = new RegExp(`[，,、]\\s*${GONE}\\s*([）)])`, "g");
/** Fenced blocks (closed or running to the end) and inline code spans are never rewritten. */
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;

function proseWithoutSlots(text: string): string {
  const marked = text.replace(BY_SLOT, GONE);
  const renamed = marked.replace(SLOT, "后台");
  if (!marked.includes(GONE)) return renamed;
  return renamed
    .replace(EMPTIED_PAIR, "")
    .replace(OPEN_SEPARATOR, "$1")
    .replace(SEPARATOR_CLOSE, "$1")
    .replaceAll(GONE, "");
}

/**
 * Removes worker slot names from prose. Brackets are only touched when a removed "由后台N执行"
 * left them empty; an unrelated "()" or "（）" (code such as `fn()` above all) stays, and code
 * spans and fenced blocks are left exactly as written.
 */
export function withoutWorkerSlotMentions(text: string): string {
  if (!text.includes("后台")) return text;
  return text
    .split(CODE)
    .map((part, index) => (index % 2 === 1 ? part : proseWithoutSlots(part)))
    .join("");
}

/**
 * The slot-name filter for one writer: dispatcher text the user sees (final reply, mid-turn
 * narration, message_user) and everything a background worker sends its dispatcher (results,
 * status updates, the result file), so the name never reaches the user or the dispatcher's model.
 */
export function slotFree(applies: boolean): (text: string) => string {
  return applies ? withoutWorkerSlotMentions : (text) => text;
}
