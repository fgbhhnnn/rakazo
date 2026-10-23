import { ACTIVE_RUN_STATUSES, BACKGROUND_RUN_TRIGGERS, plainTextFromMarkdown } from "@rakazo/core";
import { HIDDEN_BOT_SPAWN_PREFIX } from "./bot-visibility.js";
import type { PrismaClient } from "./client.js";

export const activeRunStatuses = [...ACTIVE_RUN_STATUSES];
const backgroundRunTriggers = [...BACKGROUND_RUN_TRIGGERS];
const userVisibleBotRunTriggers = ["bot_message", ...BACKGROUND_RUN_TRIGGERS];
const latestBotRunOrderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];

/**
 * The newest conversational/foreground run for a bot's sidebar status. Background
 * ticket runs keep working silently, so they must not make the avatar spin.
 */
export const activeRunSelection = {
  where: {
    status: { in: activeRunStatuses },
    trigger: { notIn: backgroundRunTriggers },
  },
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: { status: true },
} as const;

/** Latest user-visible run for a bot roster error signal; later success clears an older failure. */
export const latestBotRunSelection = {
  where: { trigger: { notIn: userVisibleBotRunTriggers } },
  orderBy: latestBotRunOrderBy,
  take: 1,
  select: { id: true, status: true },
} as const;

export function previewFromBlocks(blocks: unknown): string {
  const rows = Array.isArray(blocks) ? blocks : [];
  for (const block of rows) {
    if (
      block &&
      typeof block === "object" &&
      "text" in block &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return plainTextFromMarkdown((block as { text: string }).text);
    }
  }
  return "";
}

/**
 * Background work per main bot: worker runs still active plus tasks waiting in the queue.
 * Workers are hidden bots, so without this the main bot looks idle while they work.
 */
export async function backgroundTaskCounts(
  prisma: Pick<PrismaClient, "run" | "backgroundTaskQueue">,
  botIds: readonly string[],
): Promise<Map<string, { running: number; queued: number }>> {
  const counts = new Map<string, { running: number; queued: number }>();
  if (botIds.length === 0) return counts;
  const entry = (id: string) => {
    let value = counts.get(id);
    if (!value) {
      value = { running: 0, queued: 0 };
      counts.set(id, value);
    }
    return value;
  };
  const [runs, queued] = await Promise.all([
    prisma.run.findMany({
      where: {
        status: { in: activeRunStatuses },
        bot: {
          OR: botIds.map((id) => ({
            spawnKey: { startsWith: `${HIDDEN_BOT_SPAWN_PREFIX}${id}:` },
          })),
        },
      },
      select: { botId: true, bot: { select: { spawnKey: true } } },
    }),
    prisma.backgroundTaskQueue.groupBy({
      by: ["botId"],
      where: { botId: { in: [...botIds] }, status: "queued" },
      _count: { _all: true },
    }),
  ]);
  const busyWorkers = new Map<string, Set<string>>();
  for (const run of runs) {
    const owner = run.bot.spawnKey?.slice(HIDDEN_BOT_SPAWN_PREFIX.length).split(":")[0];
    if (!owner) continue;
    const workers = busyWorkers.get(owner) ?? new Set<string>();
    workers.add(run.botId);
    busyWorkers.set(owner, workers);
  }
  for (const [owner, workers] of busyWorkers) entry(owner).running = workers.size;
  for (const row of queued) entry(row.botId).queued = row._count._all;
  return counts;
}

/** Roster status for a main bot: its own run first, else "running" while background work is on. */
export function rosterStatus(
  ownStatus: string | undefined,
  background: { running: number; queued: number } | undefined,
) {
  if (ownStatus) return ownStatus;
  return background && background.running + background.queued > 0 ? "running" : "idle";
}
