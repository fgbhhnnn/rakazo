import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUSPEND_CLAIM_STALE_MS } from "./computer-health.js";
import { sleepComputerIfIdle } from "./computer-idle.js";
import { settleStaleClaimWithProvider } from "./computer-stale-claim.js";

type ProviderAnswer = "paused" | "running" | "gone" | "error" | "hangs" | "unsupported";

/** The production row that prompted this: a stale claim, 27 failed checks, an open card. */
function staleClaimHarness(answer: ProviderAnswer, options: { claimChanged?: boolean } = {}) {
  const staleAt = new Date(Date.now() - SUSPEND_CLAIM_STALE_MS - 60_000);
  const computer = {
    id: "computer-id",
    homeKey: "team-home",
    providerRef: "izl0ucema1g3ro5v5jwmm",
    kind: "e2b",
    scope: "team",
    state: "suspending",
    spaceId: "space",
    userId: "owner",
    controlHolder: "none",
    controlLeaseId: null as string | null,
    controlLeaseExpiresAt: null as Date | null,
    controlBotId: null as string | null,
    controlRunId: null as string | null,
    runningSince: new Date(Date.now() - 17 * 60 * 60 * 1000) as Date | null,
    homeRevisionAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    updatedAt: staleAt,
  };
  const health: Record<string, unknown> = {
    computerId: computer.id,
    spaceId: computer.spaceId,
    checkedAt: new Date(),
    unresponsiveCount: 27,
    restartPromptedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
    restartMessageId: "restart-card",
    restartThreadId: "main-thread",
  };
  const prisma = {
    computer: {
      findUnique: vi.fn(async () => ({ ...computer })),
      updateMany: vi.fn(async (args: { where: { updatedAt?: Date }; data: object }) => {
        if (options.claimChanged) return { count: 0 };
        if (args.where.updatedAt && args.where.updatedAt.getTime() !== computer.updatedAt.getTime())
          return { count: 0 };
        Object.assign(computer, args.data);
        return { count: 1 };
      }),
    },
    computerHealth: {
      findUnique: vi.fn(async () => ({ ...health })),
      upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
        for (const [key, value] of Object.entries(update)) {
          const increment = (value as { increment?: number } | null)?.increment;
          health[key] = increment === undefined ? value : Number(health[key] ?? 0) + increment;
        }
        return { ...health };
      }),
    },
    computerRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    bot: { findMany: vi.fn().mockResolvedValue([{ id: "main", thread: { id: "main-thread" } }]) },
    // The restart card itself is covered against PostgreSQL; here it is already gone.
    $transaction: vi.fn(async () => null),
  };
  const isStopped = vi.fn(async () => {
    if (answer === "paused") return true;
    if (answer === "error") throw new Error("503: E2B API unavailable");
    if (answer === "hangs") return new Promise<boolean>(() => undefined);
    return false;
  });
  const sandbox = {
    ...(answer === "unsupported" ? {} : { isStopped }),
    execute: vi.fn(() => {
      throw new Error("a stale claim must not run anything on the computer");
    }),
    keepAlive: vi.fn(async () => {
      throw new Error("a stale claim must not wake the computer");
    }),
    exportWorkspace: vi.fn(() => {
      throw new Error("a stale claim must not save");
    }),
    stop: vi.fn(async () => undefined),
  };
  const jobs = { enqueue: vi.fn().mockResolvedValue(undefined), cancel: vi.fn(), close: vi.fn() };
  const events = {
    append: vi.fn().mockResolvedValue({}),
    notify: vi.fn().mockResolvedValue(undefined),
  };
  return {
    computer,
    health,
    prisma,
    sandbox,
    isStopped,
    jobs,
    events,
    deps: {
      prisma: prisma as unknown as PrismaClient,
      sandbox: sandbox as unknown as SandboxProvider,
      home: { commit: vi.fn() } as unknown as AgentHomeStore,
      jobs: jobs as unknown as JobPublisher,
      events: events as unknown as ThreadEvents,
    },
  };
}

