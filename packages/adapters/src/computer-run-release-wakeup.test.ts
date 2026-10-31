import { runContinueJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { wakeAfterComputerReleaseRace } from "./computer-run-release-wakeup.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { requeueComputerRun, startNextWaitingRun } from "./run-lifecycle.js";

function fixture() {
  let queued = false;
  let held = true;
  const row = {
    botId: "leader",
    bot: { computerId: "computer" as string | null },
    status: "running",
    leaseOwner: "worker" as string | null,
    wakeAt: null as Date | null,
  };
  const enqueue = vi.fn(async () => undefined);
  const findFirst = vi.fn(async () => (queued ? { id: "nudge" } : null));
  const findUnique = vi.fn(async (): Promise<typeof row | null> => row);
  const lease = vi.fn(async () => (held ? { id: "previous-lease" } : null));
  const updateMany = vi
    .fn()
    .mockResolvedValueOnce({ count: 0 }) // No takeover checkpoint to preserve.
    .mockImplementationOnce(async ({ data }) => {
      queued = true;
      if (row.status === "running") row.status = "queued";
      row.leaseOwner = null;
      row.wakeAt = data.wakeAt;
      return { count: 1 };
    });
  const deps = {
    prisma: {
      run: { findFirst, findUnique, updateMany },
      computerExecutionLease: { findFirst: lease },
    },
    jobs: { enqueue },
  } as unknown as ExecutorDeps;
  return {
    deps,
    enqueue,
    lease,
    row,
    findUnique,
    updateMany,
    release: () => {
      held = false;
    },
    cancel: () => {
      row.status = "cancelled";
    },
    requeue: (untilReleased = true) =>
      requeueComputerRun(deps, "nudge", "worker", 1, null, false, untilReleased),
  };
}

describe("computer release racing a waiting run's requeue", () => {
  it("wakes the run when release checked for waiting work before it became queued", async () => {
    const f = fixture();
    f.release();
    await startNextWaitingRun(f.deps, "leader", "previous");
    expect(f.enqueue).not.toHaveBeenCalled();

    await f.requeue();

    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("nudge"));
  });

  it("waits for the holder when requeue wins, then wakes through the release path", async () => {
    const f = fixture();
    await f.requeue();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.lease).toHaveBeenCalledWith({
      where: {
        computerId: "computer",
        botId: "leader",
        runId: { not: "nudge" },
        expiresAt: { gt: expect.any(Date) },
      },
      select: { id: true },
    });

    f.release();
    await startNextWaitingRun(f.deps, "leader", "previous");
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("nudge"));
  });

  it("does not wake a run cancelled during requeue", async () => {
    const f = fixture();
    f.release();
    f.cancel();
    await f.requeue();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it("keeps timed retries for a busy computer without a releasing run", async () => {
    const f = fixture();
    await f.requeue(false);
    expect(f.lease).not.toHaveBeenCalled();
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith({
      ...runContinueJob("nudge"),
      availableAt: expect.any(Date),
    });
  });

  it("does not wake a run when its lease fence no longer allows requeue", async () => {
    const f = fixture();
    f.updateMany.mockReset().mockResolvedValue({ count: 0 });
    f.release();
    await f.requeue();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.lease).not.toHaveBeenCalled();
  });

  it.each([
    { status: "running", leaseOwner: null, wakeAt: null },
    { status: "queued", leaseOwner: "new-worker", wakeAt: null },
    { status: "queued", leaseOwner: null, wakeAt: new Date("2030-01-01") },
  ])("leaves concurrent state changes alone: %o", async (state) => {
    const f = fixture();
    Object.assign(f.row, state);
    await wakeAfterComputerReleaseRace(f.deps, "nudge");
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.lease).not.toHaveBeenCalled();
  });

  it("does nothing if the run was deleted", async () => {
    const f = fixture();
    f.findUnique.mockResolvedValueOnce(null);
    await wakeAfterComputerReleaseRace(f.deps, "nudge");
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it("wakes a queued run if the bot no longer has a computer", async () => {
    const f = fixture();
    f.row.bot.computerId = null;
    await f.requeue();
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("nudge"));
    expect(f.lease).not.toHaveBeenCalled();
  });
});
