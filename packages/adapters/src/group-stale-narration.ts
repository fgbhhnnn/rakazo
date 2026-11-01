import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * A turn that handed off (or asked a teammate) still saves its reply after the tool call, and a
 * fast teammate may already have answered by then. That reply was written before the handoff,
 * so it reads as stale under the teammate's answer: a short one is dropped (the handoff card
 * already says what happened), a long one is kept with a note saying when it was written.
 */

/** Short narration around a handoff adds nothing once the teammate replied. */
export const STALE_NARRATION_MAX_CHARS = 300;

export function staleNarrationNote(targetName: string): string {
  return `（这段是交接前写的，${targetName} 已在上方回复）`;
}

/** Pure part: the blocks to save given who already replied after the handoff. */
export function withoutStaleNarration(
  blocks: readonly MessageBlock[],
  targetName: string,
): MessageBlock[] {
  const text = blocks
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("")
    .trim();
  if (!text) return [...blocks];
  if (text.length <= STALE_NARRATION_MAX_CHARS) {
    return blocks.filter((block) => block.kind !== "text");
  }
  let noted = false;
  return blocks.map((block) => {
    if (noted || block.kind !== "text") return block;
    noted = true;
    return { ...block, text: `${staleNarrationNote(targetName)}\n${block.text}` };
  });
}

/** Never throws; returns `blocks` unchanged when nothing applies. */
export async function settleHandoffNarration(
  prisma: Pick<PrismaClient, "message" | "bot">,
  run: { id: string; threadId: string },
  input: { handedOff: boolean; blocks: MessageBlock[] },
): Promise<MessageBlock[]> {
  if (!input.handedOff) return input.blocks;
  try {
    const card = await prisma.message.findFirst({
      where: {
        threadId: run.threadId,
        clientNonce: { in: [`group-handoff:${run.id}`, `group-question:${run.id}`] },
      },
      orderBy: { seq: "desc" },
      select: { seq: true, blocks: true },
    });
    const handoff = Array.isArray(card?.blocks)
      ? (card.blocks as MessageBlock[]).find((block) => block.kind === "handoff")
      : undefined;
    if (!card || handoff?.kind !== "handoff") return input.blocks;
    const replied = await prisma.message.findFirst({
      where: { threadId: run.threadId, botId: handoff.toBotId, seq: { gt: card.seq } },
      select: { id: true },
    });
    if (!replied) return input.blocks;
    const target = await prisma.bot.findUnique({
      where: { id: handoff.toBotId },
      select: { name: true },
    });
    return withoutStaleNarration(input.blocks, target?.name ?? "对方");
  } catch (error) {
    getLogger().error("handoff narration check", error);
    return input.blocks;
  }
}
