import type { PrismaClient } from "@rakazo/db";

/** Count work by its origin thread, including workers of every current team role. */
export async function groupBackgroundTasks(
  prisma: PrismaClient,
  threadId: string,
  members: readonly { botId: string }[],
) {
  const rows = await prisma.backgroundTaskQueue.groupBy({
    by: ["status"],
    where: {
      threadId,
      botId: { in: members.map((member) => member.botId) },
      status: { in: ["queued", "claiming", "started"] },
    },
    _count: { _all: true },
  });
  return rows.reduce(
    (total, row) => {
      total[row.status === "queued" ? "queued" : "running"] += row._count._all;
      return total;
    },
    { running: 0, queued: 0 },
  );
}
