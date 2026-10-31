import { runContinueJob } from "@rakazo/adapter-kit";
import { MessageBlock } from "@rakazo/contracts";
import type { HandoffFailureReason } from "@rakazo/core";
import {
  BOT_MESSAGE_MAX_LENGTH,
  botMessageContext,
  botMessageHopExhausted,
  formatHandoffBrief,
  nextBotMessageHop,
  renderBotGroupDirectory,
  renderGroupMembersContext,
  resolveBotAddress,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  touchGroupUpdatedAt,
  VISIBLE_BOT_WHERE,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { stageSourceForHandoff } from "./group-consult.js";
import { holdWhileBusy } from "./group-held-runs.js";
import { recordTeamRunHandoff, teamRunHandoffGate } from "./group-team-run-gate.js";
import { runLeaseFor } from "./run-messages.js";

export type HandoffResult =
  | { error: string; reason: HandoffFailureReason }
  | {
      ok: true;
      /** The next bot's run is recorded (queued); it starts even if the immediate wake fails. */
      delivered: true;
      botId: string;
      runId: string;
      hop: number | undefined;
      groupId: string;
      groupName: string;
      note: string;
    };

type CommittedHandoff =
  | { error: string; reason: HandoffFailureReason }
  | {
      ok: true;
      botId: string;
      runId: string;
      hop: number | undefined;
      eventSeq: number;
      threadId: string;
      inGroup: boolean;
      groupName: string;
      held?: boolean;
    };

export async function handoffToGroupBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "runLease">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
  },
  groupId: string,
  input: { bot_id?: string; confirm_name?: string; message: string; deliveryKey?: string },
  options: {
    /**
     * An "@Name" in the bot's own group reply is routed right after the reply is posted, when
     * its run has just completed; the tool call itself always needs a running source.
     */
    allowFinishedSource?: boolean;
    /**
     * Queue the target's turn behind a turn it is still working on in this thread instead of
     * starting a second, overlapping one (see group-held-runs.ts).
     */
    holdWhileTargetBusy?: boolean;
  } = {},
): Promise<HandoffResult> {
  const text = input.message.trim();
  if (!text || text.length > BOT_MESSAGE_MAX_LENGTH) {
    return {
      error: `message must contain 1 to ${BOT_MESSAGE_MAX_LENGTH} characters`,
      reason: "invalid_message",
    } as const;
  }
  const committed = await deps.prisma.$transaction(async (tx): Promise<CommittedHandoff> => {
    try {
      await lockOwnedGroup(tx, run, groupId);
    } catch (error) {
      if (error instanceof IsolationError)
        return { error: "group is no longer available", reason: "group_unavailable" } as const;
      throw error;
    }
    const group = await tx.chatGroup.findFirst({
      where: { id: groupId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
      include: {
        thread: { select: { id: true } },
        members: {
          where: { bot: { archivedAt: null } },
          include: { bot: { select: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!group?.thread)
      return { error: "group is no longer available", reason: "group_unavailable" } as const;
    const targetThreadId = group.thread.id;
    // Match message_bot's lock order and serialize source cancellation/clearing with delivery.
    for (const threadId of [...new Set([run.threadId, targetThreadId])].sort()) {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
    }
    const activeSource = await tx.run.findFirst({
      where: {
        id: run.id,
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        userId: run.userId,
        status: options.allowFinishedSource ? { in: ["running", "completed"] } : "running",
      },
      select: {
        id: true,
        thread: { select: { groupId: true } },
        sourceMessage: { select: { id: true, botId: true, clientNonce: true, blocks: true } },
      },
    });
    if (!activeSource)
      return { error: "source run is no longer active", reason: "source_inactive" } as const;
    const inGroup = targetThreadId === run.threadId;
    if (!inGroup && activeSource.thread.groupId) {
      return {
        error: "group handoffs must stay in the current group",
        reason: "not_in_group",
      } as const;
    }
    if (!group.members.some((member) => member.bot.id === run.botId)) {
      return { error: "source bot is no longer a group member", reason: "not_in_group" } as const;
    }

    // A group stage has one owner; an outside turn can send several independent tasks.
    const deliveryKey = `group-handoff:${inGroup ? run.id : (input.deliveryKey ?? run.id)}`;
    const existing = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
      select: {
        id: true,
        blocks: true,
        sourceRuns: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { id: true, botId: true },
        },
      },
    });
    if (existing) {
      const nextRun = existing.sourceRuns[0];
      const event = await tx.event.findFirst({
        where: {
          threadId: targetThreadId,
          type: "group.handoff",
          payload: { path: ["messageId"], equals: existing.id },
        },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      if (!nextRun || !event)
        return { error: "recorded handoff is incomplete", reason: "source_inactive" } as const;
      // Only a replay of the same call reuses the record; a second, different handoff in one
      // turn must not report a success that never happened.
      const conflict = secondHandoffConflict(existing.blocks, group.members, input, text);
      if (conflict) return conflict;
      return {
        ok: true,
        botId: nextRun.botId,
        runId: nextRun.id,
        hop: recordedHandoff(existing.blocks)?.hop,
        eventSeq: event.seq,
        threadId: targetThreadId,
        inGroup,
        groupName: group.name,
      } as const;
    }

    const target = resolveBotAddress(
      group.members.map((member) => member.bot),
      {
        botId: input.bot_id,
        name: input.confirm_name,
      },
    );
    if (!target)
      return { error: "handoff target is not a group member", reason: "not_in_group" } as const;
    const targetId = target.id;
    if (targetId === run.botId)
      return { error: "cannot hand off to yourself", reason: "self_target" } as const;

    // A teammate question is not a stage: its answerer may not hand off, and its asker's chain
    // checks use the stage it asked from (group-consult.ts).
    const stage = await stageSourceForHandoff(tx, run, activeSource.sourceMessage);
    if ("refused" in stage) return { error: stage.refused, reason: "answering_question" } as const;
    let sourceBlocks: MessageBlock[] = [];
    if (stage.source) {
      const parsedSource = MessageBlock.array().safeParse(stage.source.blocks);
      if (!parsedSource.success) {
        return { error: "cannot verify the group handoff chain", reason: "invalid_chain" } as const;
      }
      sourceBlocks = parsedSource.data;
    }
    const sourceHandoff = sourceBlocks.find(
      (block): block is Extract<MessageBlock, { kind: "handoff" }> => block.kind === "handoff",
    );
    // A group team run replaces the plain chain limit with its own budget and loop guard.
    const team = inGroup ? await teamRunHandoffGate(tx, run, targetId) : { kind: "none" as const };
    if (team.kind === "refused") return { error: team.error, reason: team.reason } as const;
    const teamStep = team.kind === "team" ? team : undefined;
    if (sourceHandoff?.fromBotId === targetId && !teamStep?.allowHandBack) {
      return {
        error:
          "do not hand this stage back to its sender; post the result in the shared thread instead",
        reason: "hand_back",
      } as const;
    }
    const hop = nextBotMessageHop(sourceHandoff?.hop ?? botMessageContext(sourceBlocks)?.hop);
    if (!teamStep && botMessageHopExhausted(hop)) {
      return {
        error:
          "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
        reason: "hop_limit",
      } as const;
    }

    // A finished run can no longer write history; its reply's "@Name" handoff is recorded
    // without a run link (the handoff block names the sender bot).
    const historyRunId = inGroup && !options.allowFinishedSource ? run.id : undefined;
    const handoffBlock: MessageBlock = {
      kind: "handoff",
      fromBotId: run.botId,
      toBotId: targetId,
      text,
      hop,
    };
    const message = await createThreadMessageInTransaction(tx, {
      threadId: targetThreadId,
      role: "bot",
      blocks: [handoffBlock],
      botId: run.botId,
      runId: historyRunId,
      clientNonce: deliveryKey,
      lease: historyRunId ? runLeaseFor(deps, historyRunId) : undefined,
    });
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: targetId,
        threadId: targetThreadId,
        userId: run.userId,
        prompt: text,
        status: "queued",
      },
    });
    const heldUntil = options.holdWhileTargetBusy
      ? await holdWhileBusy(tx, { threadId: targetThreadId, botId: targetId })
      : undefined;
    const nextRun = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: targetId,
        threadId: targetThreadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: "follow_up",
        sourceMessageId: message.id,
        ...(heldUntil ? { wakeAt: heldUntil } : {}),
      },
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: targetThreadId,
      botId: run.botId,
      type: "group.handoff",
      runId: historyRunId,
      lease: historyRunId ? runLeaseFor(deps, historyRunId) : undefined,
      payload: {
        messageId: message.id,
        fromBotId: run.botId,
        toBotId: targetId,
        text,
      },
    });
    if (teamStep) await recordTeamRunHandoff(tx, teamStep, run.botId, targetId);
    await touchGroupUpdatedAt(tx, groupId);
    return {
      ok: true,
      botId: targetId,
      runId: nextRun.id,
      hop,
      eventSeq: event.seq,
      threadId: targetThreadId,
      inGroup,
      groupName: group.name,
      held: Boolean(heldUntil),
    } as const;
  });
  if ("error" in committed) {
    // The reason and target only: never the message, which may quote user content.
    getLogger().info("group handoff refused", {
      runId: run.id,
      reason: committed.reason,
      targetId: input.bot_id ?? null,
      byName: Boolean(input.confirm_name && !input.bot_id),
    });
    return committed;
  }
  await deps.events.notify(committed.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("group handoff realtime notification", error);
  });
  // A held turn starts when the target's current turn ends (or its hold expires).
  if (!committed.held)
    await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
      // The queued run is durable and the job reconciler will repair a missed immediate wake.
      getLogger().error("group handoff enqueue", error);
    });
  return {
    ok: true,
    delivered: true,
    botId: committed.botId,
    runId: committed.runId,
    hop: committed.hop,
    groupId,
    groupName: committed.groupName,
    note: committed.inGroup
      ? "Handoff recorded. End this turn without narrating it; the next bot owns the next stage."
      : "Handoff recorded in the selected group. The next bot will reply there. Continue any independent work.",
  };
}

