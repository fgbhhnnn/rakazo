import { MessageBlock } from "@rakazo/contracts";
import { isBackgroundRunTrigger } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { isHiddenBot } from "@rakazo/db";
import { settleHandoffNarration } from "./group-stale-narration.js";
import type { RunContext } from "./run-context.js";
import { finalBlocksAfterMidTurnProgress } from "./user-progress.js";

/** Only formatting differences count as a repeat; added routing or result text must survive. */
export function isVisibleGroupReply(text: string, visible: readonly string[]): boolean {
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/\s+/gu, " ")
      .replace(/[。.]$/u, "");
  const candidate = normalize(text);
  return Boolean(candidate) && visible.some((prior) => normalize(prior) === candidate);
}

export function groupReplyText(blocks: readonly MessageBlock[]): string {
  return blocks
    .flatMap((block) => (block.kind === "text" || block.kind === "handoff" ? [block.text] : []))
    .join("");
}

/** Durable evidence only, scoped to the bot's turn; never use a teammate or a prior turn. */
export async function visibleGroupReplies(
  prisma: Pick<Prisma.TransactionClient, "message">,
  run: { id: string; threadId: string; botId: string },
): Promise<string[]> {
  const messages = await prisma.message.findMany({
    where: { threadId: run.threadId, runId: run.id, botId: run.botId, role: "bot" },
    select: { blocks: true },
  });
  return messages.flatMap((message) => {
    const parsed = MessageBlock.array().safeParse(message.blocks);
    return parsed.success ? [groupReplyText(parsed.data)].filter((text) => text.trim()) : [];
  });
}

export function isVisibleGroupTurn(ctx: Pick<RunContext, "thread" | "bot" | "run">): boolean {
  return (
    Boolean(ctx.thread.groupId) && !isHiddenBot(ctx.bot) && !isBackgroundRunTrigger(ctx.run.trigger)
  );
}

/** A duplicate is already delivered; a new progress beat follows the ordinary progress budget. */
export async function isDuplicateGroupProgress(ctx: RunContext, text: string): Promise<boolean> {
  return (
    isVisibleGroupTurn(ctx) &&
    isVisibleGroupReply(text, await visibleGroupReplies(ctx.deps.prisma, ctx.run))
  );
}

/** Use the same durable evidence for the final bubble and notification/peer result. */
export async function prepareGroupTurnReply(
  ctx: RunContext,
  blocks: MessageBlock[],
  text: string,
): Promise<{ blocks: MessageBlock[]; text: string }> {
  if (!isVisibleGroupTurn(ctx)) {
    return {
      blocks: ctx.thread.groupId
        ? await settleHandoffNarration(ctx.deps.prisma, ctx.run, {
            handedOff: ctx.state.handedOff,
            blocks,
          })
        : blocks,
      text,
    };
  }
  const visible = await visibleGroupReplies(ctx.deps.prisma, ctx.run);
  const duplicate = isVisibleGroupReply(groupReplyText(blocks), visible);
  return {
    blocks: duplicate
      ? finalBlocksAfterMidTurnProgress(
          blocks.filter((block) => block.kind !== "text"),
          true,
        )
      : blocks,
    text: duplicate || isVisibleGroupReply(text, visible) ? "" : text,
  };
}
