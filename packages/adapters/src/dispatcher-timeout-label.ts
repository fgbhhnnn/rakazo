import { DispatcherTurnTimeout, dispatcherTurnMaxMs } from "./dispatcher-mode.js";

/**
 * The timeout to record for a dispatcher turn its watchdog stopped. The watchdog aborts with the
 * limit that actually fired (the idle limit or the absolute cap); rebuilding the error from the
 * idle limit mislabelled a cap stop ("took longer than 240 s" after 10 minutes).
 */
export function dispatcherWatchdogTimeout(signal: AbortSignal | undefined): DispatcherTurnTimeout {
  const reason: unknown = signal?.reason;
  return reason instanceof DispatcherTurnTimeout
    ? reason
    : new DispatcherTurnTimeout(dispatcherTurnMaxMs());
}

/** What the user sees when a timed-out dispatcher turn could not be restarted. */
export function dispatcherTimeoutNotice(error: unknown, signal: AbortSignal | undefined): string {
  const timeout =
    error instanceof DispatcherTurnTimeout ? error : dispatcherWatchdogTimeout(signal);
  return `回复超时（超过 ${Math.round(timeout.ms / 1000)} 秒），已重试仍未完成。请再发一次消息。`;
}
