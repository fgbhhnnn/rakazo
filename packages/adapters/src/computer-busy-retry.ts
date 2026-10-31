import { HIDDEN_BOT_SPAWN_PREFIX } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { ComputerBusyError } from "./computer-lifecycle.js";

/** How long a tool waits for a sibling run to finish booting the shared computer. */
export const COMPUTER_BUSY_WAIT_MS = 90_000;
const COMPUTER_BUSY_POLL_MS = 2_000;

/**
 * How long a run's tool waits for a busy computer. Only background workers wait: they start in
 * bursts on their dispatcher's one computer. Any other run keeps failing fast, so its job is
 * requeued and a computer held by another run's live lease is left alone.
 */
export function computerBusyWaitMs(bot: { spawnKey?: string | null }): number {
  return bot.spawnKey?.startsWith(HIDDEN_BOT_SPAWN_PREFIX) ? COMPUTER_BUSY_WAIT_MS : 0;
}

/**
 * Background workers share their dispatcher's computer. When several start at once, the first
 * shell call of each provisions it; one claims the boot and the others get ComputerBusyError.
 * Thrown out of a tool, that error requeued the whole run with the tool's effect already claimed,
 * so the replayed call came back "interrupted, outcome unknown". A boot by a sibling takes seconds,
 * so wait it out here, inside the tool call, before giving up the run.
 */
export async function provisionWhenNotBusy<T>(
  provision: () => Promise<T>,
  options: { signal?: AbortSignal; waitMs?: number; pollMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.waitMs ?? COMPUTER_BUSY_WAIT_MS);
  const pollMs = options.pollMs ?? COMPUTER_BUSY_POLL_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await provision();
    } catch (error) {
      if (!(error instanceof ComputerBusyError) || Date.now() + pollMs > deadline) throw error;
      options.signal?.throwIfAborted();
      if (attempt === 1) getLogger().info("computer.busy_wait");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, pollMs);
        function done() {
          options.signal?.removeEventListener("abort", aborted);
          resolve();
        }
        function aborted() {
          clearTimeout(timer);
          reject(options.signal?.reason ?? new Error("aborted"));
        }
        options.signal?.addEventListener("abort", aborted, { once: true });
      });
    }
  }
}
