import { describe, expect, it, vi } from "vitest";
import { releaseWorkerRunLeases, workerProcessId } from "./worker-shutdown.js";

describe("releaseWorkerRunLeases", () => {
  it("expires this worker's leases at once, clears the owner, and requeues the runs", async () => {
    const now = new Date("2026-10-23T15:00:00Z");
    const updateMany = vi.fn(async ({ where }: { where: { id: string } }) => ({
      count: where.id === "raced" ? 0 : 1,
    }));
    const findMany = vi.fn(async () => [
      { id: "r1", leaseFence: 3 },
      { id: "raced", leaseFence: 1 },
    ]);
    const enqueue = vi.fn(async () => undefined);
    const released = await releaseWorkerRunLeases(
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake prisma
      { prisma: { run: { findMany, updateMany } } as any, jobs: { enqueue } },
      "host:1:abc",
      now,
    );
    expect(released).toEqual(["r1"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { leaseOwner: "host:1:abc", status: { in: ["leased", "running"] } },
      }),
    );
    // Fenced on owner + fence so a run another worker already claimed is left alone.
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "r1",
        leaseOwner: "host:1:abc",
        leaseFence: 3,
        status: { in: ["leased", "running"] },
      },
      data: { leaseOwner: null, leaseExpiresAt: now },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "run.continue",
        payload: { runId: "r1" },
        keepExisting: true,
        replaceLockedBefore: now,
      }),
    );
  });

  it("does nothing when the worker holds no runs", async () => {
    const enqueue = vi.fn(async () => undefined);
    const released = await releaseWorkerRunLeases(
      {
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake prisma
        prisma: { run: { findMany: async () => [], updateMany: vi.fn() } } as any,
        jobs: { enqueue },
      },
      "w",
    );
    expect(released).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("workerProcessId", () => {
  it("tells apart processes that share a pid", () => {
    expect(workerProcessId("h", 1, "a")).not.toBe(workerProcessId("h", 1, "b"));
  });
});
