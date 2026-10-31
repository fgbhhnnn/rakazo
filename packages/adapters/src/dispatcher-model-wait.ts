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

/** The part of an agent event the watchdog reads. */
export type StreamActivityEvent = {
  readonly type: string;
  readonly message?: { readonly role?: string } | undefined;
};

/**
 * What an agent event says about the turn: a model call just started and the turn now waits on
 * the model, or the model/tools produced output. Other events keep the current window.
 *
 * Only the assistant's own message is model output. The prompt (user) message and tool results
 * are also announced with message_start/message_end, right after turn_start and before the model
 * says anything; counting them as output dropped a silently thinking model back to the short
 * idle limit, so the long first-token wait never applied.
 */
export function streamActivityKindOf(event: StreamActivityEvent): StreamActivityKind | undefined {
  switch (event.type) {
    case "turn_start":
      return "model_wait";
    case "message_start":
      return event.message?.role === "assistant" ? "model_wait" : undefined;
    case "message_update":
    case "message_end":
      return event.message?.role === "assistant" ? "output" : undefined;
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return "output";
    default:
      return undefined;
  }
}
