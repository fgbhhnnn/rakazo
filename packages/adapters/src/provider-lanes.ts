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

/**
 * Per-process model-call limiter. All model calls share RAKAZO_MODEL_MAX_CONCURRENCY slots
 * (default 4, matching a small gateway account); background workers may use at most
 * RAKAZO_WORKER_MODEL_CONCURRENCY of them (default 2) and never the last free slot, and
 * waiting main turns are always served first. Returns the release function.
 */
let activeMain = 0;
let activeBackground = 0;
let waitingMain = 0;
const waiters = new Set<() => void>();

function envInt(name: string, fallback: number, env: Record<string, string | undefined>) {
  const parsed = Number(env[name]?.trim() || Number.NaN);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}
export function modelMaxConcurrency(env: Record<string, string | undefined> = process.env) {
  return envInt("RAKAZO_MODEL_MAX_CONCURRENCY", 4, env);
}
export function workerModelConcurrency(env: Record<string, string | undefined> = process.env) {
  return envInt("RAKAZO_WORKER_MODEL_CONCURRENCY", 2, env);
}

function canStart(lane: "main" | "background") {
  const total = modelMaxConcurrency();
  const inUse = activeMain + activeBackground;
  if (lane === "main") return inUse < total;
  return (
    waitingMain === 0 &&
    activeBackground < Math.min(workerModelConcurrency(), Math.max(1, total - 1)) &&
    inUse < Math.max(1, total - 1)
  );
}

function wakeAll() {
  for (const wake of [...waiters]) wake();
}

export async function acquireProviderLane(
  laneArg: "main" | "background" | undefined,
  signal?: AbortSignal,
): Promise<() => void> {
  const lane = laneArg === "background" ? "background" : "main";
  if (lane === "main") waitingMain += 1;
  try {
    while (!canStart(lane)) {
      if (signal?.aborted) return () => undefined;
      await new Promise<void>((resolve) => {
        const done = () => {
          waiters.delete(done);
          resolve();
        };
        waiters.add(done);
        setTimeout(done, 500);
      });
    }
  } finally {
    if (lane === "main") waitingMain -= 1;
  }
  if (lane === "main") activeMain += 1;
  else activeBackground += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (lane === "main") activeMain -= 1;
    else activeBackground -= 1;
    wakeAll();
  };
}

export function resetProviderLanesForTest() {
  workerPauseUntil = 0;
  strikes = 0;
  activeBackground = 0;
  activeMain = 0;
  waitingMain = 0;
  waiters.clear();
}
