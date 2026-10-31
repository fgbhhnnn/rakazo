/**
 * A dispatcher turn whose model keeps calling tools it cannot use (disabled work tools, a second
 * handoff, a worker-only tool) loops until the watchdog kills it, and the user sees a timeout
 * instead of a reply. The same-input loop guard misses this when each call varies its input.
 * After RAKAZO_DISPATCHER_REFUSED_TOOL_LIMIT refusals in one turn, every further refusal tells the
 * model to stop calling tools and write its reply now.
 */
const DEFAULT_LIMIT = 3;

export function dispatcherRefusedToolLimit(): number {
  const raw = Number(process.env.RAKAZO_DISPATCHER_REFUSED_TOOL_LIMIT);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_LIMIT;
}

export const REFUSED_TOOL_STOP =
  "Tool calls keep being refused in this turn. Stop calling tools now and write your reply to the user with what you already have; say plainly what you could not do.";

export function refusedTool<T extends { error: string }>(
  state: { dispatcherTurn?: boolean; refusedToolCalls?: number },
  result: T,
): T | (T & { stop: true }) {
  if (!state.dispatcherTurn) return result;
  state.refusedToolCalls = (state.refusedToolCalls ?? 0) + 1;
  if (state.refusedToolCalls < dispatcherRefusedToolLimit()) return result;
  return { ...result, error: `${result.error} ${REFUSED_TOOL_STOP}`, stop: true as const };
}
