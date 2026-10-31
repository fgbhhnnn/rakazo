import type { MessageBlock } from "@rakazo/contracts";
import type { TeamRunStatus } from "@rakazo/core";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  cancelRunsInTransaction,
  withTransactionRetry,
} from "@rakazo/db";
import { cancelTeamRunFollowUps } from "./group-team-run-followups.js";
import { interruptedTeamRun } from "./group-team-run-interrupted.js";

type Db = Prisma.TransactionClient;
type Team = { id: string; threadId: string; originMessageId: string; status: string };

export async function endTeamRunAndCancel(
  prisma: PrismaClient | Db,
  id: string,
  status: Exclude<TeamRunStatus, "active">,
  endReason: string,
): Promise<boolean> {
  if ("$transaction" in prisma) {
    return withTransactionRetry(() =>
      prisma.$transaction((tx) => recordTeamRunEnd(tx, id, status, endReason)),
    );
  }
  return recordTeamRunEnd(prisma, id, status, endReason);
}

async function recordTeamRunEnd(
  tx: Db,
  id: string,
  status: Exclude<TeamRunStatus, "active">,
  endReason: string,
): Promise<boolean> {
  const current = await tx.groupTeamRun.findUnique({ where: { id }, select: { threadId: true } });
  if (!current) return false;
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${current.threadId} FOR UPDATE`;
  // Only one racing close can win and post its existing completion/stopped notice.
  const ended = await tx.groupTeamRun.updateManyAndReturn({
    where: { id, status: "active" },
    data: { status, endReason, endedAt: new Date() },
    select: { id: true, threadId: true, originMessageId: true },
  });
  const row = ended[0];
  if (!row) return false;
  if (teamWorkMustStop(status)) {
    await cancelTeamRunWork(tx, { ...row, status });
    if (endReason === "leader_stopped") await stopInterruptedTeamRun(tx, row);
  }
  await cancelTeamRunFollowUps(tx, row, status);
  return true;
}

/** A stop decision also stops the request this leader turn interrupted, atomically. */
async function stopInterruptedTeamRun(tx: Db, row: Omit<Team, "status">) {
  const anchor = await tx.message.findUnique({
    where: { id: row.originMessageId },
    select: { id: true, seq: true },
  });
  if (!anchor) return;
  const interrupted = await interruptedTeamRun(tx, row.threadId, anchor);
  if (!interrupted) return;
  const stopped = await tx.groupTeamRun.updateManyAndReturn({
    where: { id: interrupted.id, status: "superseded" },
    data: { status: "stopped", endReason: "leader_stopped", endedAt: new Date() },
    select: { id: true, threadId: true, originMessageId: true, status: true },
  });
  if (!stopped[0]) return;
  await cancelTeamRunWork(tx, stopped[0]);
  await cancelTeamRunFollowUps(tx, stopped[0], "stopped");
}

/**
 * There is no teamRunId on runs/messages. Follow durable provenance instead of cancelling
 * every bot in a thread: the origin message, retry source, handoff/question nonce, nudge
 * nonce, and bot-message returnToMessageId. BackgroundTaskQueue.runId links workers to
 * their member turn, including the interval before workerRunId is bound. Never infer
 * ownership from a bot's worker slot (it can already be carrying unrelated work).
 */
export async function teamRunOwningWork(
  db: Db,
  runId: string,
  seen = new Set<string>(),
): Promise<Team | undefined> {
  if (seen.has(runId)) return undefined;
  seen.add(runId);
  const run = await db.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      threadId: true,
      botId: true,
      retryOfRunId: true,
      clientNonce: true,
      sourceMessageId: true,
      thread: { select: { groupId: true } },
      sourceMessage: { select: { runId: true, clientNonce: true, blocks: true } },
    },
  });
  if (!run) return undefined;
  if (run.retryOfRunId) return teamRunOwningWork(db, run.retryOfRunId, seen);
  const nudge = (run.clientNonce ?? run.sourceMessage?.clientNonce)?.match(/^team-nudge:([^:]+):/);
  const team = nudge
    ? await db.groupTeamRun.findUnique({ where: { id: nudge[1] } })
    : run.sourceMessageId && run.thread?.groupId
      ? await db.groupTeamRun.findUnique({ where: { originMessageId: run.sourceMessageId } })
      : null;
  if (team) {
    if (team.threadId !== run.threadId) return undefined;
    if (team.leaderBotId === run.botId) return team;
    const member = await db.chatGroupMember.findUnique({
      where: { groupId_botId: { groupId: team.groupId, botId: run.botId } },
      select: { botId: true },
    });
    return member ? team : undefined;
  }
  const source = run.sourceMessage;
  if (!source) return undefined;
  const handoff = source.clientNonce?.match(/^group-(?:handoff|question):([^:]+)$/);
  if (handoff) {
    const owner = await teamRunOwningWork(db, handoff[1]!, seen);
    // Group handoffs never transfer team ownership into another group or private chat.
    return owner?.threadId === run.threadId ? owner : undefined;
  }
  const delivery = source.clientNonce?.match(/^bot-message:bgtask:([^:]+):/);
  if (delivery) {
    const task = await db.backgroundTaskQueue.findUnique({
      where: { id: delivery[1] },
      select: { runId: true },
    });
    return task ? teamRunOwningWork(db, task.runId, seen) : undefined;
  }
  const received = Array.isArray(source.blocks)
    ? (source.blocks as MessageBlock[]).find((b) => b.kind === "bot_message_received")
    : undefined;
  if (received?.kind === "bot_message_received" && received.returnToMessageId) {
    const outbound = await db.message.findUnique({
      where: { id: received.returnToMessageId },
      select: { runId: true },
    });
    if (outbound?.runId) return teamRunOwningWork(db, outbound.runId, seen);
  }
  return source.runId && source.runId !== run.id
    ? teamRunOwningWork(db, source.runId, seen)
    : undefined;
}

// Supersession alone says nothing about whether the human wanted in-flight work stopped.
export function teamWorkMustStop(status: string): boolean {
  return status === "stopped";
}

export async function stoppedTeamRunForWork(db: Db, runId: string): Promise<Team | undefined> {
  const team = await teamRunOwningWork(db, runId);
  return team && teamWorkMustStop(team.status) ? team : undefined;
}

/** A queue drain can send on behalf of a different live turn; ownership stays on the task. */
export async function teamBackgroundDeliveryStopped(db: Db, deliveryKey: string | undefined) {
  const taskId = deliveryKey?.match(/^bgtask:([^:]+):/)?.[1];
  if (!taskId) return false;
  await db.$queryRaw`SELECT id FROM background_task_queue WHERE id = ${taskId} FOR UPDATE`;
  const task = await db.backgroundTaskQueue.findUnique({
    where: { id: taskId },
    select: { runId: true },
  });
  return task ? Boolean(await stoppedTeamRunForWork(db, task.runId)) : false;
}

/** A progress snapshot read before stop must not publish a newly running card after stop. */
export async function teamTaskProgressIsCurrent(
  db: Db,
  tasks: readonly { id: string; status: string }[],
) {
  const current = await db.backgroundTaskQueue.findMany({
    where: { id: { in: tasks.map((task) => task.id) } },
    select: { id: true, status: true },
  });
  const statuses = new Map(current.map((task) => [task.id, task.status]));
  return tasks.every((task) => statuses.get(task.id) === task.status);
}

/** Caller holds the group thread lock; cancellation and the end status commit together. */
export async function cancelTeamRunWork(db: Db, team: Team): Promise<void> {
  const origin = await db.message.findUnique({
    where: { id: team.originMessageId },
    select: { createdAt: true },
  });
  if (!origin) return;
  const candidates = await db.run.findMany({
    where: { threadId: team.threadId, createdAt: { gte: origin.createdAt } },
    select: { id: true },
  });
  const ids: string[] = [];
  for (const candidate of candidates) {
    if ((await teamRunOwningWork(db, candidate.id))?.id === team.id) ids.push(candidate.id);
  }
  // Include completed member turns: their workers may still be running.
  const tasks = ids.length
    ? await db.backgroundTaskQueue.findMany({
        where: { runId: { in: ids } },
        select: { id: true, workerRunId: true },
      })
    : [];
  await db.backgroundTaskQueue.updateMany({
    where: {
      id: { in: tasks.map((task) => task.id) },
      status: { in: ["queued", "claiming", "started"] },
    },
    data: { status: "cancelled", finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
  });
  // The handoff may have committed before the drainer bound workerRunId. Its delivery nonce
  // identifies that exact task and also any steering continuation, without touching slot reuse.
  const workers = tasks.length
    ? await db.run.findMany({
        where: {
          OR: [
            { id: { in: tasks.flatMap((task) => (task.workerRunId ? [task.workerRunId] : [])) } },
            ...tasks.map((task) => ({
              sourceMessage: { clientNonce: { startsWith: `bot-message:bgtask:${task.id}:` } },
            })),
          ],
        },
        select: { id: true },
      })
    : [];
  await cancelWorkRuns(db, [...ids, ...workers.map((worker) => worker.id)]);
}

async function cancelWorkRuns(db: Db, ids: string[]) {
  const active = await db.run.findMany({
    where: { id: { in: ids }, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true, taskId: true, spaceId: true, userId: true, threadId: true, botId: true },
  });
  const cancelled = await cancelRunsInTransaction(db, active, new Date());
  await db.steeringMessage.deleteMany({ where: { runId: { in: cancelled.map((run) => run.id) } } });
  for (const run of cancelled) {
    await appendEventInTransaction(db, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "run.cancelled",
      payload: {},
    });
  }
}

/** Refuse stopped work before starting the runtime/tools or continuing group orchestration. */
export async function refuseStoppedTeamRunWork(
  prisma: PrismaClient,
  runId: string,
  context?: { threadId: string; createdAt: Date; groupId: string | null | undefined },
): Promise<boolean> {
  if (context) {
    if (!context.groupId) return false;
    // The existing (threadId, status) index bounds this probe to this group's stops.
    // An ordinary new turn needs no provenance walk for earlier stops. Late descendants
    // and retries can inherit older work, so retain those candidates for the full check.
    const candidates = await prisma.$queryRaw<{ id: string }[]>`
      SELECT team.id FROM group_team_runs team
      WHERE team."threadId" = ${context.threadId} AND team.status = 'stopped'
        AND (team."endedAt" >= ${context.createdAt} OR EXISTS (
          SELECT 1 FROM runs r LEFT JOIN messages source ON source.id = r."sourceMessageId"
          WHERE r.id = ${runId} AND (
            r."retryOfRunId" IS NOT NULL
            OR (r."clientNonce" LIKE 'team-nudge:%' AND split_part(r."clientNonce", ':', 2) = team.id)
            OR (source."clientNonce" LIKE 'team-nudge:%' AND split_part(source."clientNonce", ':', 2) = team.id)
            OR (source."createdAt" <= team."endedAt" AND (
              source."runId" IS NOT NULL
              OR source."clientNonce" LIKE 'group-handoff:%'
              OR source."clientNonce" LIKE 'group-question:%'
            ))
          )
        ))
      LIMIT 1`;
    if (!candidates.length) return false;
  }
  const team = await stoppedTeamRunForWork(prisma, runId);
  if (!team) return false;
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${team.threadId} FOR UPDATE`;
      await cancelTeamRunWork(tx, team);
    }),
  );
  return true;
}

/** Serialize background admission with stop, including a tool call already in flight. */
export async function createTeamBackgroundTask(
  prisma: PrismaClient,
  run: { id: string; threadId: string },
  args: Prisma.BackgroundTaskQueueCreateArgs,
) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
      if (await stoppedTeamRunForWork(tx, run.id)) return undefined;
      return tx.backgroundTaskQueue.create(args);
    }),
  );
}
