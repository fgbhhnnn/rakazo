import { HIDDEN_BOT_SPAWN_PREFIX } from "@rakazo/db";
import type { ModelChoice } from "./model-selection.js";

type ModelSource = {
  bot: {
    findUnique(args: {
      where: { id: string };
      select: { modelProvider: true; modelId: true; thinkingLevel: true };
    }): Promise<ModelChoice | null>;
  };
};

/** A hidden background worker that background_task spawned for its parent (main) bot. */
export function isParentBackgroundWorker(bot: {
  spawnKey?: string | null;
  parentBotId?: string | null;
}): bot is { spawnKey: string; parentBotId: string } {
  return Boolean(
    bot.parentBotId && bot.spawnKey?.startsWith(`${HIDDEN_BOT_SPAWN_PREFIX}${bot.parentBotId}:`),
  );
}

/**
 * The model a bot runs with. A hidden background worker follows its parent bot's current
 * model, read at run time, so changing the main bot's model moves its workers too. Every
 * other bot, and a worker whose parent has no model of its own, keeps its own columns
 * (and so the existing default). Nothing is written.
 */
export async function botModelChoice<
  T extends ModelChoice & {
    spawnKey?: string | null;
    parentBotId?: string | null;
  },
>(prisma: ModelSource, bot: T): Promise<T> {
  if (!isParentBackgroundWorker(bot)) return bot;
  const parent = await prisma.bot
    .findUnique({
      where: { id: bot.parentBotId },
      select: { modelProvider: true, modelId: true, thinkingLevel: true },
    })
    .catch(() => null);
  if (!parent?.modelProvider || !parent.modelId) return bot;
  return {
    ...bot,
    modelProvider: parent.modelProvider,
    modelId: parent.modelId,
    thinkingLevel: parent.thinkingLevel,
  };
}
