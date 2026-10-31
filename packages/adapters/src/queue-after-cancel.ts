import type { PrismaClient } from "@rakazo/db";
import { laneQueueOrder } from "./background-task-lanes.js";
import { SLOT_HOLDING_STATUSES } from "./background-task-rows.js";

/**
 * What the queue did after a cancel freed slots: which of the tasks queued before the cancel have
 * now started, and where the rest stand. Without this the dispatcher only had its earlier status
 * call, and told the user a task that had just started was "still queued, #1".
 */
export async function queueChangeAfterCancel(
  prisma: Pick<PrismaClient, "backgroundTaskQueue">,
  botId: string,
  queuedBefore: readonly string[],
) {
  const rows = queuedBefore.length
    ? await prisma.backgroundTaskQueue.findMany({
        where: { id: { in: [...queuedBefore] } },
        select: { id: true, ref: true, name: true, status: true },
      })
    : [];
  const started = rows
    .filter((row) => SLOT_HOLDING_STATUSES.includes(row.status))
    .map((row) => ({ task_id: row.ref ?? row.id, name: row.name }));
  const stillQueued = await prisma.backgroundTaskQueue.findMany({
    where: { botId, status: "queued" },
    orderBy: { createdAt: "asc" },
    select: { id: true, ref: true, name: true, args: true },
  });
  // Positions are per lane: each lane is its own queue.
  const order = laneQueueOrder(stillQueued);
  return {
    started_from_queue: started,
    still_queued: stillQueued.map((row) => ({
      task_id: row.ref ?? row.id,
      name: row.name,
      position: order.get(row.id) ?? 1,
    })),
  };
}

export const QUEUE_AFTER_CANCEL_NOTE =
  " Tasks in started_from_queue just started in the freed slot: say they have started, not that they are queued; still_queued gives the current queue positions.";
