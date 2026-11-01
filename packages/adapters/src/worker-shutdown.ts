import { type JobPublisher, runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

/**
 * On graceful shutdown, hand this worker's live runs back at once instead of leaving them
 * leased for the full 5-minute lease. Clearing leaseOwner makes the old process's lease renewals
 * and owner-fenced writes fail, so it cannot keep driving the run once another worker claims it;
 * the expired lease lets continueRun claim it with a new fence. The continue job replaces this
 * process's locked job so the next worker resumes the run as soon as it starts.
 */
export async function releaseWorkerRunLeases(
  deps: { prisma: Pick<PrismaClient, "run">; jobs: Pick<JobPublisher, "enqueue"> },
  workerId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const held = await deps.prisma.run.findMany({
    where: { leaseOwner: workerId, status: { in: ["leased", "running"] } },
    select: { id: true, leaseFence: true },
  });
  const released: string[] = [];
  for (const run of held) {
    const result = await deps.prisma.run.updateMany({
      where: {
        id: run.id,
        leaseOwner: workerId,
        leaseFence: run.leaseFence,
        status: { in: ["leased", "running"] },
      },
      data: { leaseOwner: null, leaseExpiresAt: now },
    });
    if (result.count === 1) released.push(run.id);
  }
  await Promise.all(
    released.map((runId) =>
      deps.jobs.enqueue({ ...runContinueJob(runId), keepExisting: true, replaceLockedBefore: now }),
    ),
  );
  return released;
}

/** Unique per process: containers all run as pid 1, so the pid alone cannot tell workers apart. */
export function workerProcessId(hostname: string, pid: number, nonce: string): string {
  return `${hostname}:${pid}:${nonce}`;
}
