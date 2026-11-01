import type { PrismaClient } from "@rakazo/db";
import { isHiddenBot } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { postGroupNotice } from "./group-reply-routing.js";

/**
 * Where a background worker's result or status goes. A task its dispatcher started from a
 * group turn answers in that group thread, so the dispatcher's relay (and anything it says
 * or hands off next) happens where the team works, not in the dispatcher's private chat.
 * The origin is the thread the task was queued from (BackgroundTaskQueue.threadId); it is used
 * only while the group is active, in the same space and owner, and the dispatcher is still a
 * member. Anything else returns undefined: the dispatcher's own chat, as before.
 */
export async function workerResultGroupThreadId(
  prisma: Pick<PrismaClient, "backgroundTaskQueue" | "thread">,
  input: {
    run: { id: string; spaceId: string; userId: string };
    sender: { id: string; spawnKey?: string | null };
    targetBotId: string;
    intent: string;
  },
): Promise<string | undefined> {
  const { run, sender, targetBotId } = input;
  if (!isHiddenBot(sender)) return undefined;
  if (input.intent !== "result" && input.intent !== "status") return undefined;
  const task = await prisma.backgroundTaskQueue.findFirst({
    where: { workerRunId: run.id, botId: targetBotId, spaceId: run.spaceId, userId: run.userId },
    orderBy: { createdAt: "desc" },
    select: { threadId: true },
  });
  if (!task) return undefined;
  const origin = await prisma.thread.findFirst({
    where: {
      id: task.threadId,
      group: {
        spaceId: run.spaceId,
        userId: run.userId,
        archivedAt: null,
        members: { some: { botId: targetBotId, bot: { archivedAt: null } } },
      },
    },
    select: { id: true },
  });
  return origin?.id;
}

/** Shown in the group when a background result could not be relayed after retrying. */
export function undeliveredWorkerResultNotice(taskName: string) {
  const name = taskName.trim() || "后台任务";
  return `「${name}」已结束，但结果多次重试后仍未能送达，请打开任务卡查看，或让我重新汇报。`;
}

/**
 * The reconciler retries a worker's result until UNDELIVERED_GRACE_MS, then finalizes the task.
 * For a task started in a group, that give-up is posted visibly in the group (once per worker
 * run) instead of disappearing. It wakes nobody. Never throws.
 */
export async function noticeUndeliveredWorkerResult(
  deps: Pick<ExecutorDeps, "prisma"> & { events?: Pick<ExecutorDeps["events"], "notify"> },
  row: {
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    name: string;
    workerRunId: string | null;
  },
) {
  if (!row.workerRunId) return;
  try {
    const origin = await deps.prisma.thread.findFirst({
      where: {
        id: row.threadId,
        group: { spaceId: row.spaceId, userId: row.userId, archivedAt: null },
      },
      select: { id: true },
    });
    if (!origin) return;
    await postGroupNotice(
      deps,
      {
        id: `undelivered:${row.workerRunId}`,
        spaceId: row.spaceId,
        threadId: origin.id,
        botId: row.botId,
        userId: row.userId,
      },
      undeliveredWorkerResultNotice(row.name),
    );
  } catch (error) {
    getLogger().error("undelivered worker result notice", error);
  }
}
