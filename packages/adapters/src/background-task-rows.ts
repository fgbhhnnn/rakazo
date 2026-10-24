import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * Task lifecycle. Every background_task is one durable row (the "task"), and its ref is the
 * task_id the dispatcher uses for status, follow-ups and cancel, so a reused worker slot can
 * never make an old handle point at a newer task.
 *   queued   waiting for a slot, FIFO per dispatcher
 *   claiming a slot is reserved (lease) and the hand-off to the worker is in flight
 *   started  the worker carries it (workerRunId); the slot stays held until the result is
 *            delivered to the dispatcher
 *   completed | failed | cancelled  final
 */

/** Task statuses that hold a worker slot. */
export const SLOT_HOLDING_STATUSES = ["claiming", "started"];
export const ACTIVE_TASK_STATUSES = ["queued", ...SLOT_HOLDING_STATUSES];
export const MAX_TASK_START_ATTEMPTS = 3;
/** A started task whose worker run ended this long ago without delivery is closed out. */
export const UNDELIVERED_GRACE_MS = 30 * 60_000;

/** Delivery nonce of one hand-off attempt; recovery uses it to find a run the hand-off created. */
export function taskDeliveryKey(row: { id: string }, attempts: number) {
  return `bgtask:${row.id}:${attempts}`;
}

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

/**
 * Hook for when a run's outcome was returned to its coordinator: a background task is done once
 * its worker's result reached the dispatcher, which frees its slot. Best effort; the
 * background-task reconciler finalizes anything missed here.
 */
export async function finalizeBackgroundTaskAfterReturn(prisma: PrismaClient, runId: string) {
  try {
    const ended = await prisma.run.findUnique({
      where: { id: runId },
      select: { id: true, botId: true, status: true },
    });
    if (ended && ["completed", "failed", "cancelled"].includes(ended.status)) {
      await finalizeBackgroundTaskForRun(prisma, ended);
    }
  } catch (error) {
    getLogger().error("background task finalize", error);
  }
}

/** The label of the task a worker run carries ("name #ref"), or undefined when none is known. */
export async function backgroundTaskLabel(
  prisma: PrismaClient,
  run: { id: string; botId: string },
): Promise<string | undefined> {
  const task = await backgroundTaskForWorkerRun(prisma, run).catch(() => null);
  if (!task) return undefined;
  return task.ref ? `${task.name} #${task.ref}` : task.name;
}
