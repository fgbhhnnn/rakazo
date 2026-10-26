/**
 * When a hidden worker's final text is incomplete, keep the same background task open and
 * start another run on the same worker with a continue instruction — or mark the task failed
 * after MAX_INCOMPLETE_CONTINUES. New file; hooked from returnBotMessageOutcome.
 */
import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  type Prisma,
  type PrismaClient,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { backgroundTaskForWorkerRun } from "./background-task-rows.js";
import type { ExecutorDeps } from "./executor.js";
import {
  buildIncompleteContinueMessage,
  type IncompleteReason,
  incompleteContinueCount,
  incompleteExhaustedNote,
  MAX_INCOMPLETE_CONTINUES,
  userFacingIncompleteText,
  withIncompleteContinueArgs,
} from "./worker-incomplete-result.js";

type ContinueDeps = Pick<ExecutorDeps, "prisma" | "jobs"> & {
  events: { notify: (threadId: string, seq: number) => Promise<void> };
};

export type IncompleteContinueDecision =
  | { action: "continue"; runId: string; attempt: number; cleanedText: string }
  | { action: "fail"; cleanedText: string; continues: number; note: string }
  | { action: "skip" };

/**
 * Decide and, when continuing, start the next worker run on the same task. Call while the
 * ending run is still the task's workerRunId and the task is started.
 */
export async function handleIncompleteWorkerResult(
  deps: ContinueDeps,
  input: {
    run: {
      id: string;
      spaceId: string;
      threadId: string;
      botId: string;
      userId: string;
    };
    dispatcher: { id: string; name: string };
    text: string;
    reason: IncompleteReason;
    maxContinues?: number;
  },
): Promise<IncompleteContinueDecision> {
  const max = input.maxContinues ?? MAX_INCOMPLETE_CONTINUES;
  const cleanedText = userFacingIncompleteText(input.text);
  const task = await backgroundTaskForWorkerRun(deps.prisma, input.run);
  if (task?.status !== "started") return { action: "skip" };

  const row = await deps.prisma.backgroundTaskQueue.findUnique({
    where: { id: task.id },
    select: {
      id: true,
      args: true,
      status: true,
      workerBotId: true,
      workerRunId: true,
      ref: true,
      name: true,
    },
  });
  if (row?.status !== "started" || row.workerBotId !== input.run.botId) {
    return { action: "skip" };
  }

  const prior = incompleteContinueCount(row.args);
  const next = prior + 1;
  if (next > max) {
    const note = incompleteExhaustedNote({
      reason: input.reason,
      cleanedText,
      continues: prior,
    });
    await deps.prisma.backgroundTaskQueue.updateMany({
      where: { id: row.id, status: "started" },
      data: {
        status: "failed",
        finishedAt: new Date(),
        error: `incomplete after ${prior} auto-continue(s): ${input.reason}`,
        args: withIncompleteContinueArgs(row.args, prior, false) as Prisma.InputJsonValue,
      },
    });
    return { action: "fail", cleanedText, continues: prior, note };
  }

  const continueText = buildIncompleteContinueMessage({
    reason: input.reason,
    priorText: cleanedText,
    attempt: next,
    maxAttempts: max,
  });

  let nextRunId: string;
  try {
    nextRunId = await startWorkerContinueRun(deps, {
      run: input.run,
      dispatcher: input.dispatcher,
      message: continueText,
      deliveryKey: `incomplete-continue:${row.id}:${next}`,
    });
  } catch (error) {
    getLogger().error("incomplete worker continue failed to start", error);
    const note = incompleteExhaustedNote({
      reason: input.reason,
      cleanedText,
      continues: prior,
    });
    await deps.prisma.backgroundTaskQueue.updateMany({
      where: { id: row.id, status: "started" },
      data: {
        status: "failed",
        finishedAt: new Date(),
        error: `incomplete continue failed to start: ${error instanceof Error ? error.message : String(error)}`,
        args: withIncompleteContinueArgs(row.args, prior, false) as Prisma.InputJsonValue,
      },
    });
    return { action: "fail", cleanedText, continues: prior, note };
  }

  await deps.prisma.backgroundTaskQueue.updateMany({
    where: { id: row.id, status: "started" },
    data: {
      workerRunId: nextRunId,
      finishedAt: null,
      error: null,
      args: withIncompleteContinueArgs(row.args, next, true) as Prisma.InputJsonValue,
    },
  });

  await deps.jobs.enqueue(runContinueJob(nextRunId)).catch((error) => {
    getLogger().error("incomplete worker continue enqueue", error);
  });

  return { action: "continue", runId: nextRunId, attempt: next, cleanedText };
}

async function startWorkerContinueRun(
  deps: ContinueDeps,
  input: {
    run: {
      id: string;
      spaceId: string;
      threadId: string;
      botId: string;
      userId: string;
    };
    dispatcher: { id: string; name: string };
    message: string;
    deliveryKey: string;
  },
): Promise<string> {
  const clientNonce = `bot-message:${input.deliveryKey}`;
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.run.threadId} FOR UPDATE`;
      const already = await tx.message.findUnique({
        where: {
          threadId_clientNonce: { threadId: input.run.threadId, clientNonce },
        },
        select: { runId: true },
      });
      if (already?.runId) return { runId: already.runId };

      const inboundBlock: MessageBlock = {
        kind: "bot_message_received",
        fromBotId: input.dispatcher.id,
        fromBotName: input.dispatcher.name,
        text: input.message,
        intent: "request",
      };
      const inbound = await createThreadMessageInTransaction(tx, {
        threadId: input.run.threadId,
        role: "user",
        blocks: [inboundBlock],
        clientNonce,
      });
      const task = await tx.task.create({
        data: {
          spaceId: input.run.spaceId,
          botId: input.run.botId,
          threadId: input.run.threadId,
          userId: input.run.userId,
          prompt: input.message,
          status: "queued",
        },
      });
      const nextRun = await tx.run.create({
        data: {
          spaceId: input.run.spaceId,
          botId: input.run.botId,
          threadId: input.run.threadId,
          taskId: task.id,
          userId: input.run.userId,
          status: "queued",
          trigger: "bot_message",
          sourceMessageId: inbound.id,
        },
        select: { id: true },
      });
      await tx.message.update({ where: { id: inbound.id }, data: { runId: nextRun.id } });
      const event = await appendEventInTransaction(tx, {
        spaceId: input.run.spaceId,
        threadId: input.run.threadId,
        botId: input.run.botId,
        type: "thread.message.created",
        runId: nextRun.id,
        payload: { messageId: inbound.id, role: "user", blocks: inbound.blocks },
      });
      return { runId: nextRun.id, seq: event.seq };
    }),
  );

  if ("seq" in committed && committed.seq !== undefined) {
    await deps.events.notify(input.run.threadId, committed.seq).catch(() => undefined);
  }
  return committed.runId;
}

/** Clear the continuing flag once a later run produces a real result (or fails). */
export async function clearIncompleteContinuingFlag(
  prisma: PrismaClient,
  taskId: string,
): Promise<void> {
  const row = await prisma.backgroundTaskQueue.findUnique({
    where: { id: taskId },
    select: { args: true },
  });
  if (!row) return;
  const count = incompleteContinueCount(row.args);
  await prisma.backgroundTaskQueue.updateMany({
    where: { id: taskId },
    data: { args: withIncompleteContinueArgs(row.args, count, false) as Prisma.InputJsonValue },
  });
}
