import { HIDDEN_BOT_SPAWN_PREFIX } from "@rakazo/db";
import { computerIdleSleepEnabled } from "./computer-idle.js";

/**
 * Whether a run skips the workspace checkpoint that otherwise runs before its final reply.
 *
 * A background worker shares the dispatcher's team computer, and the run that finishes last
 * exports the whole remote workspace to the home store before posting its reply. On E2B that
 * export took 200+ s, so even an `echo` task's result reached the dispatcher 3-4 min late. A
 * worker's reply is what the user is waiting for: it goes out at once, and the computer's idle
 * sleep (scheduled when the run provisioned it) checkpoints the same files before stopping it,
 * as it already does whenever a run's checkpoint is skipped or fails. Without idle sleep there
 * is no later checkpoint, so the run keeps its own.
 */
export function defersTerminalCheckpoint(bot: { spawnKey?: string | null }): boolean {
  return Boolean(bot.spawnKey?.startsWith(HIDDEN_BOT_SPAWN_PREFIX)) && computerIdleSleepEnabled();
}
