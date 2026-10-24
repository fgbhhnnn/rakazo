import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

const DISPATCHER_WAKE_DEFER_MS = 3_000;

type TurnRun = { id: string; botId: string; threadId: string; createdAt: Date };

/** Whether an earlier main turn of this chat is still alive: a live lease, or queued before us. */
export async function earlierDispatcherTurnAlive(
  prisma: Pick<PrismaClient, "run">,
  run: TurnRun,
  now = new Date(),
): Promise<boolean> {
  const alive = await prisma.run.findFirst({
    where: {
      id: { not: run.id },
      botId: run.botId,
      threadId: run.threadId,
      OR: [
        { status: { in: ["leased", "running"] }, leaseExpiresAt: { gt: now } },
        { status: "queued", trigger: "bot_message", createdAt: { lt: run.createdAt } },
      ],
    },
    select: { id: true },
  });
  return Boolean(alive);
}

/**
 * Called when a dispatcher wake is still blocked after waiting for earlier turns. If an earlier
 * turn is alive, the wake is re-enqueued shortly instead of running two main turns side by side
 * (returns true: the caller stops). A turn whose lease expired is dead; the reconciler recovers
 * it and this wake proceeds (returns false).
 */
export async function deferDispatcherWake(
  deps: { prisma: Pick<PrismaClient, "run">; jobs: JobPublisher },
  run: TurnRun,
): Promise<boolean> {
  if (!(await earlierDispatcherTurnAlive(deps.prisma, run))) return false;
  await deps.jobs.enqueue({
    ...runContinueJob(run.id),
    availableAt: new Date(Date.now() + DISPATCHER_WAKE_DEFER_MS),
  });
  getLogger().info("dispatcher wake deferred behind an earlier turn", { runId: run.id });
  return true;
}

/** Stand-in for a dispatcher without a computer; any attempt to start it fails clearly. */
export function dispatcherComputerPlaceholder(botId: string) {
  return {
    id: `no-computer:${botId}`,
    scope: "bot",
    kind: "none",
    providerRef: null,
    homeKey: botId,
  } as never;
}
