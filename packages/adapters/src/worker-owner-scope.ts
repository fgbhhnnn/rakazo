import type {
  AdapterContext,
  DurableMemoryScope,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { isParentBackgroundWorker } from "./worker-model.js";

/*
 * A hidden background worker works for its main bot, so it uses the main bot's data: MCP servers,
 * command variables and saved credentials, memory, taught skills and scratchpad. Nothing is copied
 * and no rows change; the worker's run simply reads (and records into) the main bot's scope.
 * Visible child bots keep their own data. Compacted history stays per thread: a worker's own
 * thread history is still recalled under the worker's id.
 */

type ScopedBot = { id: string; spawnKey?: string | null; parentBotId?: string | null };

/** The bot whose data a run uses: the main bot for a hidden worker, else the bot itself. */
export function dataBotId(bot: ScopedBot): string {
  return isParentBackgroundWorker(bot) ? bot.parentBotId : bot.id;
}

/** The main bot's id and memory scope for a hidden worker; null for every other bot. */
export async function loadWorkerOwner(
  prisma: Pick<PrismaClient, "bot">,
  bot: ScopedBot,
): Promise<{ id: string; memoryScope: string | null } | null> {
  if (!isParentBackgroundWorker(bot)) return null;
  return prisma.bot.findUnique({
    where: { id: bot.parentBotId },
    select: { id: true, memoryScope: true },
  });
}

/**
 * For MCP lookups keyed by context.botId: the main bot's id when that bot is a hidden worker.
 * Falls back to the given id when the lookup fails, so a worker never gains another bot's servers.
 */
export async function mcpScopeBotId(
  prisma: Pick<PrismaClient, "bot">,
  botId: string,
): Promise<string> {
  try {
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      select: { id: true, spawnKey: true, parentBotId: true },
    });
    return bot ? dataBotId(bot) : botId;
  } catch {
    return botId;
  }
}

/**
 * Semantic recall for a run. A worker recalls the main bot's durable memory and, when its thread
 * has compacted history, its own history namespace; results are merged by score.
 */
export async function recallForRun(
  provider: Pick<SemanticMemoryProvider, "recall">,
  request: SemanticMemoryRecallRequest,
  owner: { id: string; scope: DurableMemoryScope } | null,
  context: AdapterContext,
): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
  if (!owner) return provider.recall(request, context);
  const { historyGeneration, ...durable } = request;
  const [ownerResult, historyResult] = await Promise.all([
    provider.recall({ ...durable, scope: owner.scope, botId: owner.id }, context),
    historyGeneration === undefined ? null : provider.recall(request, context),
  ]);
  if (!historyResult) return ownerResult;
  if (!ownerResult.ok) return historyResult;
  if (!historyResult.ok) return ownerResult;
  const seen = new Set<string>();
  const merged = [...ownerResult.value, ...historyResult.value]
    .filter((item) => {
      const key = item.id ?? item.memory;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, request.limit);
  return { ok: true, value: merged };
}
