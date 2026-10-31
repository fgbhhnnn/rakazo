import { isHumanAuthoredMessage } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";

/**
 * Scan past relays in sequence order. Blocks may be encrypted at rest, so authorship must be
 * checked on the decrypted message rather than in a database JSON predicate.
 */
export async function findHumanAuthoredMessage(
  prisma: Pick<PrismaClient, "message">,
  where: Prisma.MessageWhereInput,
) {
  let cursor: number | undefined;
  for (;;) {
    const message = await prisma.message.findFirst({
      where: {
        ...(cursor === undefined ? where : { AND: [where, { seq: { lt: cursor } }] }),
        role: "user",
      },
      orderBy: { seq: "desc" },
      select: { id: true, seq: true, createdAt: true, role: true, botId: true, blocks: true },
    });
    if (!message || isHumanAuthoredMessage(message)) return message;
    cursor = message.seq;
  }
}
