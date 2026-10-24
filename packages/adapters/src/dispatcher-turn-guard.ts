import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { dispatcherTurnMaxMs } from "./dispatcher-mode.js";

const DISPATCHER_WAKE_DEFER_MS = 3_000;

type TurnRun = { id: string; botId: string; threadId: string; createdAt: Date };

/**
 * Wakes for one chat run one at a time, oldest first, so each turn sees the relays already
 * written. The run dispatcher must never block on this (a waiting wake would hold a dispatch
 * slot), so a blocked wake is re-queued a few seconds out instead of polled in place.
 *
 * Within the dispatcher turn limit of the wake's age, any earlier turn that is leased or running
 * blocks it, as does an earlier queued wake. After that only a live lease or an earlier queued
 * wake does: a turn whose lease expired is dead and the dispatcher recovers it on its own.
 */
export async function earlierDispatcherTurnAlive(
  prisma: Pick<PrismaClient, "run">,
  run: TurnRun,
  options: { now?: Date; patientMs?: number } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const patient = now.getTime() - run.createdAt.getTime() < (options.patientMs ?? 0);
  const alive = await prisma.run.findFirst({
    where: {
      id: { not: run.id },
      botId: run.botId,
      threadId: run.threadId,
      OR: [
        patient
          ? { status: { in: ["leased", "running"] } }
          : { status: { in: ["leased", "running"] }, leaseExpiresAt: { gt: now } },
        { status: "queued", trigger: "bot_message", createdAt: { lt: run.createdAt } },
      ],
    },
    select: { id: true },
  });
  return Boolean(alive);
}

/** Re-queues a dispatcher wake behind an earlier live turn of its chat; true means "stop here". */
export async function deferDispatcherWake(
  deps: { prisma: Pick<PrismaClient, "run">; jobs: JobPublisher },
  run: TurnRun,
  patientMs = dispatcherTurnMaxMs(),
): Promise<boolean> {
  if (!(await earlierDispatcherTurnAlive(deps.prisma, run, { patientMs }))) return false;
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
