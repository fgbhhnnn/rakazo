import { runContinueJob } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";

/**
 * One bot works on one group turn at a time. A group wake (a stage returned to the leader, a
 * teammate's question or the answer to one) that arrives while its bot is still busy with an
 * earlier turn in the same thread is queued with a hold (`wakeAt` in the future) instead of
 * starting a second, overlapping turn. The busy turn releases it when it ends; if that turn
 * never reaches its end hook (it failed), the hold simply expires and the run starts then.
 */

type Tx = Prisma.TransactionClient;

/** Longest a held wake waits for the busy turn before it starts anyway. */
export const GROUP_HELD_RUN_MAX_MS = 10 * 60_000;

const BUSY_STATUSES = ["queued", "leased", "running", "waiting_takeover"];

/** clientNonce prefixes of the group wakes that may be held (and released) here. */
const HELD_SOURCE_PREFIXES = ["group-handoff:", "group-question:"];
const HELD_RUN_PREFIXES = ["group-answer:", "stage-output:"];

/**
 * Inside the transaction that queues a wake for `botId`: the `wakeAt` to hold it with when the
 * bot already has a turn in this thread, else undefined (start now).
 */
export async function holdWhileBusy(
  tx: Tx,
  input: { threadId: string; botId: string; exceptRunIds?: readonly string[] },
  now = new Date(),
): Promise<Date | undefined> {
  const busy = await tx.run.findFirst({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      status: { in: BUSY_STATUSES },
      ...(input.exceptRunIds?.length ? { id: { notIn: [...input.exceptRunIds] } } : {}),
    },
    select: { id: true },
  });
  return busy ? new Date(now.getTime() + GROUP_HELD_RUN_MAX_MS) : undefined;
}

/**
 * After a group turn of `run.botId` ended: starts the oldest wake held for that bot in this
 * thread, unless another of its turns is still working. Never throws.
 */
export async function releaseHeldGroupRun(
  deps: { prisma: Pick<PrismaClient, "run">; jobs: Pick<ExecutorDeps["jobs"], "enqueue"> },
  run: { id: string; threadId: string; botId: string },
  now = new Date(),
): Promise<string | undefined> {
  try {
    const working = await deps.prisma.run.findFirst({
      where: {
        threadId: run.threadId,
        botId: run.botId,
        id: { not: run.id },
        status: { in: ["leased", "running"] },
      },
      select: { id: true },
    });
    if (working) return undefined;
    const held = await deps.prisma.run.findFirst({
      where: {
        threadId: run.threadId,
        botId: run.botId,
        status: "queued",
        leaseOwner: null,
        trigger: "follow_up",
        wakeAt: { gt: now },
        OR: [
          ...HELD_SOURCE_PREFIXES.map((prefix) => ({
            sourceMessage: { clientNonce: { startsWith: prefix } },
          })),
          ...HELD_RUN_PREFIXES.map((prefix) => ({ clientNonce: { startsWith: prefix } })),
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (!held) return undefined;
    // Without keepExisting the wake replaces the hold with "now".
    await deps.jobs.enqueue(runContinueJob(held.id));
    return held.id;
  } catch (error) {
    getLogger().error("release held group run", error);
    return undefined;
  }
}