describe("stale suspend claim settled with the provider", () => {
  let sink: ReturnType<typeof createTestSink>;
  beforeEach(() => {
    sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
  });

  it("marks a computer its provider already paused asleep and resets its health", async () => {
    const h = staleClaimHarness("paused");

    await sleepComputerIfIdle(h.deps, h.computer.id);

    expect(h.isStopped).toHaveBeenCalledOnce();
    expect(h.computer).toMatchObject({
      state: "suspended",
      runningSince: null,
      controlHolder: "none",
      controlLeaseId: null,
      controlBotId: null,
      providerRef: "izl0ucema1g3ro5v5jwmm",
    });
    // Not a failed check: the count resets and the restart card is let go.
    expect(h.health).toMatchObject({
      unresponsiveCount: 0,
      restartMessageId: null,
      restartThreadId: null,
    });
    expect(h.prisma.$transaction).toHaveBeenCalledOnce();
    expect(h.prisma.computerRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ endReason: "gone" }) }),
    );
    // Nothing woke, saved or stopped it, and no further idle check is queued for it.
    expect(h.sandbox.keepAlive).not.toHaveBeenCalled();
    expect(h.sandbox.execute).not.toHaveBeenCalled();
    expect(h.sandbox.exportWorkspace).not.toHaveBeenCalled();
    expect(h.sandbox.stop).not.toHaveBeenCalled();
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
    expect(h.events.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "computer.status", payload: { status: "suspended" } }),
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        message: "computer.suspend_claim_settled",
        reason: "provider_stopped",
      }),
    );
    expect(sink.events).not.toContainEqual(
      expect.objectContaining({ message: "computer.health_unresponsive" }),
    );
  });

  it("leaves the healed computer alone on the next idle check", async () => {
    const h = staleClaimHarness("paused");
    await sleepComputerIfIdle(h.deps, h.computer.id);
    h.isStopped.mockClear();

    await sleepComputerIfIdle(h.deps, h.computer.id);

    expect(h.computer.state).toBe("suspended");
    expect(h.health.unresponsiveCount).toBe(0);
    expect(h.isStopped).not.toHaveBeenCalled();
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["running", "the provider reports it running"],
    ["gone", "the provider no longer knows it"],
    ["error", "the provider check fails"],
    ["unsupported", "the provider has no status check"],
  ] as const)(
    "still takes it back and counts a failed check when %s (%s)",
    async (answer, _why) => {
      const h = staleClaimHarness(answer);

      await sleepComputerIfIdle(h.deps, h.computer.id);

      expect(h.computer.state).toBe("running");
      expect(h.computer.runningSince).not.toBeNull();
      expect(h.health.unresponsiveCount).toBe(28);
      expect(h.health.restartMessageId).toBe("restart-card");
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
      expect(h.jobs.enqueue).toHaveBeenCalledOnce();
      expect(sink.events).toContainEqual(
        expect.objectContaining({ message: "computer.suspend_claim_recovered" }),
      );
      expect(sink.events).toContainEqual(
        expect.objectContaining({
          message: "computer.health_unresponsive",
          reason: "stale_suspend_claim",
          count: 28,
        }),
      );
      if (answer === "error") {
        expect(sink.events).toContainEqual(
          expect.objectContaining({ message: "computer.stale_claim_probe_failed" }),
        );
      }
    },
  );

  it("gives up on a status check that does not answer and keeps the old recovery", async () => {
    const h = staleClaimHarness("hangs");

    await expect(
      settleStaleClaimWithProvider({ ...h.deps, probeMs: 20 }, h.computer),
    ).resolves.toBe("unconfirmed");
    expect(h.computer.state).toBe("suspending");
    expect(h.health.unresponsiveCount).toBe(27);
    expect(sink.events).toContainEqual(
      expect.objectContaining({ message: "computer.stale_claim_probe_failed" }),
    );
  });

  it("does nothing when someone else took the claim meanwhile", async () => {
    const h = staleClaimHarness("paused", { claimChanged: true });

    await sleepComputerIfIdle(h.deps, h.computer.id);

    expect(h.computer.state).toBe("suspending");
    expect(h.health.unresponsiveCount).toBe(27);
    expect(h.health.restartMessageId).toBe("restart-card");
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
    expect(h.events.append).not.toHaveBeenCalled();
  });

  it("does not ask the provider about a claim that may still be held", async () => {
    const h = staleClaimHarness("paused");
    h.computer.updatedAt = new Date(Date.now() - 60_000);

    await sleepComputerIfIdle(h.deps, h.computer.id);

    expect(h.isStopped).not.toHaveBeenCalled();
    expect(h.computer.state).toBe("suspending");
  });
});
