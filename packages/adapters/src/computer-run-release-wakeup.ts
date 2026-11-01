import { runContinueJob } from "@rakazo/adapter-kit";
import type { ExecutorDeps } from "./executor-deps.js";

/**
 * The compatibility trigger treats null -> null on running -> queued as an omitted
 * wakeAt and adds backoff. A concrete past instant keeps release-driven waits due.
 */
export function computerRequeueWakeAt(untilReleased: boolean, retryAt: Date): Date {
  return untilReleased ? new Date(0) : retryAt;
}

/**
 * Recheck after recording the wait: the holder may have released its lease and checked
 * for queued work while this run still said running. If the lease is still held, its
 * release will see our queued row; otherwise we must publish the wake ourselves.
 */
export async function wakeAfterComputerReleaseRace(
  deps: Pick<ExecutorDeps, "prisma" | "jobs">,
  runId: string,
): Promise<void> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: {
      botId: true,
      bot: { select: { computerId: true } },
      status: true,
      leaseOwner: true,
      wakeAt: true,
    },
  });
  if (
    run?.status !== "queued" ||
    run.leaseOwner !== null ||
    (run.wakeAt && run.wakeAt > new Date())
  )
    return;
  const holder = run.bot.computerId
    ? await deps.prisma.computerExecutionLease.findFirst({
        where: {
          computerId: run.bot.computerId,
          botId: run.botId,
          runId: { not: runId },
          expiresAt: { gt: new Date() },
        },
        select: { id: true },
      })
    : null;
  if (!holder) await deps.jobs.enqueue(runContinueJob(runId));
}
