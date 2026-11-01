import type { Prisma } from "@rakazo/db";

/**
 * Whether the leader's next send to `targetId` is a review round: the member handed a new result
 * on (its stage returned to the leader, or passed to someone) after the leader's last send to it.
 * Relaying a teammate's answer or asking for a fix after a new result is progress, not a loop
 * (see core nextLeaderStreak).
 */
export async function leaderSendIsRevision(
  tx: Pick<Prisma.TransactionClient, "message">,
  row: {
    threadId: string;
    leaderBotId: string;
    lastLeaderTargetId: string | null;
    createdAt: Date;
  },
  targetId: string,
): Promise<boolean> {
  if (row.lastLeaderTargetId !== targetId) return false;
  const lastSend = await tx.message.findFirst({
    where: {
      threadId: row.threadId,
      botId: row.leaderBotId,
      clientNonce: { startsWith: "group-handoff:" },
      createdAt: { gte: row.createdAt },
    },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  if (!lastSend) return false;
  const result = await tx.message.findFirst({
    where: {
      threadId: row.threadId,
      botId: targetId,
      clientNonce: { startsWith: "group-handoff:" },
      seq: { gt: lastSend.seq },
    },
    select: { id: true },
  });
  return Boolean(result);
}
