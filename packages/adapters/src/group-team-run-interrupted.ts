import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { findHumanAuthoredMessage } from "./human-message-query.js";

/** The exact team request superseded by this human message, shared by prompting and stop. */
export async function interruptedTeamRun(
  prisma: Pick<PrismaClient, "groupTeamRun" | "message">,
  threadId: string,
  anchor: { id: string; seq: number },
) {
  const message = await prisma.message.findUnique({
    where: { id: anchor.id },
    select: { createdAt: true },
  });
  if (!message) return undefined;
  const ended = await prisma.groupTeamRun.findMany({
    where: {
      threadId,
      status: "superseded",
      originMessageId: { not: anchor.id },
      endedAt: { gte: message.createdAt },
    },
    orderBy: { endedAt: "desc" },
    select: { id: true, originMessageId: true },
    take: 5,
  });
  for (const row of ended) {
    const origin = await prisma.message.findUnique({
      where: { id: row.originMessageId },
      select: { seq: true, blocks: true },
    });
    if (!origin || origin.seq >= anchor.seq) continue;
    const between = await findHumanAuthoredMessage(prisma, {
      threadId,
      seq: { gt: origin.seq, lt: anchor.seq },
    });
    if (between) continue;
    const goal = Array.isArray(origin.blocks)
      ? (origin.blocks as MessageBlock[])
          .flatMap((block) => (block.kind === "text" ? [block.text] : []))
          .join("")
          .trim()
      : "";
    return { ...row, goal: goal || " " };
  }
  return undefined;
}
