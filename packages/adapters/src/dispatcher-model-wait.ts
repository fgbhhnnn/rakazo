import type { StreamActivityKind } from "@rakazo/adapter-kit";

/**
 * A dispatcher turn waiting on the model's next reply is not idle. Reasoning models behind an
 * OpenAI-compatible endpoint think silently: no reasoning delta reaches the stream, so the first
 * token of a live reply can take 60–90 s or more. The plain idle limit (90 s) cut those turns
 * off as "no progress" and retried them from scratch. While a model call is pending the
 * watchdog allows this longer wait instead; once the model streams or a tool runs, the normal
 * idle limit applies again. The hard cap on the whole turn is unchanged.
 */

/** Default longest silent wait for the model's first output of one call. */
export const DISPATCHER_MODEL_WAIT_DEFAULT_MS = 180_000;

/**
 * RAKAZO_DISPATCHER_MODEL_WAIT_MAX_MS (default 3 min), never below the idle limit and never
 * above the hard cap.
 */
export function dispatcherModelWaitMs(
  idleMs: number,
  capMs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.RAKAZO_DISPATCHER_MODEL_WAIT_MAX_MS);
  const wait =
    Number.isFinite(parsed) && parsed >= 5_000
      ? Math.floor(parsed)
      : DISPATCHER_MODEL_WAIT_DEFAULT_MS;
  return Math.min(Math.max(wait, idleMs), Math.max(capMs, idleMs));
}

/**
 * What an agent event says about the turn: a model call just started and the turn now waits on
 * the model, or the model/tools produced output. Other events keep the current window.
 */
export function streamActivityKindOf(eventType: string): StreamActivityKind | undefined {
  switch (eventType) {
    case "turn_start":
    case "message_start":
      return "model_wait";
    case "message_update":
    case "message_end":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return "output";
    default:
      return undefined;
  }
}
