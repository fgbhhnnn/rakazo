import {
  type HandoffFailureReason,
  nextLeaderStreak,
  type TeamRunStatus,
  teamRunBudget,
  teamRunWithinBudget,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { humanAnchorForRun } from "./group-team-run-anchor.js";
import { cancelTeamRunFollowUps } from "./group-team-run-followups.js";

export { humanAnchor } from "./group-team-run-anchor.js";

/**
 * The code-enforced guards of a group team run (see group-team-run.ts) that the shared handoff
 * path applies inside its transaction: the run's own handoff and time budget, the leader's loop
 * guard, and "a newer human message ends the run".
 */

type Tx = Prisma.TransactionClient;

export async function newerHumanMessage(
  prisma: Pick<PrismaClient, "message">,
  threadId: string,
  seq: number,
): Promise<boolean> {
  const newer = await prisma.message.findFirst({
    where: { threadId, role: "user", seq: { gt: seq } },
    select: { id: true },
  });
  return Boolean(newer);
}

export async function endTeamRun(
  prisma: PrismaClient | Tx,
  id: string,
  status: Exclude<TeamRunStatus, "active">,
  endReason: string,
) {
  // Only an active run ends, so two racing decisions cannot both post their notice.
  const ended = await prisma.groupTeamRun.updateManyAndReturn({
    where: { id, status: "active" },
    data: { status, endReason, endedAt: new Date() },
    select: { id: true, threadId: true, originMessageId: true },
  });
  const row = ended[0];
  if (!row) return false;
  // A reminder or claim recheck still queued for it would post after the run ended.
  await cancelTeamRunFollowUps(prisma, row, status);
  return true;
}

export type TeamHandoffGate =
  | { kind: "none" }
  | { kind: "refused"; reason: HandoffFailureReason; error: string }
  | { kind: "team"; runId: string; leaderId: string; allowHandBack: boolean };

/**
 * Inside the handoff transaction: whether a handoff from `run` belongs to an active team run,
 * and if so whether its budget, loop guard and the human's latest message allow it. Locks the
 * team run row so concurrent handoffs count once each.
 */
export async function teamRunHandoffGate(
  tx: Tx,
  run: { id: string; threadId: string; botId: string },
  targetId: string,
  now = new Date(),
): Promise<TeamHandoffGate> {
  const source = await tx.run.findUnique({ where: { id: run.id }, select: { createdAt: true } });
  if (!source) return { kind: "none" };
  // A retried attempt answers the request its first attempt answered (group-team-run-anchor.ts).
  const anchor = await humanAnchorForRun(tx, {
    id: run.id,
    threadId: run.threadId,
    createdAt: source.createdAt,
  });
  if (!anchor) return { kind: "none" };
  await tx.$queryRaw`SELECT id FROM group_team_runs WHERE "originMessageId" = ${anchor.id} FOR UPDATE`;
  const row = await tx.groupTeamRun.findUnique({ where: { originMessageId: anchor.id } });
  if (row?.status !== "active") return { kind: "none" };
  if (await newerHumanMessage(tx, run.threadId, anchor.seq)) {
    await endTeamRun(tx, row.id, "superseded", "human_message");
    return {
      kind: "refused",
      reason: "team_interrupted",
      error: "the user sent a new message, so this team task stopped; do not hand off",
    };
  }
  if (!teamRunWithinBudget(row, now, teamRunBudget())) {
    await endTeamRun(tx, row.id, "stopped", "budget");
    return {
      kind: "refused",
      reason: "team_budget",
      error: "this team task reached its handoff or time budget; it is paused for the user",
    };
  }
  if (run.botId === row.leaderBotId && nextLeaderStreak(row, targetId).loop) {
    await endTeamRun(tx, row.id, "paused", "loop");
    return {
      kind: "refused",
      reason: "team_loop",
      error: "the same stage went back and forth too many times; the team task is paused",
    };
  }
  return {
    kind: "team",
    runId: row.id,
    leaderId: row.leaderBotId,
    // Inside a team run a stage may return to the leader, and the leader may send it back once
    // more; two members still never bounce a stage between themselves.
    allowHandBack: targetId === row.leaderBotId || run.botId === row.leaderBotId,
  };
}

/** Counts a handoff the gate allowed, in the same transaction that recorded it. */
export async function recordTeamRunHandoff(
  tx: Tx,
  gate: Extract<TeamHandoffGate, { kind: "team" }>,
  sourceBotId: string,
  targetId: string,
) {
  const row = await tx.groupTeamRun.findUniqueOrThrow({ where: { id: gate.runId } });
  const leaderStep = sourceBotId === gate.leaderId ? nextLeaderStreak(row, targetId) : undefined;
  await tx.groupTeamRun.update({
    where: { id: gate.runId },
    data: {
      hops: { increment: 1 },
      nudges: 0,
      ...(leaderStep
        ? { lastLeaderTargetId: targetId, leaderTargetStreak: leaderStep.streak }
        : {}),
    },
  });
}
