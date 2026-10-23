/**
 * Provider concurrency is shared by a user's main bots and their background workers. When the
 * provider says "concurrency limit exceeded", background workers back off first (with a growing
 * pause, per process), so the main bot's next reply gets the free capacity.
 */
let workerPauseUntil = 0;
let strikes = 0;

export function isProviderConcurrencyLimit(error: unknown): boolean {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error
        ? String((error as { errorMessage?: unknown }).errorMessage ?? JSON.stringify(error))
        : String(error);
  return /concurrency limit|too many concurrent|concurrent requests? (?:limit|exceeded)/i.test(
    text,
  );
}

export function noteProviderConcurrencyLimit(now = Date.now()) {
  strikes = Math.min(strikes + 1, 5);
  workerPauseUntil = Math.max(workerPauseUntil, now + Math.min(60_000, 5_000 * 2 ** (strikes - 1)));
}

export function noteProviderOk() {
  strikes = 0;
}

export function workerPauseRemainingMs(now = Date.now()) {
  return Math.max(0, workerPauseUntil - now);
}

/** Waits out a worker pause before a background model call; main turns never wait. */
export async function waitForProviderLane(
  lane: "main" | "background" | undefined,
  signal?: AbortSignal,
) {
  if (lane !== "background") return;
  for (;;) {
    const wait = workerPauseRemainingMs();
    if (wait <= 0 || signal?.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 1_000)));
  }
}

export function resetProviderLanesForTest() {
  workerPauseUntil = 0;
  strikes = 0;
}