function recordedHandoff(blocks: unknown) {
  const parsed = MessageBlock.array().safeParse(blocks);
  return parsed.success
    ? parsed.data.find(
        (block): block is Extract<MessageBlock, { kind: "handoff" }> => block.kind === "handoff",
      )
    : undefined;
}

/**
 * A turn hands off once. Returns an error when the recorded handoff of this turn went to a
 * different member or carried a different message than this call; undefined for a replay.
 */
export function secondHandoffConflict(
  recordedBlocks: unknown,
  members: readonly { bot: { id: string; name: string } }[],
  input: { bot_id?: string; confirm_name?: string },
  text: string,
): { error: string; reason: HandoffFailureReason } | undefined {
  const recorded = recordedHandoff(recordedBlocks);
  if (!recorded) return { error: "recorded handoff is incomplete", reason: "source_inactive" };
  const target = resolveBotAddress(
    members.map((member) => member.bot),
    { botId: input.bot_id, name: input.confirm_name },
  );
  if (target?.id === recorded.toBotId && recorded.text === text) return undefined;
  const recordedName =
    members.find((member) => member.bot.id === recorded.toBotId)?.bot.name ?? recorded.toBotId;
  return {
    error: `this turn already handed off to ${recordedName}; a turn hands off once, so this second handoff was not made. Do not say it was. End the turn; that member can hand the next stage on.`,
    reason: "one_handoff_per_turn",
  };
}

