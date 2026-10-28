import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  failedHandoffNotice,
  renderTeamRunContext,
  TEAM_RUN_PAUSED_NOTICE,
  teamRunCloseOutcome,
  teamRunClosingText,
  teamRunNudgeText,
  teamRunReturnText,
  teamRunSupersededNote,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  isHiddenBot,
  VISIBLE_BOT_WHERE,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { handoffToGroupBot } from "./group-handoff.js";
import { postGroupNotice } from "./group-reply-routing.js";
import { humanAnchorForRun } from "./group-team-run-anchor.js";
import {
  interruptedTeamRunGoal,
  supersedeEarlierTeamRuns,
  teamRunEndedForTurn,
} from "./group-team-run-close.js";
import { endTeamRun, newerHumanMessage } from "./group-team-run-gate.js";

/**
 * Group team runs (see core group-team-run.ts): one human request to the group's leader runs to
 * completion on its own. This file holds the code-enforced parts: starting a run, its handoff
 * budget and loop guard, returning a finished stage to the leader, one nudge for a leader that
 * stopped, and closing the run with a summary. A newer human message always ends the run.
 */

type Db = PrismaClient;
type Member = { id: string; name: string; title: string | null; description: string | null };
export type TeamRunRow = {
  id: string;
  spaceId: string;
  userId: string;
  groupId: string;
  threadId: string;
  leaderBotId: string;
  originMessageId: string;
  status: string;
  hops: number;
  nudges: number;
  lastLeaderTargetId: string | null;
  leaderTargetStreak: number;
  createdAt: Date;
};
export type TeamRunView = {
  row: TeamRunRow;
  role: "leader" | "member";
  leader: Member;
  members: Member[];
  /** A human message newer than the one that started the run: the human took over. */
  interrupted: boolean;
  /** The request of an earlier team run this run's message interrupted (leader only). */
  interruptedGoal?: string;
};
type SourceRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  trigger: string;
  createdAt: Date;
  sourceMessageId?: string | null;
};

function blocksText(blocks: unknown): string {
  return Array.isArray(blocks)
    ? (blocks as MessageBlock[])
        .flatMap((block) => (block.kind === "text" ? [block.text] : []))
        .join("")
        .trim()
    : "";
}

async function visibleMembers(prisma: Pick<PrismaClient, "chatGroup">, groupId: string) {
  const group = await prisma.chatGroup.findFirst({
    where: { id: groupId, archivedAt: null },
    select: {
      members: {
        where: { bot: { archivedAt: null, AND: [VISIBLE_BOT_WHERE] } },
        select: { bot: { select: { id: true, name: true, title: true, description: true } } },
        // The group's roster order (the first member leads), as the groups API lists it.
        orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
      },
    },
  });
  return group?.members.map((member) => member.bot);
}

/**
 * The active team run a group run belongs to, if any. With `start`, a human message that woke
 * only the group's leader starts one (once per message).
 */
export async function teamRunForRun(
  prisma: Db,
  run: SourceRun,
  thread: { groupId: string | null | undefined },
  bot: { id: string; spawnKey?: string | null },
  options: { start?: boolean } = {},
): Promise<TeamRunView | undefined> {
  if (!thread.groupId || isHiddenBot(bot)) return undefined;
  // A retried attempt answers its first attempt's request (group-team-run-anchor.ts).
  const anchor = await humanAnchorForRun(prisma, run);
  if (!anchor) return undefined;
  // This request is newer than any still-active team run's: those are over now.
  await supersedeEarlierTeamRuns(prisma, run.threadId, anchor);
  const members = await visibleMembers(prisma, thread.groupId);
  const leader = members?.[0];
  if (!members || !leader || members.length < 2) return undefined;
  let row = await prisma.groupTeamRun.findUnique({ where: { originMessageId: anchor.id } });
  if (
    !row &&
    options.start &&
    run.trigger === "user" &&
    run.sourceMessageId === anchor.id &&
    run.botId === leader.id &&
    // The leader alone: a message that also woke other members is theirs to share, not a plan.
    (await prisma.run.count({ where: { sourceMessageId: anchor.id } })) === 1
  ) {
    row = await prisma.groupTeamRun
      .create({
        data: {
          spaceId: run.spaceId,
          userId: run.userId,
          groupId: thread.groupId,
          threadId: run.threadId,
          leaderBotId: leader.id,
          originMessageId: anchor.id,
        },
      })
      .catch(async (error) => {
        // A retried attempt of the same run raced its own earlier start.
        const existing = await prisma.groupTeamRun.findUnique({
          where: { originMessageId: anchor.id },
        });
        if (existing) return existing;
        throw error;
      });
  }
  if (row?.status !== "active") return undefined;
  const runLeader = members.find((member) => member.id === row.leaderBotId);
  if (!runLeader || !members.some((member) => member.id === run.botId)) return undefined;
  const role = run.botId === runLeader.id ? "leader" : "member";
  return {
    row,
    role,
    leader: runLeader,
    members,
    interrupted: await newerHumanMessage(prisma, run.threadId, anchor.seq),
    interruptedGoal:
      role === "leader" ? await interruptedTeamRunGoal(prisma, run.threadId, anchor) : undefined,
  };
}

