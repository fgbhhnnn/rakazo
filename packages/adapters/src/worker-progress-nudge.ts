/**
 * Optional, low-risk nudge: if a started worker run has been alive longer than
 * PROGRESS_NUDGE_AFTER_MS with no report_progress note, inject a short reminder
 * as a steering message so the worker reports progress. Cap once per run.
 */

import type { MessageBlock } from "@rakazo/contracts";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  type PrismaClient,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { WORKER_PROGRESS_NOTICE } from "./worker-progress.js";

/** ~45 minutes with no report_progress before a single reminder. */
export const PROGRESS_NUDGE_AFTER_MS = 45 * 60_000;

const NUDGE_TEXT =
  "[系统提醒] 你已经工作较久且还没有用 report_progress 留下进度。请用 report_progress 简短说明当前做到哪一步、下一步是什么，然后继续任务。不要停下来只回复这条提醒。";

/** Pure decision for tests and the scan loop. */
export function shouldNudgeWorkerProgress(input: {
  runStatus: string;
  runCreatedAt: Date;
  taskStartedAt: Date | null;
  hasProgressNote: boolean;
  alreadyNudged: boolean;
  now: Date;
  afterMs: number;
}): boolean {
  if (!["queued", "leased", "running"].includes(input.runStatus)) return false;
  if (input.hasProgressNote || input.alreadyNudged) return false;
  const cutoff = input.now.getTime() - input.afterMs;
  if (input.runCreatedAt.getTime() > cutoff) return false;
  if (input.taskStartedAt != null && input.taskStartedAt.getTime() > cutoff) return false;
  return true;
}

/**
 * Best-effort: for each started background task whose worker run is older than
 * the threshold and has no report_progress note, steer one reminder. Never throws.
 */
export async function nudgeStaleWorkerProgress(
  deps: {
    prisma: PrismaClient;
    events: { notify: (threadId: string, seq: number) => Promise<void> };
  },
  options: { now?: Date; afterMs?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const afterMs = options.afterMs ?? PROGRESS_NUDGE_AFTER_MS;
  const cutoff = new Date(now.getTime() - afterMs);
  let nudged = 0;
  try {
    const rows = await deps.prisma.backgroundTaskQueue.findMany({
      where: {
        status: "started",
        workerRunId: { not: null },
        startedAt: { lte: cutoff },
      },
      take: 20,
      select: {
        id: true,
        workerBotId: true,
        workerRunId: true,
        startedAt: true,
      },
    });
    for (const row of rows) {
      if (!row.workerRunId || !row.workerBotId) continue;
      const run = await deps.prisma.run.findUnique({
        where: { id: row.workerRunId },
        select: {
          id: true,
          status: true,
          spaceId: true,
          threadId: true,
          botId: true,
          userId: true,
          createdAt: true,
        },
      });
      if (!run) continue;
      const noted = await deps.prisma.event.findFirst({
        where: {
          runId: run.id,
          type: "thread.progress",
          payload: { path: ["notice"], equals: WORKER_PROGRESS_NOTICE },
        },
        select: { id: true },
      });
      const already = await deps.prisma.event.findFirst({
        where: {
          runId: run.id,
          type: "thread.message.created",
          payload: { path: ["nudge"], equals: "report_progress" },
        },
        select: { id: true },
      });
      if (
        !shouldNudgeWorkerProgress({
          runStatus: run.status,
          runCreatedAt: run.createdAt,
          taskStartedAt: row.startedAt,
          hasProgressNote: Boolean(noted),
          alreadyNudged: Boolean(already),
          now,
          afterMs,
        })
      ) {
        continue;
      }
      const ok = await steerNudge(deps, run).catch((error) => {
        getLogger().warn("worker progress nudge failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
        return false;
      });
      if (ok) nudged += 1;
    }
  } catch (error) {
    getLogger().warn("worker progress nudge scan failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return nudged;
}

async function steerNudge(
  deps: {
    prisma: PrismaClient;
    events: { notify: (threadId: string, seq: number) => Promise<void> };
  },
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
  },
): Promise<boolean> {
  const block: MessageBlock = {
    kind: "text",
    text: NUDGE_TEXT,
  };
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM runs WHERE id = ${run.id} FOR UPDATE`;
      const status = locked[0]?.status;
      if (!status || !["queued", "leased", "running"].includes(status)) return null;
      const message = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        role: "user",
        blocks: [block],
        runId: run.id,
      });
      await tx.steeringMessage.create({
        data: {
          messageId: message.id,
          botId: run.botId,
          userId: run.userId,
          runId: run.id,
        },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        type: "thread.message.created",
        runId: run.id,
        payload: {
          messageId: message.id,
          role: "user",
          blocks: message.blocks,
          nudge: "report_progress",
        },
      });
      return event.seq;
    }),
  );
  if (committed == null) return false;
  await deps.events.notify(run.threadId, committed).catch(() => undefined);
  return true;
}
