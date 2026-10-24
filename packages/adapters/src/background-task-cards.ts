import type { MessageBlock } from "@rakazo/contracts";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";

/** The chat card for a started background task: its title and #ref, linking the worker's live progress. */
export function backgroundTaskCard(
  workerId: string,
  name: string,
  ref: string,
): Extract<MessageBlock, { kind: "child_bot" }> {
  return {
    kind: "child_bot",
    botId: workerId,
    name: `后台任务：${name} #${ref}`,
    title: `任务 #${ref} · 点开看实时进度`,
    status: "created",
  };
}

/**
 * Posts the card of a task that started from the queue. The background_task call that queued it
 * has returned long ago, so the dispatcher's own thread gets the card here, attributed to the run
 * doing the hand-off (or the ended run that queued it). Best effort: a lost card never stops a task.
 */
export async function announceQueuedTaskStart(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  run: { id: string; spaceId: string; threadId: string; botId: string },
  task: { workerId: string; name: string; ref: string },
): Promise<void> {
  const blocks: MessageBlock[] = [backgroundTaskCard(task.workerId, task.name, task.ref)];
  try {
    const event = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        const message = await createThreadMessageInTransaction(tx, {
          threadId: run.threadId,
          role: "bot",
          blocks,
          botId: run.botId,
          runId: run.id,
          allowCancelledRun: true,
        });
        return appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          runId: run.id,
          type: "thread.message.created",
          allowCancelledRun: true,
          payload: { messageId: message.id, role: "bot", blocks },
        });
      }),
    );
    await deps.events.notify(run.threadId, event.seq).catch(() => undefined);
  } catch (error) {
    getLogger().error("queued background task card", error);
  }
}
