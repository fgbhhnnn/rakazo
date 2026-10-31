import type { PrismaClient } from "@rakazo/db";
import { humanAnchorForRun } from "./group-team-run-anchor.js";
import { teamRunEndMakesRecheckStale } from "./group-team-run-followups.js";
import { endTeamRun } from "./group-team-run-gate.js";
import { interruptedTeamRun } from "./group-team-run-interrupted.js";

/**
 * Closing a group team run the moment the human writes again, not only when one of its own turns
 * happens to finish later: an active row whose request is older than the newest human message is
 * over ("a newer human message always ends the run"). Without this a run interrupted while a
 * member's turn was being retried stayed active forever.
 */

/** Ends the thread's active team runs started by a human message older than `anchor`. */
export async function supersedeEarlierTeamRuns(
  prisma: PrismaClient,
  threadId: string,
  anchor: { id: string; seq: number },
): Promise<string[]> {
  const active = await prisma.groupTeamRun.findMany({
    where: { threadId, status: "active", originMessageId: { not: anchor.id } },
    select: { id: true, originMessageId: true },
  });
  if (!active.length) return [];
  const origins = await prisma.message.findMany({
    where: { id: { in: active.map((row) => row.originMessageId) } },
    select: { id: true, seq: true },
  });
  const older = new Set(origins.filter((origin) => origin.seq < anchor.seq).map((o) => o.id));
  const ended: string[] = [];
  for (const row of active) {
    if (!older.has(row.originMessageId)) continue;
    if (await endTeamRun(prisma, row.id, "superseded", "human_message")) ended.push(row.id);
  }
  return ended;
}

/**
 * The request of the team run the human interrupted with `anchor`, when that run ended because of
 * it: the new leader turn is told so, and a pure "stop" closes as stopped, not completed.
 */
export async function interruptedTeamRunGoal(
  prisma: Pick<PrismaClient, "groupTeamRun" | "message">,
  threadId: string,
  anchor: { id: string; seq: number },
): Promise<string | undefined> {
  return (await interruptedTeamRun(prisma, threadId, anchor))?.goal;
}

/**
 * Whether a claim recheck of this finished turn would be stale: the team run the turn belongs to
 * already ended as completed, stopped, or overtaken by a newer human message.
 */
export async function teamRunEndedForTurn(
  prisma: Pick<PrismaClient, "groupTeamRun" | "message" | "run">,
  run: { id: string; threadId: string; createdAt: Date },
): Promise<boolean> {
  const anchor = await humanAnchorForRun(prisma, run);
  if (!anchor) return false;
  const row = await prisma.groupTeamRun.findUnique({
    where: { originMessageId: anchor.id },
    select: { status: true },
  });
  return teamRunEndMakesRecheckStale(row?.status);
}