/** The prompt section for a bot in an active team run. */
export async function teamRunPromptContext(
  prisma: Pick<PrismaClient, "message">,
  view: TeamRunView | undefined,
): Promise<string | undefined> {
  if (!view || view.interrupted) return undefined;
  const origin = await prisma.message.findUnique({
    where: { id: view.row.originMessageId },
    select: { blocks: true },
  });
  const context = renderTeamRunContext({
    role: view.role,
    leaderName: view.leader.name,
    goal: blocksText(origin?.blocks),
    members: view.members,
  });
  return view.interruptedGoal === undefined
    ? context
    : `${context}\n${teamRunSupersededNote(view.interruptedGoal)}`;
}

async function handedOffThisTurn(prisma: Pick<PrismaClient, "message">, run: SourceRun) {
  const handoff = await prisma.message.findUnique({
    where: {
      threadId_clientNonce: { threadId: run.threadId, clientNonce: `group-handoff:${run.id}` },
    },
    select: { id: true },
  });
  return Boolean(handoff);
}

async function pendingBackgroundTasks(
  prisma: Pick<PrismaClient, "backgroundTaskQueue">,
  run: SourceRun,
) {
  return prisma.backgroundTaskQueue.count({
    where: {
      botId: run.botId,
      threadId: run.threadId,
      status: { in: ["queued", "claiming", "started"] },
    },
  });
}

/**
 * After a group turn in an active team run completed: keep the run moving, in code. A member
 * that finished without handing on returns the stage to the leader; a leader that stopped gets
 * one nudge, then the run pauses with a visible line. Never throws. `suppressClaimRecheck` is
 * set when a claim recheck of this turn would only repeat it: the run already queued the next
 * turn for the leader, or the run already ended (closed, stopped, or overtaken).
 */
export async function continueTeamRun(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: SourceRun,
  input: {
    thread: { groupId: string | null | undefined };
    bot: { id: string; name: string; spawnKey?: string | null };
    replyText: string;
    /** The turn waits on the user: it asked a question or posted a form. */
    waitsOnUser: boolean;
    /** The user steered the turn; the continuation run answers, not this one. */
    continued: boolean;
  },
): Promise<{ suppressClaimRecheck: boolean }> {
  try {
    const queued = await continueActiveTeamRun(deps, run, input);
    return {
      suppressClaimRecheck: queued || (await teamRunEndedForTurn(deps.prisma, run)),
    };
  } catch (error) {
    getLogger().error("team run continue", error);
    return { suppressClaimRecheck: false };
  }
}

/** The run's next step; true when it queued another turn (a nudge or the leader's stage). */
async function continueActiveTeamRun(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: SourceRun,
  input: Parameters<typeof continueTeamRun>[2],
): Promise<boolean> {
  const view = await teamRunForRun(deps.prisma, run, input.thread, input.bot);
  if (!view) return false;
  if (view.interrupted) {
    await endTeamRun(deps.prisma, view.row.id, "superseded", "human_message");
    return false;
  }
  if (input.continued) return false;
  if (await handedOffThisTurn(deps.prisma, run)) return false;
  // A started background task brings its result back to this bot; that turn continues.
  if (await pendingBackgroundTasks(deps.prisma, run)) return false;
  if (view.role === "member") {
    if (input.waitsOnUser) return false;
    return returnStageToLeader(deps, run, view, input.bot.name, input.replyText);
  }
  return leaderStopped(deps, run, view, input.waitsOnUser);
}

async function returnStageToLeader(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: SourceRun,
  view: TeamRunView,
  memberName: string,
  replyText: string,
) {
  const text = teamRunReturnText(memberName, view.leader.name, replyText).slice(
    0,
    BOT_MESSAGE_MAX_LENGTH,
  );
  const result = await handoffToGroupBot(
    deps,
    run,
    view.row.groupId,
    { bot_id: view.leader.id, message: text },
    { allowFinishedSource: true },
  );
  if ("ok" in result) return true;
  getLogger().info("team run return to leader refused", { runId: run.id, reason: result.reason });
  if (result.reason === "team_interrupted" || result.reason === "source_inactive") return false;
  if (result.reason === "team_budget" || result.reason === "team_loop") {
    await postGroupNotice(deps, run, failedHandoffNotice(view.leader.name, result.reason));
    return false;
  }
  await endTeamRun(deps.prisma, view.row.id, "stopped", result.reason);
  await postGroupNotice(
    deps,
    run,
    `${failedHandoffNotice(view.leader.name, result.reason)}${TEAM_RUN_PAUSED_NOTICE}`,
  );
  return false;
}

