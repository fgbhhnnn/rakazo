import { describe, expect, it, vi } from "vitest";
import { deferDispatcherWake, earlierDispatcherTurnAlive } from "./dispatcher-turn-guard.js";

const now = new Date("2026-10-24T12:00:00Z");
const run = { id: "r2", botId: "b", threadId: "t", createdAt: new Date(now.getTime() - 1_000) };

describe("dispatcher wake ordering", () => {
  it("waits behind any earlier turn of the same bot and chat while the wake is young", async () => {
    const findFirst = vi.fn(async () => ({ id: "r1" }));
    const alive = await earlierDispatcherTurnAlive({ run: { findFirst } } as never, run, {
      now,
      patientMs: 90_000,
    });
    expect(alive).toBe(true);
    const where = (findFirst.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0]
      .where as { OR: unknown[] };
    expect(where).toMatchObject({ id: { not: "r2" }, botId: "b", threadId: "t" });
    expect(where.OR).toContainEqual({ status: { in: ["leased", "running"] } });
    expect(where.OR).toContainEqual({
      status: "queued",
      trigger: "bot_message",
      createdAt: { lt: run.createdAt },
    });
  });

  it("after the bound only a live lease blocks, so a dead turn never blocks a wake", async () => {
    const findFirst = vi.fn(async () => null);
    await earlierDispatcherTurnAlive({ run: { findFirst } } as never, run, { now, patientMs: 0 });
    const where = (findFirst.mock.calls[0] as unknown as [{ where: { OR: unknown[] } }])[0].where;
    expect(where.OR).toContainEqual({
      status: { in: ["leased", "running"] },
      leaseExpiresAt: { gt: now },
    });
  });

  it("re-queues a blocked wake instead of holding the dispatch slot", async () => {
    const enqueue = vi.fn(async () => undefined);
    const deferred = await deferDispatcherWake(
      {
        prisma: { run: { findFirst: vi.fn(async () => ({ id: "r1" })) } } as never,
        jobs: { enqueue } as never,
      },
      run,
    );
    expect(deferred).toBe(true);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", availableAt: expect.any(Date) }),
    );
  });

  it("lets the wake run when nothing earlier is alive", async () => {
    const enqueue = vi.fn(async () => undefined);
    const deferred = await deferDispatcherWake(
      {
        prisma: { run: { findFirst: vi.fn(async () => null) } } as never,
        jobs: { enqueue } as never,
      },
      run,
    );
    expect(deferred).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
