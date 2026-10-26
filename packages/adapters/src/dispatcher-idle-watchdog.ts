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

/** Clears the watchdog; `touch` records model progress and restarts the idle window. */
export type DispatcherWatchdog = (() => void) & { touch: () => void };

/**
 * Stops a dispatcher main turn that made no progress (no streamed token, tool call or other
 * runtime activity) for `idleMs`, or that ran past `capMs` in total. A slow but live model
 * reply is no longer cut off at a fixed wall-clock limit; a hung one still is.
 */
export function startDispatcherIdleWatchdog(
  controller: AbortController,
  onFire: () => void,
  idleMs: number,
  capMs: number,
  timeoutError: (ms: number) => Error,
): DispatcherWatchdog {
  let done = false;
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
  watchdog.touch = () => {
    if (done) return;
    clearTimeout(idle);
    idle = setTimeout(() => fire(idleMs), idleMs);
    idle.unref?.();
  };
  return watchdog;
}