/** The handoff tool's message plus its optional brief fields, as one text for the receiver. */
export function handoffBriefFromArgs(args: Record<string, unknown>): string {
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  return formatHandoffBrief({
    message: String(args.message ?? ""),
    objective: text(args.objective),
    context: text(args.context),
    deliverable: text(args.deliverable),
    acceptance: text(args.acceptance),
    artifacts: Array.isArray(args.artifacts)
      ? args.artifacts.filter((ref): ref is string => typeof ref === "string")
      : undefined,
  });
}

export async function loadGroupContext(
  prisma: PrismaClient,
  groupId: string,
  self: { id: string; name: string },
  options: { handoffTool?: boolean; askTool?: boolean } = {},
): Promise<string | undefined> {
  const group = await prisma.chatGroup.findUnique({
    where: { id: groupId },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: {
          bot: { select: { id: true, name: true, description: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!group) return undefined;
  return renderGroupMembersContext(
    group.name,
    group.members.map((member) => member.bot),
    self,
    options,
  );
}

/** Only the current bot's active groups in the same owner/space are discoverable. */
export async function loadBotGroupDirectory(
  prisma: PrismaClient,
  actor: { botId: string; userId: string; spaceId: string },
): Promise<string | undefined> {
  const groups = await prisma.chatGroup.findMany({
    where: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      archivedAt: null,
      members: { some: { botId: actor.botId, bot: { archivedAt: null } } },
      thread: { isNot: null },
    },
    select: {
      id: true,
      name: true,
      members: {
        // Background workers are never listed as bots, so a group's directory leaves them out.
        where: { bot: { archivedAt: null, AND: [VISIBLE_BOT_WHERE] } },
        select: { bot: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
    take: 40,
  });
  return renderBotGroupDirectory(
    groups.map((group) => ({
      id: group.id,
      name: group.name,
      members: group.members.map((member) => member.bot),
    })),
  );
}
