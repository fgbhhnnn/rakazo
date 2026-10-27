import type { MessageBlock } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  failedHandoffNotice,
  HANDOFF_CHAIN_LIMIT_NOTICE,
  type HandoffFailureReason,
  handoffClaims,
  mentionedMembersInOrder,
  replyMentionTarget,
  TEAM_RUN_BUDGET_NOTICE,
  TEAM_RUN_LOOP_NOTICE,
  unverifiedHandoffClaimNote,
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

/**
 * Group teamwork after a bot's group reply. One routing order, no model picking speakers:
 * a human "@" (thread-target) > the handoff tool > an exact member "@Name" in the bot's own
 * reply > the group leader for an unaddressed human message. The reply "@Name" goes through
 * the same handoff path as the tool (hop budget, no hand-back, one per turn), and a reply that
 * claims a handoff nothing backs gets a visible note instead of passing as true.
 */

type Member = { id: string; name: string };
type GroupRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
};

export type GroupReplyPlan = {
  groupId: string;
  /** The member the reply's own "@Name" hands the next stage to. */
  target?: Member;
  replyText: string;
};

function replyText(blocks: readonly MessageBlock[]): string {
  return blocks
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("")
    .trim();
}

async function activeGroupMembers(
  prisma: Pick<PrismaClient, "chatGroup">,
  groupId: string,
): Promise<Member[] | undefined> {
  const group = await prisma.chatGroup.findFirst({
    where: { id: groupId, archivedAt: null },
    select: {
      members: {
        where: { bot: { archivedAt: null, AND: [VISIBLE_BOT_WHERE] } },
        select: { bot: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  return group?.members.map((member) => member.bot);
}

/**
 * Members the latest human message (at or before this run started) already addressed with
 * its own "@": thread-target woke each of them with that message, so a bot's reply quoting
 * or repeating those "@Name"s must not hand the same work to them again.
 */
async function humanAddressedIds(
  prisma: Pick<PrismaClient, "message">,
  humanTurn: { threadId: string; before: Date },
  members: readonly Member[],
): Promise<Set<string>> {
  const latest = await prisma.message.findFirst({
    where: { threadId: humanTurn.threadId, role: "user", createdAt: { lte: humanTurn.before } },
    orderBy: { seq: "desc" },
    select: { blocks: true },
  });
  const text = Array.isArray(latest?.blocks) ? replyText(latest.blocks as MessageBlock[]) : "";
  return new Set(text ? mentionedMembersInOrder(text, members).map((member) => member.id) : []);
}

/**
 * Before the reply is saved: picks the reply's "@Name" handoff target and appends
 * "（未实际交接…）" to a reply claiming a handoff that neither the tool nor that "@Name" makes.
 */
export async function planGroupReply(
  deps: Pick<ExecutorDeps, "prisma">,
  input: {
    groupId: string | null | undefined;
    bot: { id: string; spawnKey?: string | null };
    handedOff: boolean;
    handoffTargets: readonly string[];
    blocks: MessageBlock[];
    /** The group thread and run start: members its latest human message "@"ed are skipped. */
    humanTurn?: { threadId: string; before: Date };
  },
): Promise<{
  blocks: MessageBlock[];
  plan?: GroupReplyPlan;
  /** A sentence claiming a handoff to a named member: this guard's, not a worker claim. */
  isTeamClaim?: (sentence: string) => boolean;
}> {
  const { groupId, bot, blocks } = input;
  if (!groupId || isHiddenBot(bot)) return { blocks };
  const text = replyText(blocks);
  if (!text) return { blocks };
  const members = await activeGroupMembers(deps.prisma, groupId);
  if (!members) return { blocks };
  const others = members.filter((member) => member.id !== bot.id);
  const addressed = input.humanTurn
    ? await humanAddressedIds(deps.prisma, input.humanTurn, others)
    : new Set<string>();
  // The tool already handed off this turn: a reply "@Name" is then only a mention.
  const target =
    input.handedOff || input.handoffTargets.length
      ? undefined
      : replyMentionTarget(
          text,
          others.filter((member) => !addressed.has(member.id)),
          bot.id,
        );
  const note = unverifiedHandoffClaimNote(text, others, [
    ...input.handoffTargets,
    ...(target ? [target.id] : []),
  ]);
  const next = note ? withAppendedNote(blocks, note) : blocks;
  if (note) getLogger().warn("group reply claims a handoff that did not happen", { groupId });
  return {
    blocks: next,
    plan: target ? { groupId, target, replyText: text } : undefined,
    isTeamClaim: (sentence) =>
      handoffClaims(sentence, others).some((claim) => claim.memberIds.length > 0),
  };
}

function withAppendedNote(blocks: MessageBlock[], note: string): MessageBlock[] {
  let last = -1;
  blocks.forEach((block, index) => {
    if (block.kind === "text") last = index;
  });
  if (last < 0) return [...blocks, { kind: "text", text: note }];
  return blocks.map((block, index) =>
    index === last && block.kind === "text" ? { ...block, text: `${block.text}\n${note}` } : block,
  );
}

/**
 * After the reply is saved: hands the next stage to the reply's "@Name" member. A failure is
 * said in the group (except a hand-back, which is just a reply to the member who asked).
 */
export async function routeGroupReply(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: GroupRun,
  plan: GroupReplyPlan | undefined,
): Promise<void> {
  if (!plan?.target) return;
  const result = await handoffToGroupBot(
    deps,
    run,
    plan.groupId,
    {
      bot_id: plan.target.id,
      message: plan.replyText.slice(0, BOT_MESSAGE_MAX_LENGTH),
    },
    { allowFinishedSource: true },
  );
  if ("ok" in result) return;
  getLogger().info("group reply mention was not handed off", {
    runId: run.id,
    reason: result.reason,
  });
  if (result.reason === "hand_back" || result.reason === "source_inactive") return;
  await postGroupNotice(deps, run, failedHandoffNotice(plan.target.name, result.reason));
}

/** The tool's own failures that the group should see, not only the model. Never throws. */
export async function noticeHandoffToolFailure(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  run: GroupRun & { groupId: string | null | undefined },
  reason: HandoffFailureReason,
): Promise<void> {
  const notice =
    reason === "hop_limit"
      ? HANDOFF_CHAIN_LIMIT_NOTICE
      : reason === "team_budget"
        ? TEAM_RUN_BUDGET_NOTICE
        : reason === "team_loop"
          ? TEAM_RUN_LOOP_NOTICE
          : undefined;
  if (!run.groupId || !notice) return;
  await postGroupNotice(deps, run, notice).catch((error) =>
    getLogger().error("group handoff notice", error),
  );
}

/**
 * A short visible line from this bot in its group thread, once per run (keyed by run id), so
 * a chain never stops silently.
 */
export async function postGroupNotice(
  deps: Pick<ExecutorDeps, "prisma"> & { events?: Pick<ExecutorDeps["events"], "notify"> },
  run: GroupRun,
  text: string,
): Promise<void> {
  const clientNonce = `group-notice:${run.id}`;
  const seq = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    const existing = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId: run.threadId, clientNonce } },
      select: { id: true },
    });
    if (existing) return undefined;
    const blocks: MessageBlock[] = [{ kind: "text", text }];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: run.threadId,
      role: "bot",
      blocks,
      botId: run.botId,
      clientNonce,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return event.seq;
  });
  if (seq === undefined || !deps.events) return;
  await deps.events.notify(run.threadId, seq).catch((error) => {
    getLogger().error("group notice realtime notification", error);
  });
}
