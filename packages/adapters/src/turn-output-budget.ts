/**
 * Output-token default for bot turns: the main bot's replies and background worker runs. The
 * general 4096 fallback cut long replies and reports off mid-sentence, so a bot turn whose
 * connection sets no maxTokens asks for what the model itself can write:
 *
 * - a catalog model: its card's output ceiling (pi model definitions);
 * - an OpenAI-compatible model: the most conservative ceiling the pi catalog lists for the same
 *   model id at any provider, since the connection's card only carries the 4096 default;
 * - nothing known: UNKNOWN_MODEL_OUTPUT_DEFAULT.
 *
 * Every value is fitted to the context window (at least three quarters stay for input), and
 * the runtime clamps it again the same way. A maxTokens configured on the connection (user or
 * DB settings) always wins and is never changed. Unlaned internal calls (history compaction,
 * auto-review) keep the general default. The result is run-scoped and never persisted.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";
import { effectiveOutputReserve, resolveCompletionMaxTokens } from "./pi-runtime-limits.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";

/** Fallback for a bot turn whose model's output ceiling is unknown anywhere. */
export const UNKNOWN_MODEL_OUTPUT_DEFAULT = 32_768;

type Card = Pick<Model<Api>, "provider" | "maxTokens" | "reasoning" | "contextWindow">;

/** Bot turns: the main bot's own replies and background workers. */
function isBotTurn(lane: AgentRunRequest["lane"]): boolean {
  return lane === "main" || lane === "background";
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

let catalogCeilings: Map<string, number> | undefined;

/** The last path segment of a model id: "x-ai/grok-4.7" and "grok-4.7" are the same model. */
function bareModelId(id: string): string {
  return (id.split("/").at(-1) ?? id).trim().toLowerCase();
}

/**
 * The lowest output ceiling the pi catalog lists for a model id at any provider, or undefined
 * when the catalog does not know it. The lowest, because the endpoint may be any of them.
 */
export function catalogOutputCeiling(modelId: string): number | undefined {
  if (!catalogCeilings) {
    const ceilings = new Map<string, number>();
    try {
      const catalog = builtinModels() as { getProviders?: () => readonly Provider[] };
      for (const provider of catalog.getProviders?.() ?? []) {
        for (const model of provider.getModels?.() ?? []) {
          const ceiling = positive(model.maxTokens);
          if (!ceiling) continue;
          const key = bareModelId(model.id);
          ceilings.set(key, Math.min(ceilings.get(key) ?? ceiling, ceiling));
        }
      }
    } catch (error) {
      getLogger().warn("model catalog output ceilings unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    catalogCeilings = ceilings;
  }
  return catalogCeilings.get(bareModelId(modelId));
}

type Provider = { getModels?: () => readonly { id: string; maxTokens?: number }[] };

/** Test seam: forget the cached catalog ceilings. */
export function resetCatalogOutputCeilings() {
  catalogCeilings = undefined;
}

/**
 * The cap a bot turn should get when its connection sets none, or undefined to leave the
 * config alone (configured cap, not a bot turn, or no raise over the existing default).
 */
export function turnDefaultMaxTokens(
  lane: AgentRunRequest["lane"],
  config: AgentRunRequest["model"],
  card: Card | undefined,
): number | undefined {
  if (!isBotTurn(lane) || config.maxTokens !== undefined || !card) return undefined;
  const compatible =
    config.provider === OPENAI_COMPATIBLE_PROVIDER_ID ||
    card.provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  // A compatible connection's card only carries the default, not the endpoint's ceiling.
  const known = compatible ? catalogOutputCeiling(config.id) : positive(card.maxTokens);
  const wanted = known ?? UNKNOWN_MODEL_OUTPUT_DEFAULT;
  const contextWindow = positive(config.contextWindow) ?? positive(card.contextWindow);
  const fitted = contextWindow ? effectiveOutputReserve(contextWindow, wanted) : wanted;
  // What the run would send without this default; only a raise is applied.
  const current = resolveCompletionMaxTokens(
    card.maxTokens,
    undefined,
    undefined,
    card.reasoning,
    contextWindow,
  );
  return fitted > current ? fitted : undefined;
}

/** This run's model config with the bot-turn default applied; never persisted. */
export function withTurnOutputDefault<T extends AgentRunRequest["model"]>(
  lane: AgentRunRequest["lane"],
  config: T,
): T {
  if (!isBotTurn(lane) || config.maxTokens !== undefined) return config;
  let card: Card | undefined;
  try {
    card = resolveRuntimeModel(config).model;
  } catch {
    // An unresolvable model fails the run on its own; leave its config alone here.
    return config;
  }
  const maxTokens = turnDefaultMaxTokens(lane, config, card);
  return maxTokens === undefined ? config : { ...config, maxTokens };
}
