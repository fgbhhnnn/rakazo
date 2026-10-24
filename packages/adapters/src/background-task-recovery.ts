import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  MAX_TASK_START_ATTEMPTS,
  taskDeliveryKey,
  UNDELIVERED_GRACE_MS,
} from "./background-task-rows.js";

/**
 * Repairs task rows a crash or a lost delivery left behind:
 * - an expired claim is bound to the worker run it already created, or requeued (failed after
 *   MAX_TASK_START_ATTEMPTS), so a crash between claiming and starting never loses the task;
 * - a started task whose worker run is gone, or ended long ago without its result being
 *   delivered, is finalized so it no longer holds its slot.
 */
export async function recoverBackgroundTasks(
  deps: { prisma: PrismaClient },
  scope: { botId?: string } = {},
  now = new Date(),
) {
  let requeued = 0;
  let finalized = 0;
  const expired = await deps.prisma.backgroundTaskQueue.findMany({
    where: { ...scope, status: "claiming", leaseExpiresAt: { lt: now } },
    take: 100,
  });
  for (const row of expired) {
    const nonce = taskDeliveryKey(row, row.attempts);
    const delivered = row.workerBotId
      ? await deps.prisma.message.findFirst({
          where: { clientNonce: nonce, thread: { botId: row.workerBotId } },
          select: { runId: true },
        })
      : null;
    const data = delivered?.runId
      ? { status: "started", workerRunId: delivered.runId, leaseOwner: null, leaseExpiresAt: null }
      : row.attempts >= MAX_TASK_START_ATTEMPTS
        ? {
            status: "failed",
            error: "worker hand-off did not complete",
            finishedAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
          }
        : {
            status: "queued",
            workerBotId: null,
            startedAt: null,
            leaseOwner: null,
            leaseExpiresAt: null,
          };
    const done = await deps.prisma.backgroundTaskQueue.updateMany({
      where: { id: row.id, status: "claiming", leaseExpiresAt: row.leaseExpiresAt },
      data,
    });
    requeued += done.count;
  }
  const started = await deps.prisma.backgroundTaskQueue.findMany({
    where: { ...scope, status: "started", workerRunId: { not: null } },
    take: 200,
  });
  for (const row of started) {
    const workerRun = await deps.prisma.run.findUnique({
      where: { id: row.workerRunId! },
      select: { status: true, completedAt: true, botOutcomeReturnedAt: true },
    });
    if (workerRun && ACTIVE_RUN_STATUSES.includes(workerRun.status as never)) continue;
    // A newer run on the worker (a steering continuation) carries the task now.
    const newer = row.workerBotId
      ? await deps.prisma.run.findFirst({
          where: { botId: row.workerBotId, status: { in: [...ACTIVE_RUN_STATUSES] } },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        })
      : null;
    if (newer) {
      await deps.prisma.backgroundTaskQueue.updateMany({
        where: { id: row.id, status: "started" },
        data: { workerRunId: newer.id },
      });
      continue;
    }
    const ended = workerRun?.completedAt?.getTime() ?? 0;
    if (
      workerRun &&
      !workerRun.botOutcomeReturnedAt &&
      now.getTime() - ended < UNDELIVERED_GRACE_MS
    )
      continue;
    const done = await deps.prisma.backgroundTaskQueue.updateMany({
      where: { id: row.id, status: "started", workerRunId: row.workerRunId },
      data: {
        status: !workerRun
          ? "failed"
          : workerRun.status === "completed"
            ? "completed"
            : workerRun.status === "cancelled"
              ? "cancelled"
              : "failed",
        ...(workerRun ? {} : { error: "worker run is missing" }),
        finishedAt: now,
      },
    });
    finalized += done.count;
  }
  return { requeued, finalized };
}