async function leaderStopped(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: SourceRun,
  view: TeamRunView,
  waitsOnUser: boolean,
): Promise<boolean> {
  // Nothing was handed out yet: the leader simply answered the user, which ends the run.
  if (view.row.hops === 0) {
    await endTeamRun(deps.prisma, view.row.id, "answered", "leader_answered");
    return false;
  }
  if (waitsOnUser) {
    await endTeamRun(deps.prisma, view.row.id, "paused", "waiting_user");
    return false;
  }
  if (view.row.nudges === 0) return nudgeLeader(deps, run, view);
  if (await endTeamRun(deps.prisma, view.row.id, "paused", "leader_stalled")) {
    await postGroupNotice(deps, run, TEAM_RUN_PAUSED_NOTICE);
  }
  return false;
}

/** Posts the visible reminder and starts one more leader turn with it as the prompt. */
async function nudgeLeader(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: SourceRun,
  view: TeamRunView,
): Promise<boolean> {
  const text = teamRunNudgeText(view.leader.name);
  const committed = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    const claimed = await tx.groupTeamRun.updateMany({
      where: { id: view.row.id, status: "active", nudges: 0 },
      data: { nudges: 1 },
    });
    if (claimed.count !== 1) return undefined;
    const blocks: MessageBlock[] = [{ kind: "text", text }];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: run.threadId,
      role: "bot",
      blocks,
      botId: view.leader.id,
      clientNonce: `team-nudge:${view.row.id}:${run.id}`,
    });
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: view.leader.id,
        threadId: run.threadId,
        userId: run.userId,
        prompt: text,
        status: "queued",
      },
    });
    const nextRun = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: view.leader.id,
        threadId: run.threadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: "follow_up",
        sourceMessageId: message.id,
      },
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: view.leader.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { runId: nextRun.id, seq: event.seq };
  });
  if (!committed) return false;
  await deps.events.notify(run.threadId, committed.seq).catch((error) => {
    getLogger().error("team run nudge notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    getLogger().error("team run nudge enqueue", error);
  });
  return true;
}

/**
 * complete_team_run: the leader closes its active team run and the closing message is posted.
 * `outcome: "stopped"` (the user asked to stop) records the run as stopped and says so; with no
 * outcome, a run that only took over an interrupted one and handed nothing out closes as stopped.
 */
export async function completeTeamRun(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  run: SourceRun,
  thread: { groupId: string | null | undefined },
  bot: { id: string; spawnKey?: string | null },
  args: Record<string, unknown>,
): Promise<{ ok: true; note: string } | { error: string }> {
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  if (!summary) return { error: "summary is required" };
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").slice(0, 20)
      : [];
  const view = await teamRunForRun(deps.prisma, run, thread, bot);
  if (view?.role !== "leader")
    return { error: "there is no active team task that you lead in this group" };
  if (view.interrupted) {
    await endTeamRun(deps.prisma, view.row.id, "superseded", "human_message");
    return { error: "the user sent a new message, so this team task already stopped" };
  }
  const outcome =
    args.outcome === undefined || args.outcome === null
      ? view.row.hops === 0 && view.interruptedGoal !== undefined
        ? "stopped"
        : "completed"
      : teamRunCloseOutcome(args.outcome);
  const text = teamRunClosingText({
    outcome,
    summary,
    deliverables: strings(args.deliverables),
    openIssues: strings(args.open_issues),
  }).slice(0, BOT_MESSAGE_MAX_LENGTH);
  const seq = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    const ended =
      outcome === "stopped"
        ? await endTeamRun(tx, view.row.id, "stopped", "leader_stopped")
        : await endTeamRun(tx, view.row.id, "completed", "leader_completed");
    if (!ended) return undefined;
    const blocks: MessageBlock[] = [{ kind: "text", text }];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: run.threadId,
      role: "bot",
      blocks,
      botId: bot.id,
      clientNonce: `team-complete:${view.row.id}`,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: bot.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return event.seq;
  });
  if (seq === undefined) return { error: "this team task already ended" };
  await deps.events.notify(run.threadId, seq).catch((error) => {
    getLogger().error("team run summary notification", error);
  });
  return {
    ok: true,
    note:
      outcome === "stopped"
        ? "Team task stopped and the closing note is posted for the user. End the turn without repeating it."
        : "Team task closed and its summary is posted for the user. End the turn without repeating it.",
  };
}
