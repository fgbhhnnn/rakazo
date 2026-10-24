import type { SandboxProvider } from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  clearRunTurnCheckpoints,
  expireComputerExecutionLeases,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { cancelComputerRunWork } from "./computer-idle.js";
import { screenLeaseIdForRun, toComputerRef } from "./computer-lifecycle.js";

/**
 * Stops every active run in a thread: flips them to cancelled with run.cancelled events,
 * drops queued steering, kills the runs' shell work on their computers
 * (CANCEL_COMPUTER_RUN_WORK), releases screens and leases. Executors watching the run see
 * the cancelled status and abort their model call and tools. Shared by the Stop button
 * and background_task_cancel.
 */
export async function stopThreadRunsForBots(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    events: ThreadEvents;
  },
  actor: { spaceId: string; userId: string },
  target: { threadId: string; botIds: readonly string[] },
): Promise<{ runIds: string[] }> {
  const { runIds, computers, leases, eventSeq } = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const cancelled = await tx.run.updateManyAndReturn({
      where: {
        threadId: target.threadId,
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      data: { status: "cancelled", completedAt: new Date() },
      select: { id: true, botId: true },
    });
    const ids = cancelled.map((run) => run.id);
    await clearRunTurnCheckpoints(tx, ids);
    await tx.steeringMessage.deleteMany({
      where: {
        botId: { in: [...target.botIds] },
        message: { threadId: target.threadId },
      },
    });
    // Snapshot teardown coordinates before commit. Once cancellation becomes
    // visible, a worker can release its lease / execution columns immediately; a
    // later lookup would then miss the sandbox work this request must stop.
    // Team ownership lives on ComputerExecutionLease; Computer.executionRunId is
    // only a legacy secondary path and is not written by current acquisition.
    const leases = ids.length
      ? await tx.computerExecutionLease.findMany({
          where: { runId: { in: ids } },
          select: { computerId: true, botId: true, runId: true, fence: true },
        })
      : [];
    const leaseComputerIds = [...new Set(leases.map((lease) => lease.computerId))];
    const computers = ids.length
      ? await tx.computer.findMany({
          where:
            leaseComputerIds.length > 0
              ? {
                  OR: [{ id: { in: leaseComputerIds } }, { executionRunId: { in: ids } }],
                }
              : { executionRunId: { in: ids } },
          select: {
            id: true,
            homeKey: true,
            kind: true,
            providerRef: true,
            executionBotId: true,
            executionRunId: true,
          },
        })
      : [];
    // One terminal event per cancelled run, in the same commit as the status
    // flip and the progress purge below. Other clients learn the run ended, and
    // the fresh seq keeps max(seq) above every deleted progress row so a client
    // whose cursor pointed at one never discards later refreshes as stale.
    let eventSeq: number | null = null;
    for (const run of cancelled) {
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId: run.botId,
        type: "run.cancelled",
        runId: run.id,
        payload: {},
      });
      eventSeq = event.seq;
    }
    if (ids.length) {
      await tx.event.deleteMany({
        where: {
          type: "thread.progress",
          runId: { in: ids },
        },
      });
    }
    return { runIds: ids, computers, leases, eventSeq };
  });
  if (eventSeq !== null) {
    // The events are durable; subscribers refetch from their persisted cursor.
    await deps.events.notify(target.threadId, eventSeq).catch((error) => {
      getLogger().error("thread stop realtime notification", error);
    });
  }
  // Keep the DB lease until after teardown so a replacement run cannot claim the
  // screen while we still need the cancelled run's screenLeaseId to release it.
  const computerById = new Map(computers.map((computer) => [computer.id, computer]));
  const teardownTargets: Array<{
    computer: (typeof computers)[number];
    botId: string;
    runId: string;
    lease: (typeof leases)[number] | null;
  }> = [];
  const seenTargets = new Set<string>();
  for (const lease of leases) {
    const computer = computerById.get(lease.computerId);
    if (!computer) continue;
    const key = `${computer.id}:${lease.runId}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    teardownTargets.push({
      computer,
      botId: lease.botId,
      runId: lease.runId,
      lease,
    });
  }
  const cancelledRunIds = new Set(runIds);
  for (const computer of computers) {
    if (!computer.executionBotId || !computer.executionRunId) continue;
    // Computers may enter the snapshot via a cancelled lease while
    // Computer.executionRunId still points at an unrelated live run. Only treat
    // the legacy columns as a teardown target when they belong to a run we
    // cancelled in this transaction.
    if (!cancelledRunIds.has(computer.executionRunId)) continue;
    const key = `${computer.id}:${computer.executionRunId}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    teardownTargets.push({
      computer,
      botId: computer.executionBotId,
      runId: computer.executionRunId,
      lease: null,
    });
  }
  await Promise.all(
    teardownTargets.map(async ({ computer, botId, runId, lease }) => {
      if (!computer.providerRef) return;
      const context = {
        operationId: "stop",
        traceId: "stop",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        runId,
        screenLeaseId: screenLeaseIdForRun(lease, runId),
        cancelRunWork: true,
        signal: new AbortController().signal,
      };
      const ref = toComputerRef(computer);
      await cancelComputerRunWork(deps.sandbox, ref, computer.id, runId, context);
      await deps.sandbox.releaseScreen?.(ref, context).catch(() => undefined);
    }),
  );
  await expireComputerExecutionLeases(deps.prisma, { runId: { in: runIds } });
  await deps.prisma.computer.updateMany({
    where: { executionRunId: { in: runIds } },
    data: {
      executionRunId: null,
      executionBotId: null,
      executionLeaseExpiresAt: null,
    },
  });
  return { runIds };
}
