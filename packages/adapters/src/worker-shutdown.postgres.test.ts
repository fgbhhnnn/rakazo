import { randomUUID } from "node:crypto";
import type { BackgroundJobHandlers, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deferDispatcherWake } from "./dispatcher-turn-guard.js";
import { InMemoryRealtimeFanout } from "./realtime.js";
import { RunJobPublisher, RunWorkerHost } from "./run-wakeup.js";
import { releaseWorkerRunLeases } from "./worker-shutdown.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

// Our shutdown lease release and dispatcher wake deferral on top of the direct run dispatcher.
describePostgres("worker shutdown and wake deferral with direct dispatch (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `shutdown-${randomUUID()}@rakazo.test`;
  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    identity = await runAsSystem("worker shutdown fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
  });
  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  async function createRun(data: Record<string, unknown> = {}) {
    const { userId, spaceId, botId, threadId } = identity;
    const task = await system.task.create({
      data: { userId, spaceId, botId, threadId, prompt: "fixture", status: "queued" },
    });
    return system.run.create({
      data: {
        userId,
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        trigger: "user",
        status: "queued",
        ...data,
      },
    });
  }
  const scheduler = () =>
    ({ enqueue: vi.fn(), cancel: vi.fn(), close: vi.fn() }) as unknown as JobPublisher;
  const wait = (assertion: () => Promise<void> | void) =>
    vi.waitFor(assertion, { timeout: 5_000, interval: 20 });

  it("hands a stopping worker's run to another worker once, without requeueing it", async () => {
    const held = await createRun({
      status: "running",
      leaseOwner: "old-worker",
      leaseFence: 3,
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
    });
    const realtime = new InMemoryRealtimeFanout();
    const publisher = new RunJobPublisher(db.prisma, realtime, scheduler());
    const host = new RunWorkerHost(db.prisma, realtime, { intervalMs: 25 });
    const entered: string[] = [];
    const handlers = {
      "run.continue": async ({ runId }) => {
        if (runId !== held.id) return;
        entered.push(runId);
        await system.run.update({ where: { id: runId }, data: { status: "completed" } });
      },
    } as BackgroundJobHandlers;
    try {
      await host.start(handlers);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(entered).toEqual([]);
      const released = await runAsTenant(identity, () =>
        releaseWorkerRunLeases({ prisma: db.prisma, jobs: publisher }, "old-worker"),
      );
      expect(released).toEqual([held.id]);
      const row = await system.run.findUniqueOrThrow({ where: { id: held.id } });
      // Still running (no requeue, so the legacy retry trigger stays out of it), owner cleared.
      expect(row.status === "running" || row.status === "completed").toBe(true);
      await wait(() => expect(entered).toEqual([held.id]));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(entered).toEqual([held.id]);
    } finally {
      await host.stop();
    }
  });

  it("defers a dispatcher wake behind a live turn without the dispatcher picking it early", async () => {
    const live = await createRun({
      status: "running",
      leaseOwner: "w",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const wakeRun = await createRun({ trigger: "bot_message" });
    const realtime = new InMemoryRealtimeFanout();
    const publisher = new RunJobPublisher(db.prisma, realtime, scheduler());
    const deferred = await runAsTenant(identity, () =>
      deferDispatcherWake({ prisma: db.prisma, jobs: publisher }, wakeRun),
    );
    expect(deferred).toBe(true);
    const row = await system.run.findUniqueOrThrow({ where: { id: wakeRun.id } });
    expect(row.status).toBe("queued");
    expect(row.wakeAt!.getTime()).toBeGreaterThan(Date.now());
    await system.run.update({ where: { id: live.id }, data: { status: "completed" } });
    await system.run.update({ where: { id: wakeRun.id }, data: { status: "completed" } });
  });
});
