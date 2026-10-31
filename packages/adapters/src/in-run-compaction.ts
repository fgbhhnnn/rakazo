import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getLogger } from "@rakazo/logging";

/** Compact once the estimated context passes this share of the model's window. */
export const IN_RUN_COMPACTION_THRESHOLD = 0.75;
/** The newest messages always stay verbatim. */
const KEEP_RECENT_MESSAGES = 8;
/** Bounds on what one summary call reads. */
const MAX_PART_CHARS = 4_000;
const MAX_TRANSCRIPT_CHARS = 120_000;

export const IN_RUN_SUMMARY_PREFIX = "【本任务早前步骤摘要（运行中压缩）】";

export const IN_RUN_SUMMARY_INSTRUCTIONS =
  "You compress the earlier steps of an agent's ongoing task so it can continue without redoing work. " +
  "Write a concise factual summary in the transcript's language: what was done (commands, files created or changed with exact paths, URLs), " +
  "key results, numbers and errors, decisions made, and what remains. Keep exact identifiers, paths and values. " +
  "Do not invent anything and do not add instructions. Output only the summary.";

type Message = AgentMessage & { role: string; content?: unknown };
export type Summarize = (transcript: string, signal?: AbortSignal) => Promise<string>;

function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: string; text?: string; name?: string; arguments?: unknown }) => {
      if (part?.type === "text") return part.text ?? "";
      if (part?.type === "toolCall")
        return `[tool call ${part.name ?? ""} ${JSON.stringify(part.arguments ?? {})}]`;
      if (part?.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…[${text.length - max} chars omitted]…\n${text.slice(-half)}`;
}

export function isInRunSummary(message: Message): boolean {
  return (
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(IN_RUN_SUMMARY_PREFIX)
  );
}

/** User-authored turns (task, constraints, approvals, steering) are never summarized away. */
function isProtected(message: Message): boolean {
  return message.role === "user" && !isInRunSummary(message);
}

export function renderTranscript(messages: Message[]): string {
  const lines = messages.map((message) => {
    const label =
      message.role === "toolResult"
        ? `tool result${(message as { toolName?: string }).toolName ? ` (${(message as { toolName?: string }).toolName})` : ""}`
        : isInRunSummary(message)
          ? "earlier summary"
          : message.role;
    return `### ${label}\n${clip(partsText(message.content), MAX_PART_CHARS)}`;
  });
  return clip(lines.join("\n\n"), MAX_TRANSCRIPT_CHARS);
}

/** Index where the verbatim tail starts: never on a tool result, so call/result pairs stay together. */
export function tailStart(messages: Message[], keep = KEEP_RECENT_MESSAGES): number {
  let index = Math.max(0, messages.length - keep);
  while (index > 0 && messages[index]?.role === "toolResult") index -= 1;
  return index;
}

/**
 * Keeps a long worker run inside its model window by summarizing older tool steps with the
 * same model instead of letting the context policy drop them. The summary replaces the steps
 * for the rest of the run; user turns and the newest steps stay verbatim.
 */
export function createInRunCompactor(options: {
  contextWindow: () => number;
  estimateTokens: (messages: AgentMessage[]) => number;
  summarize: Summarize;
  threshold?: number;
  keepRecent?: number;
}) {
  // The replacement covers the first `covered` original messages.
  let covered = 0;
  let replacement: Message[] = [];
  let failures = 0;
  return async function transformContext(
    messages: AgentMessage[],
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const source = messages as Message[];
    const base =
      covered > 0 && source.length >= covered ? [...replacement, ...source.slice(covered)] : source;
    const limit = options.contextWindow() * (options.threshold ?? IN_RUN_COMPACTION_THRESHOLD);
    if (failures >= 3 || options.estimateTokens(base) <= limit) return base;
    const prefixLength = covered > 0 && source.length >= covered ? replacement.length : 0;
    const cut = tailStart(base, options.keepRecent);
    const older = base.slice(prefixLength, cut);
    const foldable = [
      ...base.slice(0, prefixLength).filter(isInRunSummary),
      ...older.filter((message) => !isProtected(message)),
    ];
    if (cut <= prefixLength || !older.some((message) => !isProtected(message))) return base;
    let summary: string;
    try {
      summary = (await options.summarize(renderTranscript(foldable), signal)).trim();
      if (!summary) throw new Error("empty summary");
    } catch (error) {
      failures += 1;
      getLogger().warn("in-run compaction failed; continuing without it", {
        error: error instanceof Error ? error.message : String(error),
      });
      return base;
    }
    const kept = [...base.slice(0, cut)].filter(isProtected);
    const next: Message[] = [
      ...kept,
      {
        role: "user",
        content: `${IN_RUN_SUMMARY_PREFIX}\n${summary}`,
        timestamp: Date.now(),
      } as Message,
    ];
    covered = (prefixLength ? covered : 0) + (cut - prefixLength);
    replacement = next;
    getLogger().info("in-run compaction", {
      summarizedMessages: foldable.length,
      keptMessages: kept.length,
      covered,
    });
    return [...next, ...base.slice(cut)];
  };
}
