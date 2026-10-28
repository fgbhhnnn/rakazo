import type { StreamActivityKind } from "@rakazo/adapter-kit";

/** Absolute ceiling of a dispatcher main turn that keeps making progress. */
export const DISPATCHER_TURN_HARD_CAP_DEFAULT_MS = 5 * 60_000;

/**
 * Longest a dispatcher main turn may run in total, however steadily it streams
 * (RAKAZO_DISPATCHER_TURN_HARD_CAP_MS, default 5 min). Never below the idle limit.
 */
export function dispatcherTurnHardCapMs(
  idleMs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.RAKAZO_DISPATCHER_TURN_HARD_CAP_MS);
  const cap =
    Number.isFinite(parsed) && parsed >= 5_000
      ? Math.floor(parsed)
      : DISPATCHER_TURN_HARD_CAP_DEFAULT_MS;
  return Math.max(cap, idleMs);
}

/**
 * Clears the watchdog; `touch` records model progress and restarts the idle window. With
 * `"model_wait"` a model call just started, so the longer model-wait window applies until the
 * next `"output"` (see dispatcher-model-wait.ts); without a kind the current window restarts.
 */
export type DispatcherWatchdog = (() => void) & {
  touch: (kind?: StreamActivityKind) => void;
};

/**
 * Stops a dispatcher main turn that made no progress (no streamed token, tool call or other
 * runtime activity) for `idleMs`, or that ran past `capMs` in total. A slow but live model
 * reply is no longer cut off at a fixed wall-clock limit; a hung one still is. With
 * `options.modelWaitMs`, a turn waiting on a model call may stay silent that long instead.
 */
export function startDispatcherIdleWatchdog(
  controller: AbortController,
  onFire: () => void,
  idleMs: number,
  capMs: number,
  timeoutError: (ms: number) => Error,
  options: { modelWaitMs?: number } = {},
): DispatcherWatchdog {
  let done = false;
  const modelWaitMs = Math.max(options.modelWaitMs ?? idleMs, idleMs);
  let windowMs = idleMs;
  const fire = (ms: number) => {
    if (done) return;
    done = true;
    clearTimeout(idle);
    clearTimeout(cap);
    onFire();
    controller.abort(timeoutError(ms));
  };
  let idle = setTimeout(() => fire(idleMs), idleMs);
  idle.unref?.();
  const cap = setTimeout(() => fire(capMs), capMs);
  cap.unref?.();
  const clear = () => {
    done = true;
    clearTimeout(idle);
    clearTimeout(cap);
  };
  controller.signal.addEventListener("abort", clear);
  const watchdog = clear as DispatcherWatchdog;
  watchdog.touch = (kind) => {
    if (done) return;
    if (kind) windowMs = kind === "model_wait" ? modelWaitMs : idleMs;
    const ms = windowMs;
    clearTimeout(idle);
    idle = setTimeout(() => fire(ms), ms);
    idle.unref?.();
  };
  return watchdog;
}
