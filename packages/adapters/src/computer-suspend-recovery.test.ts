import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUSPEND_CLAIM_STALE_MS } from "./computer-health.js";
import { ComputerBusyError, provisionComputer } from "./computer-lifecycle.js";
import { STALE_CLAIM_PROBE_DEADLINE_MS } from "./computer-stale-claim.js";
import { settleStoppedSuspendBeforeProvision } from "./computer-suspend-recovery.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

function fixture() {
  const row = {
    id: "computer",
    homeKey: "shared-home",
    spaceId: "space",
    userId: "owner",
    kind: "fake",
    scope: "team",
    state: "suspending",
    providerRef: "fake-shared-home" as string | null,
    maintenanceId: null as string | null,
    runningSince: new Date(Date.now() - 2 * SUSPEND_CLAIM_STALE_MS) as Date | null,
    updatedAt: new Date(Date.now() - SUSPEND_CLAIM_STALE_MS - 1_000),
    restorePending: false,
    screenGeneration: 1,
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    controlRunId: null,
  };
  const updateMany = vi.fn(async ({ where, data }) => {
    if (
      Object.entries(where).some(([key, value]) => {
        if (!(key in row)) return false;
        const current = row[key as keyof typeof row];
        return current instanceof Date && value instanceof Date
          ? current.getTime() !== value.getTime()
          : current !== value;
      })
    )
      return { count: 0 };
    // Both waiters have live execution leases: neither may steal a lifecycle claim
    // through heldByNobodyElse. A suspended -> booting CAS still has a single winner.
    if (where.executionLeases?.none) return { count: 0 };
    Object.assign(row, { updatedAt: new Date(row.updatedAt.getTime() + 1) }, data);
    return { count: 1 };
  });
  const findUniqueOrThrow = vi.fn(async () => ({ ...row }));
  const findRun = vi.fn(async () => ({ id: "other-live-waiter" }));
  const isStopped = vi.fn(async () => true);
  const deps = {
    prisma: {
      computer: { findUniqueOrThrow, updateMany },
      run: { findFirst: findRun },
      computerHealth: { findUnique: vi.fn(async () => null) },
      computerRun: {
        createMany: vi.fn(async () => ({ count: 1 })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      botDeletion: { findMany: vi.fn(async () => []) },
      $executeRaw: vi.fn(async () => 1),
    } as unknown as PrismaClient,
    sandbox: { isStopped } as unknown as SandboxProvider,
    events: { notify: vi.fn(async () => undefined) } as unknown as ThreadEvents,
  };
  return { deps, row, isStopped, updateMany, findUniqueOrThrow, findRun };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("provider-confirmed suspend recovery before provisioning", () => {
  it("settles an expired claim despite live waiting runs, keeping the provider disk reference", async () => {
    const f = fixture();
    const stamp = f.row.updatedAt;

    await expect(settleStoppedSuspendBeforeProvision(f.deps, { ...f.row })).resolves.toBe(true);

    expect(f.row).toMatchObject({
      state: "suspended",
      providerRef: "fake-shared-home",
      runningSince: null,
    });
    expect(f.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: "computer",
        state: "suspending",
        providerRef: "fake-shared-home",
        updatedAt: stamp,
      },
      data: expect.objectContaining({ state: "suspended" }),
    });
    expect(f.findRun).not.toHaveBeenCalled();
    expect(f.deps.prisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it.each([
    { state: "running" },
    { state: "booting" },
    { state: "quarantined" },
    { kind: "desktop" },
    { maintenanceId: "maintenance" },
    { providerRef: null },
    { updatedAt: new Date() },
    { updatedAt: undefined },
    { updatedAt: new Date("invalid") },
  ])("leaves a protected or inapplicable claim alone: %o", async (change) => {
    const f = fixture();
    Object.assign(f.row, change);

    await expect(settleStoppedSuspendBeforeProvision(f.deps, f.row)).resolves.toBe(false);

    expect(f.isStopped).not.toHaveBeenCalled();
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it("waits for the full suspend deadline, including at its boundary", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.row.updatedAt = new Date(Date.now() - SUSPEND_CLAIM_STALE_MS + 1);
    await expect(settleStoppedSuspendBeforeProvision(f.deps, f.row)).resolves.toBe(false);
    expect(f.isStopped).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    await expect(settleStoppedSuspendBeforeProvision(f.deps, f.row)).resolves.toBe(true);
    expect(f.isStopped).toHaveBeenCalledOnce();
  });

  it.each(["running-or-gone", "unsupported", "failed"])(
    "requires provider proof that the disk is stopped: %s",
    async (answer) => {
      const f = fixture();
      if (answer === "unsupported") delete f.deps.sandbox.isStopped;
      else if (answer === "failed") f.isStopped.mockRejectedValue(new Error("status unavailable"));
      else f.isStopped.mockResolvedValue(false);

      await expect(settleStoppedSuspendBeforeProvision(f.deps, f.row)).resolves.toBe(false);

      expect(f.row.state).toBe("suspending");
      expect(f.updateMany).not.toHaveBeenCalled();
    },
  );

  it("bounds a status probe that never answers", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.isStopped.mockImplementation(() => new Promise(() => undefined));
    const recovery = settleStoppedSuspendBeforeProvision(f.deps, f.row);

    await vi.advanceTimersByTimeAsync(STALE_CLAIM_PROBE_DEADLINE_MS);

    await expect(recovery).resolves.toBe(false);
    expect(f.row.state).toBe("suspending");
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it.each(["stamp", "state", "provider"])(
    "requests a reload without overwriting a concurrent change to the %s",
    async (change) => {
      const f = fixture();
      const observed = { ...f.row };
      f.isStopped.mockImplementation(async () => {
        if (change === "stamp") f.row.updatedAt = new Date();
        if (change === "state") f.row.state = "booting";
        if (change === "provider") f.row.providerRef = "replacement";
        return true;
      });

      await expect(settleStoppedSuspendBeforeProvision(f.deps, observed)).resolves.toBe(true);

      expect(f.row.state).toBe(change === "state" ? "booting" : "suspending");
      expect(f.deps.prisma.$executeRaw).not.toHaveBeenCalled();
    },
  );

  it("rechecks maintenance after a concurrent recovery supersedes the observed claim", async () => {
    const f = fixture();
    f.isStopped.mockImplementation(async () => {
      f.row.maintenanceId = "maintenance";
      f.row.updatedAt = new Date();
      return true;
    });

    await expect(
      provisionComputer(
        { ...f.deps, home: {} as AgentHomeStore, jobs: {} as JobPublisher },
        f.row.id,
        {
          operationId: "test",
          traceId: "test",
          spaceId: "space",
          userId: "owner",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);

    expect(f.findUniqueOrThrow).toHaveBeenCalledTimes(2);
    expect(f.row.state).toBe("suspending");
    expect(f.deps.prisma.$executeRaw).not.toHaveBeenCalled();
  });
});

describe("waiting runs on an abandoned suspend", () => {
  it("lets one of two live waiters resume the paused computer and the other reuse it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-suspend-waiters-"));
    const f = fixture();
    const sandbox = new FakeSandboxProvider();
    const home = new LocalAgentHomeStore(root);
    const context: AdapterContext = {
      operationId: "test",
      traceId: "test",
      spaceId: "space",
      userId: "owner",
      botId: "bot-a",
      runId: "run-a",
      screenLeaseId: "run-a:1",
      signal: new AbortController().signal,
    };
    const second = { ...context, botId: "bot-b", runId: "run-b", screenLeaseId: "run-b:1" };
    const deps = {
      ...f.deps,
      sandbox: Object.assign(sandbox, { isStopped: f.isStopped }),
      home,
      jobs: {} as JobPublisher,
      dataDir: root,
    };
    try {
      const ref = await sandbox.provision({ botId: f.row.homeKey, homePath: root }, context);
      await sandbox.writeFile(
        ref,
        { path: "work.txt", content: new TextEncoder().encode("kept") },
        context,
      );
      await sandbox.stop(ref, context);
      const provision = vi.spyOn(sandbox, "provision");

      // Without provider confirmation both provisioners see the other live run and fail.
      f.isStopped.mockResolvedValue(false);
      const setTimeoutReal = globalThis.setTimeout;
      vi.stubGlobal("setTimeout", ((fn: () => void) => setTimeoutReal(fn, 0)) as typeof setTimeout);
      const blocked = await Promise.allSettled([
        provisionComputer(deps, f.row.id, context),
        provisionComputer(deps, f.row.id, second),
      ]);
      vi.unstubAllGlobals();
      expect(blocked).toEqual([
        { status: "rejected", reason: expect.any(ComputerBusyError) },
        { status: "rejected", reason: expect.any(ComputerBusyError) },
      ]);
      expect(f.findRun).toHaveBeenCalledTimes(2);
      expect(provision).not.toHaveBeenCalled();
      expect(f.row.state).toBe("suspending");

      f.isStopped.mockResolvedValue(true);
      const resumed = await Promise.allSettled([
        provisionComputer(deps, f.row.id, context),
        provisionComputer(deps, f.row.id, second),
      ]);

      expect(resumed.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(resumed.filter((result) => result.status === "rejected")).toEqual([
        { status: "rejected", reason: expect.any(ComputerBusyError) },
      ]);
      expect(provision).toHaveBeenCalledOnce();
      expect(f.row.state).toBe("running");
      const loser = resumed[0]?.status === "rejected" ? context : second;
      await expect(provisionComputer(deps, f.row.id, loser)).resolves.toMatchObject({
        providerRef: ref.providerRef,
      });
      expect(provision).toHaveBeenCalledOnce();
      expect(sandbox.boxes.get(ref.id)?.files.get("work.txt")?.content).toEqual(
        new TextEncoder().encode("kept"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
