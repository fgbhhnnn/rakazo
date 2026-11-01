import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { isDispatcherTurnTimeoutMessage } from "./dispatcher-mode.js";

/** History entries a dispatcher turn keeps when it retries a turn the watchdog stopped. */
export const DISPATCHER_RETRY_HISTORY_ENTRIES = 12;
/** Characters of each kept entry; the newest text is what a short reply needs. */
export const DISPATCHER_RETRY_ENTRY_CHARS = 2_000;
const TRIMMED_MARKER = "…[trimmed for the retry]";

/**
 * Whether this dispatcher run restarts a turn the watchdog stopped (restartDispatcherTurn).
 * Other retries (e.g. the reply guard's) chain through retryOfRunId too, so the failed run's
 * own error decides.
 */
export async function isDispatcherTimeoutRetry(
  prisma: Pick<PrismaClient, "run">,
  run: { retryOfRunId?: string | null },
): Promise<boolean> {
  if (!run.retryOfRunId) return false;
  const failed = await prisma.run.findUnique({
    where: { id: run.retryOfRunId },
    select: { error: true },
  });
  return isDispatcherTurnTimeoutMessage(failed?.error);
}

function trimEntry(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const keep = Math.max(0, maxChars - TRIMMED_MARKER.length);
  // The end of a message is usually the ask; keep it and mark the cut.
  return `${TRIMMED_MARKER}${content.slice(content.length - keep)}`;
}

/**
 * A retried dispatcher turn must not resend what made the stopped one too slow: no image
 * parts, only the newest entries, and each entry shortened. `pinned` leading entries (the
 * compacted summary and recalled memory) are always kept, shortened. The current message itself
 * is the prompt and is untouched.
 */
export function lightenDispatcherRetryHistory(
  history: AgentRunRequest["history"],
  options: { pinned?: number; maxEntries?: number; maxChars?: number } = {},
): AgentRunRequest["history"] {
  const pinned = Math.max(0, options.pinned ?? 0);
  const maxEntries = options.maxEntries ?? DISPATCHER_RETRY_HISTORY_ENTRIES;
  const maxChars = options.maxChars ?? DISPATCHER_RETRY_ENTRY_CHARS;
  const lead = history.slice(0, pinned);
  const rest = history.slice(pinned);
  return [...lead, ...rest.slice(Math.max(0, rest.length - maxEntries))].map((entry) => {
    const { images: _images, ...kept } = entry;
    return { ...kept, content: trimEntry(entry.content, maxChars) };
  });
}
