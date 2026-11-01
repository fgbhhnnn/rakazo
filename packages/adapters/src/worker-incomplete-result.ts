/**
 * Detect when a background worker's final text is not a real completion: a truncated or
 * leaked tool call, or wording that clearly says the work is unfinished. Pure helpers; the
 * continue path lives in worker-incomplete-continue.ts.
 */

import { TRUNCATED_TAIL_CHARS } from "./worker-truncated-output.js";
import { closingSaysUnfinished } from "./worker-unfinished-closing.js";

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

export type IncompleteReason = "truncated_tool_call" | "truncated_output" | "unfinished_phrase";

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

/**
 * The worker's own closing words say it is not done. Only the closing prose is read, never
 * headings, list items or table rows (see worker-unfinished-closing.ts).
 */
export function saysWorkUnfinished(text: string): boolean {
  return closingSaysUnfinished(text);
}

/**
 * Why this final text must not close the task as completed, or null when it is fine.
 * `cutAtOutputLimit` is the runtime's report that the final stopped at the output-token limit.
 */
export function incompleteResultReason(
  text: string,
  options?: { cutAtOutputLimit?: boolean },
): IncompleteReason | null {
  if (hasTruncatedOrLeakedToolCall(text)) return "truncated_tool_call";
  if (options?.cutAtOutputLimit && (text ?? "").trim()) return "truncated_output";
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
  const attemptLine = `这是第 ${input.attempt}/${input.maxAttempts} 次自动继续；用完后任务会标记为失败，由主 bot 如实告诉用户。`;
  if (input.reason === "truncated_output") {
    const tail = input.priorText.slice(-TRUNCATED_TAIL_CHARS);
    return [
      "[系统自动继续] 你上一次的最终回复写到模型单次输出长度上限时被截断了，前面已经写出的内容系统已保存，会和你这次的输出直接拼接后交给用户。",
      "请从被截断的位置原样接着往下写：第一个字就接在下面引用的结尾之后，不要重复已经写出的内容，不要重新开头，不要加“接上文”之类的说明，也不要输出工具调用的原始文本。如果还要用工具补做工作，先做完再接着写。",
      attemptLine,
      tail ? `上一次输出的结尾（截断处在最后）：\n${tail}` : "上一次回复没有可展示的正文。",
    ].join("\n\n");
  }
  const why =
    input.reason === "truncated_tool_call"
      ? "你上一次的最终回复里混入了未闭合或泄漏的工具调用（例如未闭合的工具调用标签），不能当作完成结果。"
      : "你上一次的最终回复在结尾明确表示工作还没做完。如果其实已经全部完成，请直接给出最终结果，结尾不要再写还没做完或稍后继续。";
  const cleaned = userFacingIncompleteText(input.priorText).slice(0, 4_000);
  const prior = cleaned
    ? `上一次对用户可见的部分（已去掉泄漏的工具调用）：\n${cleaned}`
    : "上一次回复没有可展示的正文。";
  return [
    "[系统自动继续] 请从停下的地方继续完成同一任务，不要重复已经完成的部分，也不要再输出工具调用的原始文本。",
    why,
    attemptLine,
    prior,
  ].join("\n\n");
}

/**
 * Lead line for a result the detector could not confirm as complete. It must not claim content
 * is missing: the full final text travels with it (as a file when long).
 */
export function incompleteExhaustedLead(input: {
  reason: IncompleteReason;
  continues: number;
  repeated?: boolean;
}): string {
  const why =
    input.reason === "truncated_tool_call"
      ? "最终回复里仍有泄漏或未闭合的工具调用"
      : input.reason === "truncated_output"
        ? "最后一次输出仍停在模型输出长度上限，结尾可能没写完"
        : "最终回复结尾仍说工作还没做完";
  const how = input.repeated
    ? `自动继续 ${input.continues} 次后，工作者给出的最终回复与上一次几乎相同，系统已停止继续`
    : `自动继续 ${input.continues} 次后`;
  return `【未确认完成】后台任务${how}（${why}），系统无法确认是否全部完成（可能未完成），已标记为失败。下面是工作者完整的最终回复，系统没有删减；请把它如实交给用户，说明系统未能确认是否全部完成，不要说已完成，也不要说内容被截断或缺失，除非回复本身这样写。`;
}

/** Note the dispatcher gets when auto-continues are exhausted: the lead plus the full text. */
export function incompleteExhaustedNote(input: {
  reason: IncompleteReason;
  cleanedText: string;
  continues: number;
  repeated?: boolean;
}): string {
  const body = input.cleanedText.trim();
  return [
    incompleteExhaustedLead(input),
    body ? `最终回复全文：\n${body}` : "没有可展示的正文。",
  ].join("\n\n");
}
