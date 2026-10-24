import type { PrismaClient } from "@rakazo/db";
import { runCancelPollMs } from "./dispatcher-mode.js";

/**
 * Stop (or a dispatcher's background_task_cancel) only flips the run to cancelled. Notice it
 * within seconds even while a tool or MCP call is pending, so the caller can abort the model call
 * and tools instead of waiting for the next event or heartbeat. Returns the stop function.
 */
export function watchRunCancellation(
  prisma: Pick<PrismaClient, "run">,
  runId: string,
  hooks: { done: () => boolean; onCancelled: () => void },
  pollMs = runCancelPollMs(),
): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (hooks.done() || busy) return;
    busy = true;
    void prisma.run
      .findUnique({ where: { id: runId }, select: { status: true } })
      .then((current) => {
        if (!hooks.done() && current?.status === "cancelled") hooks.onCancelled();
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, pollMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
