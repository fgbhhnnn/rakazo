import type { TaskProgressEntry } from "@rakazo/contracts";
import { TASK_PROGRESS_STEP_MAX_LENGTH } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { workerReportText } from "./worker-turn-error.js";

/** A reconciler may have read a failure before another attempt committed its result. */
export async function completedWorkerNeedsResult(prisma: PrismaClient, runId: string) {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { status: true, botOutcomeReturnedAt: true },
  });
  return run?.status === "completed" && !run.botOutcomeReturnedAt;
}

/** Progress cards have a separate failure notice path; apply the same policy before posting. */
export async function suppressObsoleteFailureMilestones(
  prisma: PrismaClient,
  entries: TaskProgressEntry[],
  snapshots: ReadonlyMap<string, { row: { workerRunId: string | null } }>,
): Promise<TaskProgressEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      if (entry.state === "failed" && entry.step)
        entry = {
          ...entry,
          step: workerReportText(entry.step).slice(0, TASK_PROGRESS_STEP_MAX_LENGTH),
        };
      const runId = snapshots.get(entry.ref)?.row.workerRunId;
      if (
        entry.state !== "failed" ||
        !runId ||
        entry.notified?.includes("failed") ||
        !(await suppressObsoleteWorkerReport(prisma, runId, "failure"))
      )
        return entry;
      return { ...entry, notified: [...(entry.notified ?? []), "failed" as const] };
    }),
  );
}

/** Compare durable task identity, never infer sameness from prose or a bot's role. */
export async function suppressObsoleteWorkerReport(
  prisma: PrismaClient,
  runId: string,
  kind: "result" | "status" | "failure" | "undelivered",
): Promise<boolean> {
  const task = await prisma.backgroundTaskQueue.findFirst({ where: { workerRunId: runId } });
  if (!task) return false;
  if (task.status === "cancelled") return true;
  if (kind === "result") return false;
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
  // Completed turns may legitimately return a progress-only status, without claiming failure.
  if (kind === "status" && run?.status !== "failed" && run?.status !== "cancelled") return false;
  // Delivery failures never turn finished work into failed work.
  if (
    (kind === "failure" || kind === "status") &&
    (run?.status === "completed" || task.status === "completed")
  )
    return true;
  const replacement = await prisma.backgroundTaskQueue.findFirst({
    where: {
      spaceId: task.spaceId,
      userId: task.userId,
      threadId: task.threadId,
      id: { not: task.id },
      OR: [
        { createdAt: { gt: task.createdAt } },
        { createdAt: task.createdAt, id: { gt: task.id } },
      ],
      AND: [
        {
          OR: [
            ...(task.taskHash
              ? [
                  {
                    botId: task.botId,
                    taskHash: task.taskHash,
                    status: { in: ["queued", "claiming", "started", "completed"] },
                  },
                ]
              : []),
            { name: task.name, status: "completed" },
          ],
        },
      ],
    },
    select: { id: true },
  });
  if (replacement) return true;
  const parent = await prisma.run.findUnique({
    where: { id: task.runId },
    select: { status: true, createdAt: true },
  });
  if (parent?.status === "cancelled" || parent?.status === "failed") return true;
  // A completed dispatch turn is normal. A later human turn is the explicit move on.
  return Boolean(
    parent &&
      (await prisma.run.findFirst({
        where: { threadId: task.threadId, trigger: "user", createdAt: { gt: parent.createdAt } },
        select: { id: true },
      })),
  );
}
