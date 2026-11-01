import type { MessageBlock } from "@rakazo/contracts";
import { isBackgroundRunTrigger } from "@rakazo/core";
import { isHiddenBot } from "@rakazo/db";
import type { RunContext } from "./run-context.js";
import { finalBlocksAfterMidTurnProgress, narrationStatusLine } from "./user-progress.js";

/** Group members write once, in their final reply or handoff; interim text stays in the live view. */
export function holdsGroupTurnReply(ctx: Pick<RunContext, "thread" | "bot" | "run">): boolean {
  return (
    Boolean(ctx.thread.groupId) && !isHiddenBot(ctx.bot) && !isBackgroundRunTrigger(ctx.run.trigger)
  );
}

/** Keep explicit progress as a fallback too, in case the model ends without a final answer. */
export async function holdGroupProgress(
  ctx: RunContext,
  text: string,
  truncated: boolean,
): Promise<{ ok: true; truncated?: true } | null> {
  if (!holdsGroupTurnReply(ctx)) return null;
  const { reply } = ctx.state;
  reply.discardedMidTurnNarration = true;
  reply.lastDiscardedMidTurnNarration = text;
  reply.discardedNarrationCount += 1;
  await ctx.deps.events.append({
    spaceId: ctx.run.spaceId,
    threadId: ctx.thread.id,
    botId: ctx.bot.id,
    runId: ctx.run.id,
    type: "thread.progress",
    payload: { reset: true, text: narrationStatusLine(text), activity: true },
  });
  return truncated ? { ok: true, truncated: true } : { ok: true };
}

/** The handoff/question already displays its brief. Preserve attachments, not a second reply. */
export function groupTurnReplyBlocks(ctx: RunContext, blocks: MessageBlock[]): MessageBlock[] {
  if (!holdsGroupTurnReply(ctx) || !ctx.state.handedOff) return blocks;
  return finalBlocksAfterMidTurnProgress(
    blocks.filter((block) => block.kind !== "text"),
    true,
  );
}

/** A suppressed handoff variant must not reappear in a push or peer result either. */
export function groupTurnReplyText(ctx: RunContext, text: string): string {
  return holdsGroupTurnReply(ctx) && ctx.state.handedOff ? "" : text;
}
