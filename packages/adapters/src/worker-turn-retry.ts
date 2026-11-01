import { runContinueJob } from "@rakazo/adapter-kit";
import { isHiddenBot } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { RunContext } from "./run-context.js";
import { persistTurnCheckpoint } from "./run-context.js";
import { isTransientWorkerTurnError } from "./worker-turn-error.js";

export const MAX_WORKER_TURN_RETRIES = 3;
export const WORKER_RETRY_STATUS = "turn_retry";

/** The database may still be busy when recording the turn retry; don't lose its checkpoint. */
async function persistRetry<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (!isTransientWorkerTurnError(error) || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

/** Reuse the run and its effect identities. Postgres owns the retry budget and delayed wake. */
export async function retryTransientWorkerTurn(ctx: RunContext, error: unknown): Promise<boolean> {
  if (!isHiddenBot(ctx.bot) || !isTransientWorkerTurnError(error)) return false;
  const { deps, run, workerId, fence } = ctx;
  const pending = [...ctx.state.effects.pendingTurnCheckpoints.keys()].at(-1);
  await persistRetry(() => persistTurnCheckpoint(ctx, pending));
  const decision = await persistRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      // Lock before counting so a duplicate catch cannot spend the budget twice.
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR UPDATE`;
      const prior = await tx.attempt.count({
        where: { runId: run.id, status: WORKER_RETRY_STATUS },
      });
      if (prior >= MAX_WORKER_TURN_RETRIES) return { exhausted: true } as const;
      const retryAt = new Date(Date.now() + 1_000 * 2 ** prior);
      const released = await tx.run.updateMany({
        where: { id: run.id, status: "running", leaseOwner: workerId, leaseFence: fence },
        data: {
          status: "queued",
          wakeAt: retryAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          error: null,
        },
      });
      if (released.count !== 1) return { lost: true } as const;
      await tx.attempt.update({
        where: { id: ctx.attempt.id },
        data: {
          status: WORKER_RETRY_STATUS,
          error: "Temporary turn failure; retrying",
          finishedAt: new Date(),
        },
      });
      return { retryAt };
    }),
  );
  if ("exhausted" in decision) return false;
  ctx.stopHeartbeatAfterCompletion();
  if ("retryAt" in decision) {
    await ctx.settleRunningHelpers();
    // A failed publish leaves a durable queued run for the reconciler.
    await deps.jobs
      .enqueue({ ...runContinueJob(run.id), availableAt: decision.retryAt })
      .catch((publishError) => getLogger().error("worker turn retry wake", publishError));
  }
  return true;
}
