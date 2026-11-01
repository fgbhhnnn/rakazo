import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RunContextModule from "./run-context.js";
import type { RunContext } from "./run-context.js";
import { failRun } from "./run-turn.js";
import { MAX_WORKER_TURN_RETRIES, retryTransientWorkerTurn } from "./worker-turn-retry.js";

const persistCheckpoint = vi.hoisted(() => vi.fn());
vi.mock("./run-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RunContextModule>()),
  persistTurnCheckpoint: persistCheckpoint,
}));

function harness(name = "调研", spawnKey: string | null = "bg-worker:lead:think:1") {
  let retries = 0;
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run: { updateMany },
    attempt: {
      count: vi.fn(async () => retries),
      update: vi.fn(async () => {
        retries += 1;
      }),
    },
  };
  const ctx = {
    deps: {
      prisma: { $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    },
    run: { id: "run" },
    bot: { name, spawnKey },
    workerId: "worker",
    fence: 2,
    attempt: { id: "attempt" },
    state: { effects: { pendingTurnCheckpoints: new Map() } },
    computer: { lazy: { throwIfFailed: vi.fn() }, checkpoint: { flush: vi.fn() } },
    stopHeartbeatAfterCompletion: vi.fn(),
    settleRunningHelpers: vi.fn(async () => undefined),
  };
  return { ctx: ctx as unknown as RunContext, tx };
}

describe("transient worker turns", () => {
  beforeEach(() => {
    persistCheckpoint.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("saves the pending turn before releasing its lease, retrying a busy database", async () => {
    vi.useFakeTimers();
    const { ctx } = harness();
    ctx.state.effects.pendingTurnCheckpoints.set("tool", () => "checkpoint");
    persistCheckpoint.mockRejectedValueOnce({ code: "P2024" });
    vi.mocked(ctx.deps.prisma.$transaction).mockRejectedValueOnce({ code: "P2028" });
    const retry = retryTransientWorkerTurn(ctx, { code: "P2028" });
    await vi.runAllTimersAsync();
    expect(await retry).toBe(true);
    expect(persistCheckpoint).toHaveBeenNthCalledWith(1, ctx, "tool");
    expect(persistCheckpoint).toHaveBeenNthCalledWith(2, ctx, "tool");
    expect(ctx.deps.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(ctx.deps.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("clears an earlier saved turn when no tool is pending, before retrying the model", async () => {
    const { ctx } = harness();
    ctx.state.effects.storedTurnCheckpoint = true;
    expect(await retryTransientWorkerTurn(ctx, new Error("Model stream idle timeout"))).toBe(true);
    expect(persistCheckpoint).toHaveBeenCalledWith(ctx, undefined);
    expect(persistCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ctx.deps.prisma.$transaction).mock.invocationCallOrder[0]!,
    );
  });

  it("bounds retry bookkeeping failures and never queues an unsaved turn", async () => {
    vi.useFakeTimers();
    const { ctx } = harness();
    persistCheckpoint.mockRejectedValue({ code: "P2024" });
    const retry = retryTransientWorkerTurn(ctx, { code: "P2028" });
    const rejected = expect(retry).rejects.toMatchObject({ code: "P2024" });
    await vi.runAllTimersAsync();
    await rejected;
    expect(persistCheckpoint).toHaveBeenCalledTimes(3);
    expect(ctx.deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(ctx.deps.jobs.enqueue).not.toHaveBeenCalled();
  });
  it.each(["调研", "运营"])(
    "recovers %s through failRun without finalizing or checkpointing the computer",
    async (name) => {
      const { ctx } = harness(name);
      await failRun(
        ctx,
        { code: "P2028" },
        { ownCredential: false, active: { "model.provider": "test", "model.id": "test" } },
      );
      expect(ctx.deps.jobs.enqueue).toHaveBeenCalledOnce();
      expect(ctx.computer.checkpoint.flush).not.toHaveBeenCalled();
    },
  );
  it.each(["调研", "运营"])(
    "retries %s on the same run with bounded exponential backoff",
    async (name) => {
      const { ctx, tx } = harness(name);
      for (let index = 0; index < MAX_WORKER_TURN_RETRIES; index++) {
        const before = Date.now();
        expect(await retryTransientWorkerTurn(ctx, { code: "P2028" })).toBe(true);
        const job = vi.mocked(ctx.deps.jobs.enqueue).mock.calls[index]![0];
        expect(job).toMatchObject({ payload: { runId: "run" } });
        expect(job.availableAt!.getTime() - before).toBeGreaterThanOrEqual(1_000 * 2 ** index);
        expect(job.availableAt!.getTime() - Date.now()).toBeLessThanOrEqual(1_000 * 2 ** index);
      }
      expect(await retryTransientWorkerTurn(ctx, { code: "P2024" })).toBe(false);
      expect(ctx.deps.jobs.enqueue).toHaveBeenCalledTimes(3);
      expect(tx.run.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "run", status: "running", leaseOwner: "worker", leaseFence: 2 },
          data: expect.objectContaining({ status: "queued", error: null, leaseOwner: null }),
        }),
      );
    },
  );
  it("does not requeue a terminal run or a run owned by another worker", async () => {
    const { ctx, tx } = harness();
    tx.run.updateMany.mockResolvedValue({ count: 0 });
    expect(await retryTransientWorkerTurn(ctx, { code: "P2028" })).toBe(true);
    expect(ctx.deps.jobs.enqueue).not.toHaveBeenCalled();
    expect(tx.attempt.update).not.toHaveBeenCalled();
  });
  it("leaves a retry recoverable when publishing the wake fails", async () => {
    const { ctx, tx } = harness();
    vi.mocked(ctx.deps.jobs.enqueue).mockRejectedValue(new Error("offline"));
    expect(await retryTransientWorkerTurn(ctx, new Error("Model stream idle timeout"))).toBe(true);
    expect(tx.run.updateMany).toHaveBeenCalled();
  });
  it("leaves permanent failures and ordinary bots on their existing path", async () => {
    const worker = harness();
    expect(await retryTransientWorkerTurn(worker.ctx, { code: "P2002" })).toBe(false);
    const main = harness("运营", null);
    expect(await retryTransientWorkerTurn(main.ctx, { code: "P2028" })).toBe(false);
    expect(main.ctx.deps.prisma.$transaction).not.toHaveBeenCalled();
  });
});
