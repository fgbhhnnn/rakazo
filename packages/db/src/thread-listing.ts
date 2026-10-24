import { ACTIVE_RUN_STATUSES, BACKGROUND_RUN_TRIGGERS, plainTextFromMarkdown } from "@rakazo/core";
import { HIDDEN_BOT_SPAWN_PREFIX } from "./bot-visibility.js";

export const activeRunStatuses = [...ACTIVE_RUN_STATUSES];
const backgroundRunTriggers = [...BACKGROUND_RUN_TRIGGERS];
const userVisibleBotRunTriggers = ["bot_message", ...BACKGROUND_RUN_TRIGGERS];
const latestBotRunOrderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];

/**
 * Active conversational/foreground runs for a bot's sidebar status. Background
 * ticket runs keep working silently, so they must not make the avatar spin.
 */
export const activeRunSelection = {
  where: {
    status: { in: activeRunStatuses },
    trigger: { notIn: backgroundRunTriggers },
  },
  orderBy: { createdAt: "desc" as const },
  select: { status: true },
} as const;

/** Waiting, running, then leased work wins over queued work, regardless of creation order. */
export function primaryActiveRun<T extends { status: string }>(runs: readonly T[]): T | undefined {
  return (
    runs.find((run) => run.status === "waiting_takeover" || run.status === "waiting_input") ??
    runs.find((run) => run.status === "running") ??
    runs.find((run) => run.status === "leased") ??
    runs[0]
  );
}

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
 * Background work per main bot, read inside the bot query: hidden workers (children with a
 * bg-worker spawnKey) that have an active run, and tasks waiting in the queue. Workers are hidden,
 * so without this the main bot looks idle while they work.
 */
export const backgroundWorkSelection = {
  children: {
    where: {
      spawnKey: { startsWith: HIDDEN_BOT_SPAWN_PREFIX },
      runs: { some: { status: { in: activeRunStatuses } } },
    },
    select: { id: true },
  },
  _count: { select: { backgroundTaskQueue: { where: { status: "queued" } } } },
} as const;

export type BackgroundWork = { running: number; queued: number };

export function backgroundWorkOf(bot: {
  children?: unknown[];
  _count?: { backgroundTaskQueue?: number };
}): BackgroundWork {
  return { running: bot.children?.length ?? 0, queued: bot._count?.backgroundTaskQueue ?? 0 };
}

/** Roster status for a main bot: its own run first, else "running" while background work is on. */
export function rosterStatus(ownStatus: string | undefined, background: BackgroundWork) {
  if (ownStatus) return ownStatus;
  return background.running + background.queued > 0 ? "running" : "idle";
}
