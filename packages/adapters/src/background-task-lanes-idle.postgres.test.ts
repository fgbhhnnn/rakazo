import { randomUUID } from "node:crypto";
import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { createDb, createThreadEvents, runAsSystem, runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { laneComputer } from "./background-task-lanes.js";
import { BACKGROUND_WORK_PROBE, sleepComputerIfIdle } from "./computer-idle.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;
const system = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);

/** A running computer, its dispatcher, one computer-lane worker (:1) and one think worker (:101). */
async function withFixture(
  run: (fx: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
): Promise<void> {
  const { prisma, pool } = createDb(process.env.DATABASE_URL!);
  const id = `lane-${randomUUID()}`;
  try {
    await run(await fixture(prisma, id));
  } finally {
    await system(async () => {
      await prisma.bot.deleteMany({ where: { spaceId: `${id}-space` } });
      await prisma.thread.deleteMany({ where: { spaceId: `${id}-space` } });
      await prisma.computer.deleteMany({ where: { spaceId: `${id}-space` } });
      await prisma.space.deleteMany({ where: { id: `${id}-space` } });
      await prisma.organization.deleteMany({ where: { id: `${id}-org` } });
      await prisma.user.deleteMany({ where: { id: `${id}-user` } });
    }).catch(() => undefined);
    await pool.end();
  }
}

async function fixture(prisma: ReturnType<typeof createDb>["prisma"], id: string) {
  const userId = `${id}-user`;
  const spaceId = `${id}-space`;
  const rows = await system(async () => {
    await prisma.user.create({ data: { id: userId, name: "Owner", email: `${id}@rakazo.test` } });
    await prisma.organization.create({
      data: { id: `${id}-org`, name: "Lanes", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId: `${id}-org`, name: "L" } });
    const computer = await prisma.computer.create({
      data: {
        spaceId,
        userId,
        scope: "dedicated",
        scopeKey: `${id}-scope`,
        homeKey: `${id}-home`,
        kind: "e2b",
        providerRef: "sbx-1",
        state: "running",
        runningSince: new Date(),
      },
    });
    const main = await prisma.bot.create({
      data: { spaceId, userId, name: "main", color: "ink", computerId: computer.id },
    });
    const worker = (slot: number, lane: "computer" | "think") =>
      prisma.bot.create({
        data: {
          spaceId,
          userId,
          name: `main · 后台${slot}`,
          color: "ink",
          parentBotId: main.id,
          spawnKey: `bg-worker:${main.id}:${slot}`,
          // Exactly what startOnSlot writes for each lane.
          ...laneComputer(lane, computer.id),
        },
      });
    const computerWorker = await worker(1, "computer");
    const thinkWorker = await worker(101, "think");
    return { computer, main, computerWorker, thinkWorker };
  });
  const startRun = (botId: string) =>
    system(async () => {
      const thread = await prisma.thread.upsert({
        where: { botId },
        create: { spaceId, userId, botId },
        update: {},
      });
      const task = await prisma.task.create({
        data: { spaceId, botId, threadId: thread.id, userId, prompt: "work", status: "running" },
      });
      return prisma.run.create({
        data: {
          spaceId,
          botId,
          threadId: thread.id,
          taskId: task.id,
          userId,
          status: "running",
          trigger: "bot_message",
          startedAt: new Date(),
        },
      });
    });
  const sandbox = {
    execute: vi.fn(async function* (_ref: unknown, request: { argv: string[] }) {
      if (request.argv.includes(BACKGROUND_WORK_PROBE)) {
        yield { type: "stdout", data: "rakazo-background-idle\n" } as const;
        yield { type: "exit", code: 1 } as const;
        return;
      }
      yield { type: "stdout", data: "disk 40 50000000\nmem 1000000 800000\n" } as const;
      yield { type: "exit", code: 0 } as const;
    }),
    keepAlive: vi.fn(async () => undefined),
    exportWorkspace: vi.fn(async function* () {
      yield { path: "notes.txt", content: new TextEncoder().encode("saved") };
    }),
    stop: vi.fn(async () => undefined),
  };
  const deps = {
    prisma,
    sandbox: sandbox as unknown as SandboxProvider,
    home: { commit: vi.fn(async () => `rev-${randomUUID()}`) } as unknown as AgentHomeStore,
    jobs: {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(),
      close: vi.fn(),
    } as never as JobPublisher,
    events: createThreadEvents(prisma, { publish: vi.fn(async () => undefined) } as never),
    deadlines: { checkpointMs: 30 },
  };
  const sleep = () =>
    runAsTenant({ spaceId, userId }, () => sleepComputerIfIdle(deps, rows.computer.id));
  const state = async () =>
    (await system(() => prisma.computer.findUniqueOrThrow({ where: { id: rows.computer.id } })))
      .state;
  return { ...rows, sandbox, startRun, sleep, state };
}

postgres("background task lanes and computer idle (PostgreSQL)", () => {
  it("lets the computer sleep while only think workers are running", async () => {
    await withFixture(async (fx) => {
      expect(fx.thinkWorker.computerId).toBeNull();
      await fx.startRun(fx.thinkWorker.id);
      await fx.startRun(fx.thinkWorker.id);
      await fx.sleep();
      expect(fx.sandbox.keepAlive).not.toHaveBeenCalled();
      expect(await fx.state()).toBe("suspended");
    });
  });

  it("keeps the computer awake while a computer-lane worker runs", async () => {
    await withFixture(async (fx) => {
      expect(fx.computerWorker.computerId).toBe(fx.computer.id);
      await fx.startRun(fx.thinkWorker.id);
      await fx.startRun(fx.computerWorker.id);
      await fx.sleep();
      expect(fx.sandbox.keepAlive).toHaveBeenCalled();
      expect(await fx.state()).toBe("running");
    });
  });
});
