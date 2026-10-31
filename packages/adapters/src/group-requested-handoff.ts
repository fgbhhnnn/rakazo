import type { MessageBlock } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  failedHandoffNotice,
  formatHandoffBrief,
  isHumanAuthoredMessage,
  replyBlocksRequestedHandoff,
  requestedHandoffTarget,
  systemHandoffMarker,
} from "@rakazo/core";
import { isHiddenBot, VISIBLE_BOT_WHERE } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { handoffToGroupBot } from "./group-handoff.js";
import { postGroupNotice } from "./group-reply-routing.js";

/**
 * A human asked the addressed bot to pass the work on ("写需求，然后交给团队-后端") and the bot's
 * turn finished without that handoff: the system makes it, through the same handoff path as the
 * tool (hop budget, hand-back and one-per-turn guards), marked as made by the system. It never
 * fires for a bot-authored request, a failed or steered turn, a reply that asks the user or
 * refuses, or when that member already has the work.
 */

const CONTEXT_MAX = 3_000;
const URL = /https?:\/\/[^\s<>()"'`，。；）]+/g;

function blocksText(blocks: unknown): string {
  return Array.isArray(blocks)
    ? (blocks as MessageBlock[])
        .flatMap((block) => (block.kind === "text" ? [block.text] : []))
        .join("")
        .trim()
    : "";
}

export async function handoffRequestedByHuman(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    trigger: string;
    sourceMessageId?: string | null;
  },
  input: {
    groupId: string | null | undefined;
    bot: { id: string; name: string; spawnKey?: string | null };
    replyText: string;
    /** The turn posted a form or otherwise waits on the user. */
    waitsOnUser: boolean;
    /** The user steered the turn; its continuation answers instead. */
    continued: boolean;
    /** Members the handoff tool already handed this turn's work to. */
    handoffTargets: readonly string[];
  },
): Promise<void> {
  const { groupId, bot } = input;
  if (!groupId || isHiddenBot(bot) || run.trigger !== "user" || !run.sourceMessageId) return;
  if (input.continued || input.waitsOnUser) return;
  try {
    const source = await deps.prisma.message.findUnique({
      where: { id: run.sourceMessageId },
      select: { id: true, role: true, botId: true, threadId: true, blocks: true },
    });
    // Only a human's own words count; a bot's message never asks for a system handoff.
    if (!source || !isHumanAuthoredMessage(source) || source.threadId !== run.threadId) return;
    const request = blocksText(source.blocks);
    if (!request) return;
    const group = await deps.prisma.chatGroup.findFirst({
      where: { id: groupId, archivedAt: null },
      select: {
        members: {
          where: { bot: { archivedAt: null, AND: [VISIBLE_BOT_WHERE] } },
          select: { bot: { select: { id: true, name: true } } },
        },
      },
    });
    const members = group?.members.map((member) => member.bot) ?? [];
    const target = requestedHandoffTarget(request, members, bot.id)?.member;
    if (!target || input.handoffTargets.includes(target.id)) return;
    // That member already has the work: the human's message woke it, or this turn handed it on.
    const woken = await deps.prisma.run.findMany({
      where: { sourceMessageId: source.id },
      select: { botId: true },
    });
    if (woken.length !== 1 || woken.some((row) => row.botId === target.id)) return;
    if (replyBlocksRequestedHandoff(input.replyText)) return;
    // The reply's own "@Name" already handed this turn on: done if to that member, and a
    // second handoff in one turn is refused with a visible reason otherwise.
    const handedOn = await deps.prisma.message.findUnique({
      where: {
        threadId_clientNonce: { threadId: run.threadId, clientNonce: `group-handoff:${run.id}` },
      },
      select: { blocks: true },
    });
    if (handedOn) {
      const block = (handedOn.blocks as MessageBlock[]).find((entry) => entry.kind === "handoff");
      if (block?.kind === "handoff" && block.toBotId !== target.id)
        await postGroupNotice(deps, run, failedHandoffNotice(target.name, "one_handoff_per_turn"));
      return;
    }
    const context = input.replyText.trim().slice(0, CONTEXT_MAX);
    const brief = formatHandoffBrief({
      message: `${systemHandoffMarker(target.name)}\n${request}`,
      context: context ? `${bot.name} 的结果：\n${context}` : undefined,
      artifacts: [...new Set(input.replyText.match(URL) ?? [])].slice(0, 10),
    }).slice(0, BOT_MESSAGE_MAX_LENGTH);
    const result = await handoffToGroupBot(
      deps,
      run,
      groupId,
      { bot_id: target.id, message: brief },
      { allowFinishedSource: true },
    );
    if ("ok" in result) return;
    getLogger().info("requested handoff was not made", { runId: run.id, reason: result.reason });
    if (result.reason === "source_inactive" || result.reason === "team_interrupted") return;
    await postGroupNotice(deps, run, failedHandoffNotice(target.name, result.reason));
  } catch (error) {
    getLogger().error("requested handoff", error);
  }
}
