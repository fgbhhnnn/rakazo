import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** Task statuses that hold a worker slot (see background-tasks.ts). */
export const SLOT_HOLDING_STATUSES = ["claiming", "started"];

/** The task a worker run carries, for attributing its result (not the worker's mutable title). */
export async function backgroundTaskForWorkerRun(
  prisma: PrismaClient,
  run: { id: string; botId: string },
) {
  return (
    (await prisma.backgroundTaskQueue.findFirst({
      where: { workerRunId: run.id },
      select: { id: true, name: true, ref: true, status: true },
    })) ??
    // Only a task not yet bound to a run (its hand-off is mid-flight) may claim an unknown run.
    // A bound task belongs to its own run, so a late result from an older run on a reused slot
    // is never credited to the task that now holds the slot.
    (await prisma.backgroundTaskQueue.findFirst({
      where: { workerBotId: run.botId, status: { in: SLOT_HOLDING_STATUSES }, workerRunId: null },
      orderBy: { startedAt: "desc" },
      select: { id: true, name: true, ref: true, status: true },
    }))
  );
}

/**
 * Called once a worker run's outcome reached the dispatcher: the task is done and its slot
 * frees, unless the worker already has a newer run for it (a steering continuation).
 */
export async function finalizeBackgroundTaskForRun(
  prisma: PrismaClient,
  run: { id: string; botId: string; status: string },
) {
  const task = await backgroundTaskForWorkerRun(prisma, run);
  if (task?.status !== "started") return;
  const newer = await prisma.run.findFirst({
    where: { botId: run.botId, id: { not: run.id }, status: { in: [...ACTIVE_RUN_STATUSES] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (newer) {
    await prisma.backgroundTaskQueue.updateMany({
      where: { id: task.id, status: "started" },
      data: { workerRunId: newer.id },
    });
    return;
  }
  await prisma.backgroundTaskQueue.updateMany({
    where: { id: task.id, status: "started" },
    data: {
      status:
        run.status === "completed"
          ? "completed"
          : run.status === "cancelled"
            ? "cancelled"
            : "failed",
      finishedAt: new Date(),
    },
  });
}
