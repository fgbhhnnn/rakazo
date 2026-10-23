import type { Prisma } from "./client.js";

/**
 * Background workers (background_task) are internal child bots. They are never listed as bots
 * (sidebar, search, pickers, fleet tools); their thread is reached only from the in-chat
 * "后台任务" card. They are recognised by spawnKey, so workers created earlier are hidden too
 * and no migration is needed.
 */
export const HIDDEN_BOT_SPAWN_PREFIX = "bg-worker:";

/** Where-clause for bots a person or a bot may see in lists. NULL spawnKey must stay visible. */
export const VISIBLE_BOT_WHERE: Prisma.BotWhereInput = {
  OR: [{ spawnKey: null }, { NOT: { spawnKey: { startsWith: HIDDEN_BOT_SPAWN_PREFIX } } }],
};

export function isHiddenBot(bot: { spawnKey?: string | null }): boolean {
  return Boolean(bot.spawnKey?.startsWith(HIDDEN_BOT_SPAWN_PREFIX));
}
