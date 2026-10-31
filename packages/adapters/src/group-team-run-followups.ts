import type { TeamRunStatus } from "@rakazo/core";
import { cancelRunsInTransaction, type Prisma, type PrismaClient } from "@rakazo/db";
import { CLAIM_RECHECK_MARKER } from "./dispatcher-reply-guard.js";
import { humanAnchorForRun } from "./group-team-run-anchor.js";

/**
 * Turns queued for a group team run that only make sense while it is active. When the run ends
 * (closed by its leader, stopped, paused, or overtaken by a newer human message) a reminder still
 * waiting in the queue ("团队任务还没结束…") or a claim recheck of one of its turns would make the
 * leader post again after the closing summary, so they are cancelled before they start.
 */

type Tx = Prisma.TransactionClient;

/** clientNonce prefix of the system's reminder turn for the leader of one team run. */
export function teamNudgeNoncePrefix(teamRunId: string): string {
  return `team-nudge:${teamRunId}:`;
}

/** Ends after which a queued claim recheck of the run's turns is stale, not a correction. */
const RECHECK_STALE_ENDS: ReadonlySet<TeamRunStatus> = new Set([
  "completed",
  "stopped",
  "superseded",
]);

/** Whether a run that ended with `status` makes a claim recheck of its turns stale. */
export function teamRunEndMakesRecheckStale(status: string | null | undefined): boolean {
  return RECHECK_STALE_ENDS.has(status as TeamRunStatus);
}

/**
 * Cancels the queued, never-started follow-up turns of an ended team run. Only rows still
 * `queued` without a lease flip, in the same conditional update the run claim uses, so a turn
 * that already started is never touched. Returns the cancelled run ids.
 */
export async function cancelTeamRunFollowUpsInTransaction(
  tx: Tx,
  row: { id: string; threadId: string; originMessageId: string },
  status: TeamRunStatus,
): Promise<string[]> {
  const nudges = await tx.run.findMany({
    where: {
      threadId: row.threadId,
      status: "queued",
      OR: [
        { clientNonce: { startsWith: teamNudgeNoncePrefix(row.id) } },
        // Reminders queued before they stopped being posted in the chat.
        { sourceMessage: { clientNonce: { startsWith: teamNudgeNoncePrefix(row.id) } } },
      ],
    },
    select: { id: true },
  });
  const rechecks: { id: string }[] = [];
  if (teamRunEndMakesRecheckStale(status)) {
    const candidates = await tx.run.findMany({
      where: {
        threadId: row.threadId,
        status: "queued",
        retryOfRunId: { not: null },
        task: { prompt: { contains: CLAIM_RECHECK_MARKER } },
      },
      select: { id: true, threadId: true, createdAt: true },
      take: 20,
    });
    for (const candidate of candidates) {
      const anchor = await humanAnchorForRun(tx, candidate);
      if (anchor?.id === row.originMessageId) rechecks.push({ id: candidate.id });
    }
  }
  const ids = [...new Set([...nudges, ...rechecks].map((run) => run.id))];
  if (!ids.length) return [];
  const now = new Date();
  const cancelled = await tx.run.updateManyAndReturn({
    where: { id: { in: ids }, status: "queued", leaseOwner: null },
    data: { status: "cancelled", completedAt: now, wakeAt: null },
    select: { id: true, taskId: true, userId: true, spaceId: true },
  });
  await cancelRunsInTransaction(tx, cancelled, now);
  return cancelled.map((run) => run.id);
}

/** Same, opening its own transaction when the caller is not inside one. */
export async function cancelTeamRunFollowUps(
  prisma: PrismaClient | Tx,
  row: { id: string; threadId: string; originMessageId: string },
  status: TeamRunStatus,
): Promise<string[]> {
  if ("$transaction" in prisma) {
    return prisma.$transaction((tx) => cancelTeamRunFollowUpsInTransaction(tx, row, status));
  }
  return cancelTeamRunFollowUpsInTransaction(prisma, row, status);
}
