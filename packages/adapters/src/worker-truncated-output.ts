/**
 * A worker final cut at the model's output-token limit (stopReason "length" with text) is a
 * genuine cut-off, not a completion. The continue run picks up where the text stopped and the
 * pieces are joined before the result goes to the dispatcher. Pure helpers.
 */

/** Key on background_task_queue.args holding the text a cut-off final already produced. */
export const INCOMPLETE_TRUNCATED_PREFIX_KEY = "incompleteTruncatedPrefix";

/** Upper bound on the stored prefix; past this the joined report is attached as a file anyway. */
export const MAX_TRUNCATED_PREFIX_CHARS = 200_000;

/** How much of the cut-off text's end the continue instruction quotes. */
export const TRUNCATED_TAIL_CHARS = 1_500;

type TerminalMessage = {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
};

/** The final assistant message stopped at the output limit after writing visible text. */
export function finalCutAtOutputLimit(
  message: TerminalMessage | undefined,
  hasText: boolean,
): boolean {
  if (!message || message.role !== "assistant" || !hasText) return false;
  if (message.stopReason !== "length" || message.errorMessage) return false;
  const content = Array.isArray(message.content) ? message.content : [];
  return !content.some(
    (part) => part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall",
  );
}

export function storedTruncatedPrefix(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const value = (args as Record<string, unknown>)[INCOMPLETE_TRUNCATED_PREFIX_KEY];
  return typeof value === "string" ? value : "";
}

/**
 * Join a cut-off prefix and its continuation. A continuation that restates the last words of
 * the prefix (at least 12 characters) does not repeat them.
 */
export function joinTruncatedContinuation(prefix: string, continuation: string): string {
  if (!prefix) return continuation;
  if (!continuation) return prefix;
  const next = continuation.replace(/^\s*\n/, "");
  const maxOverlap = Math.min(prefix.length, next.length, 400);
  for (let size = maxOverlap; size >= 12; size--) {
    if (prefix.endsWith(next.slice(0, size))) return prefix + next.slice(size);
  }
  return prefix + next;
}

/** Keep the stored prefix bounded; the tail matters for the join, the head for the report. */
export function boundedTruncatedPrefix(text: string): string {
  return text.length <= MAX_TRUNCATED_PREFIX_CHARS
    ? text
    : `${text.slice(0, MAX_TRUNCATED_PREFIX_CHARS - 2_000)}\n…（中间过长部分已省略）…\n${text.slice(-2_000)}`;
}
