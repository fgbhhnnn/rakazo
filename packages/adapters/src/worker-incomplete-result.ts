/**
 * Detect when a background worker's final text is not a real completion: a truncated or
 * leaked tool call, or wording that clearly says the work is unfinished. Pure helpers; the
 * continue path lives in worker-incomplete-continue.ts.
 */

/** Auto-continues of one task before we mark it failed instead of done. */
export const MAX_INCOMPLETE_CONTINUES = 3;

/** Keys on background_task_queue.args that track auto-continues. */
export const INCOMPLETE_CONTINUE_COUNT_KEY = "incompleteContinues";
export const INCOMPLETE_CONTINUING_KEY = "incompleteContinuing";

const TOOL_CALL_OPEN = /<tool_call\b/i;
const TOOL_CALL_CLOSE = /<\/tool_call>/i;
/** Leaked Composio / XML-ish tool payloads that models sometimes dump as plain text. */
const LEAKED_TOOL_MARKERS =
  /(?:^|\n)\s*(?:<\/?tool_call\b|COMPOSIO_[A-Z0-9_]+\b|invoke\s+[A-Z][A-Z0-9_]{2,}|call\s+tool\b|<function_call\b)/im;
/** Unclosed JSON object that looks like tool arguments after a tool name line. */
const UNCLOSED_TOOL_JSON =
  /(?:COMPOSIO_[A-Z0-9_]+|[A-Z][A-Z0-9_]{3,})\s*\n[\s\S]*\{\s*"(?:arguments|tool_slug|name|parameters)"\s*:[\s\S]*$/;

/**
 * Conservative unfinished phrases (Chinese and English). Keep the list short to avoid
 * false positives such as "已完成，没有未完成项".
 */
const UNFINISHED_PHRASES: readonly RegExp[] = [
  /还没做完/,
  /还没(?:有)?完成/,
  /尚未完成/,
  /未完成(?!项)/,
  /随后补上/,
  /稍后补上/,
  /还在改/,
  /还在做/,
  /稍后继续/,
  /稍后再继续/,
  /接着做/,
  /下一步再/,
  /待续/,
  /\bnot(?:\s+\w+){0,3}\s+finished\b/i,
  /\bstill\s+(?:working|running|in\s+progress)\b/i,
  /\bwill\s+continue\b/i,
  /\bto\s+be\s+continued\b/i,
  /\bincomplete\b/i,
  /\bnot\s+done\s+yet\b/i,
];

/** Phrases that cancel an unfinished match (the work is done). */
const UNFINISHED_NEGATIVES: readonly RegExp[] = [
  /已完成[，,].{0,12}没有未完成/,
  /没有未完成项/,
  /无未完成/,
  /全部完成/,
  /全部做完/,
  /\bno\s+unfinished\b/i,
  /\bnothing\s+left\s+unfinished\b/i,
  /\ball\s+(?:done|complete|finished)\b/i,
];

export type IncompleteReason = "truncated_tool_call" | "unfinished_phrase";

export function hasTruncatedOrLeakedToolCall(text: string): boolean {
  const raw = text ?? "";
  if (!raw.trim()) return false;
  if (TOOL_CALL_OPEN.test(raw) && !TOOL_CALL_CLOSE.test(raw)) return true;
  if (TOOL_CALL_OPEN.test(raw) && TOOL_CALL_CLOSE.test(raw)) {
    // A closed tool_call in a final assistant reply is still a leak (tools are not text).
    return true;
  }
  if (LEAKED_TOOL_MARKERS.test(raw)) return true;
  if (UNCLOSED_TOOL_JSON.test(raw)) return true;
  return false;
}

/**
 * Remove leaked tool-call text so users never see raw `<tool_call>` / Composio dumps.
 * Keeps the prose before the first leak marker.
 */
export function stripLeakedToolCallText(text: string): string {
  const raw = text ?? "";
  if (!raw) return "";
  const open = raw.search(TOOL_CALL_OPEN);
  const leaked = raw.search(LEAKED_TOOL_MARKERS);
  let cut = -1;
  if (open >= 0) cut = open;
  if (leaked >= 0 && (cut < 0 || leaked < cut)) cut = leaked;
  const kept = cut >= 0 ? raw.slice(0, cut) : raw;
  return kept.replace(/\s+$/u, "").trimEnd();
}

export function saysWorkUnfinished(text: string): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;
  if (UNFINISHED_NEGATIVES.some((re) => re.test(raw))) return false;
  return UNFINISHED_PHRASES.some((re) => re.test(raw));
}

/** Why this final text must not close the task as completed, or null when it is fine. */
export function incompleteResultReason(text: string): IncompleteReason | null {
  if (hasTruncatedOrLeakedToolCall(text)) return "truncated_tool_call";
  if (saysWorkUnfinished(text)) return "unfinished_phrase";
  return null;
}

/** Text safe to show users / relay when the raw final had a leaked tool call. */
export function userFacingIncompleteText(text: string): string {
  return stripLeakedToolCallText(text);
}

export function incompleteContinueCount(args: unknown): number {
  if (!args || typeof args !== "object" || Array.isArray(args)) return 0;
  const n = (args as Record<string, unknown>)[INCOMPLETE_CONTINUE_COUNT_KEY];
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function isIncompleteContinuing(args: unknown): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  return (args as Record<string, unknown>)[INCOMPLETE_CONTINUING_KEY] === true;
}

export function withIncompleteContinueArgs(
  args: unknown,
  count: number,
  continuing: boolean,
): Record<string, unknown> {
  const base =
    args && typeof args === "object" && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : {};
  base[INCOMPLETE_CONTINUE_COUNT_KEY] = count;
  if (continuing) base[INCOMPLETE_CONTINUING_KEY] = true;
  else delete base[INCOMPLETE_CONTINUING_KEY];
  return base;
}

/** Instruction the same worker sees when we auto-continue it. */
export function buildIncompleteContinueMessage(input: {
  reason: IncompleteReason;
  priorText: string;
  attempt: number;
  maxAttempts: number;
}): string {
  const why =
    input.reason === "truncated_tool_call"
      ? "你上一次的最终回复里混入了未闭合或泄漏的工具调用（例如未闭合的工具调用标签），不能当作完成结果。"
      : "你上一次的最终回复明确表示工作还没做完。";
  const cleaned = userFacingIncompleteText(input.priorText).slice(0, 4_000);
  const prior = cleaned
    ? `上一次对用户可见的部分（已去掉泄漏的工具调用）：\n${cleaned}`
    : "上一次回复没有可展示的正文。";
  return [
    "[系统自动继续] 请从停下的地方继续完成同一任务，不要重复已经完成的部分，也不要再输出工具调用的原始文本。",
    why,
    `这是第 ${input.attempt}/${input.maxAttempts} 次自动继续；用完后任务会标记为失败，由主 bot 如实告诉用户。`,
    prior,
  ].join("\n\n");
}

/** Note the dispatcher gets when auto-continues are exhausted. */
export function incompleteExhaustedNote(input: {
  reason: IncompleteReason;
  cleanedText: string;
  continues: number;
}): string {
  const why =
    input.reason === "truncated_tool_call"
      ? "最终回复多次截断或泄漏了工具调用"
      : "最终回复多次表明工作未完成";
  const body = input.cleanedText.trim();
  return [
    `【未完成】后台任务自动继续 ${input.continues} 次后仍未完成（${why}），已标记为失败，请如实告诉用户，不要说已完成。`,
    body ? `最后可见内容：\n${body.slice(0, 3_000)}` : "没有可展示的正文。",
  ].join("\n\n");
}
