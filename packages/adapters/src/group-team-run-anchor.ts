import type { Prisma, PrismaClient } from "@rakazo/db";

/**
 * Which human request a group run belongs to is the latest human message when its turn began.
 * A retried attempt (a dispatcher restart after a timeout, a claim recheck) is a new run row
 * created later, maybe after the human already wrote again; it still carries the original turn,
 * so it dates from the first attempt of its retry chain. Without this a retry created after the
 * human's "stop" looked like a fresh turn for the stop message, and the interrupted team run was
 * never closed.
 */

/** Longest retry chain followed; real chains are at most a few attempts. */
export const TEAM_RUN_RETRY_CHAIN_MAX = 10;

type RunReader = Pick<PrismaClient, "run"> | Pick<Prisma.TransactionClient, "run">;

/** When the turn a run carries began: its own createdAt, or its first attempt's. */
export async function teamRunTurnStartedAt(
  prisma: RunReader,
  run: { id: string; createdAt: Date },
): Promise<Date> {
  let startedAt = run.createdAt;
  const own = await prisma.run.findUnique({
    where: { id: run.id },
    select: { retryOfRunId: true },
  });
  let cursor = own?.retryOfRunId ?? null;
  const seen = new Set([run.id]);
  for (let depth = 0; cursor && depth < TEAM_RUN_RETRY_CHAIN_MAX && !seen.has(cursor); depth++) {
    seen.add(cursor);
    const earlier: { createdAt: Date; retryOfRunId: string | null } | null =
      await prisma.run.findUnique({
        where: { id: cursor },
        select: { createdAt: true, retryOfRunId: true },
      });
    if (!earlier) break;
    if (earlier.createdAt < startedAt) startedAt = earlier.createdAt;
    cursor = earlier.retryOfRunId;
  }
  return startedAt;
}

/** The human message a run answers: the latest one in its thread when its turn began. */
export async function humanAnchor(
  prisma: Pick<PrismaClient, "message"> | Pick<Prisma.TransactionClient, "message">,
  threadId: string,
  at: Date,
): Promise<{ id: string; seq: number } | null> {
  return prisma.message.findFirst({
    where: { threadId, role: "user", createdAt: { lte: at } },
    orderBy: { seq: "desc" },
    select: { id: true, seq: true },
  });
}

/** The human message a run's turn answers, following a retry back to its first attempt. */
export async function humanAnchorForRun(
  prisma: Pick<PrismaClient, "message" | "run"> | Pick<Prisma.TransactionClient, "message" | "run">,
  run: { id: string; threadId: string; createdAt: Date },
): Promise<{ id: string; seq: number } | null> {
  return humanAnchor(prisma, run.threadId, await teamRunTurnStartedAt(prisma, run));
}
