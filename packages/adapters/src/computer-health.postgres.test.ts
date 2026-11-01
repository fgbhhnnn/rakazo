import { randomUUID } from "node:crypto";
import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { createDb, createThreadEvents, runAsSystem, runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { RESOURCE_CHECK_INTERVAL_MS, RESTART_PROMPT_AFTER } from "./computer-health.js";
import { BACKGROUND_WORK_PROBE, sleepComputerIfIdle } from "./computer-idle.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;
const system = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);

async function withFixture(run: (fx: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const { prisma, pool } = createDb(process.env.DATABASE_URL!);
  const id = `ch-${randomUUID()}`;
  try {
    await run(await fixture(prisma, id));
  } finally {
    await system(async () => {
      await prisma.bot.deleteMany({ where: { spaceId: `${id}-space` } });
      await prisma.thread.deleteMany({ where: { spaceId: `${id}-space` } });
      await prisma.computer.deleteMany({ where: { spaceId: `${id}-space` } });
      await prisma.actionAutoReviewPreference.deleteMany({ where: { spaceId: `${id}-space` } });
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
      data: { id: `${id}-org`, name: "CH", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId: `${id}-org`, name: "CH" } });
    // The owner turned approvals off entirely; the restart card must still ask.
    await prisma.actionAutoReviewPreference.create({
      data: { spaceId, userId, enabled: true, skipApprovals: true },
    });
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
        homeRevisionAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    const main = await prisma.bot.create({
      data: { spaceId, userId, name: "main", color: "ink", computerId: computer.id },
    });
    const worker = await prisma.bot.create({
      data: {
        spaceId,
        userId,
        name: "main · 后台1",
        color: "ink",
        parentBotId: main.id,
        spawnKey: `bg-worker:${main.id}:1`,
        computerId: computer.id,
      },
    });
    const mainThread = await prisma.thread.create({ data: { spaceId, userId, botId: main.id } });
    const workerThread = await prisma.thread.create({
      data: { spaceId, userId, botId: worker.id },
    });
    return { computer, main, worker, mainThread, workerThread };
  });
  const sandboxState = {
    exportHangs: true,
    backgroundActive: false,
    resourceOutput: "disk 40 50000000\nmem 1000000 800000\n",
  };
  const sandbox = {
    execute: vi.fn(async function* (_ref: unknown, request: { argv: string[] }) {
      if (request.argv.includes(BACKGROUND_WORK_PROBE)) {
        if (!sandboxState.backgroundActive)
          yield { type: "stdout", data: "rakazo-background-idle\n" } as const;
        yield { type: "exit", code: sandboxState.backgroundActive ? 0 : 1 } as const;
        return;
      }
      yield { type: "stdout", data: sandboxState.resourceOutput } as const;
      yield { type: "exit", code: 0 } as const;
    }),
    keepAlive: vi.fn(async () => undefined),
    exportWorkspace: vi.fn(async function* () {
      if (sandboxState.exportHangs) await new Promise(() => undefined);
      yield { path: "notes.txt", content: new TextEncoder().encode("saved") };
    }),
    stop: vi.fn(async () => undefined),
  };
  const home = { commit: vi.fn(async () => `rev-${randomUUID()}`) };
  const jobs = { enqueue: vi.fn(async () => undefined), cancel: vi.fn(), close: vi.fn() };
  const events = createThreadEvents(prisma, { publish: vi.fn(async () => undefined) } as never);
  const deps = {
    prisma,
    sandbox: sandbox as unknown as SandboxProvider,
    home: home as unknown as AgentHomeStore,
    jobs: jobs as unknown as JobPublisher,
    events,
    deadlines: { checkpointMs: 30 },
  };
  const tenant = { spaceId, userId };
  const sleep = () => runAsTenant(tenant, () => sleepComputerIfIdle(deps, rows.computer.id));
  const messages = (threadId: string) =>
    system(() => prisma.message.findMany({ where: { threadId }, orderBy: { seq: "asc" } }));
  const health = () =>
    system(() => prisma.computerHealth.findUnique({ where: { computerId: rows.computer.id } }));
  const computerRow = () =>
    system(() => prisma.computer.findUniqueOrThrow({ where: { id: rows.computer.id } }));
  return { ...rows, prisma, sandbox, sandboxState, home, sleep, messages, health, computerRow };
}

const asks = (rows: { blocks: unknown }[]) =>
  rows.flatMap((row) =>
    (row.blocks as MessageBlock[]).filter((b): b is AskBlock => b.kind === "ask"),
  );
const metas = (rows: { blocks: unknown; role: string }[]) =>
  rows
    .filter((row) => row.role === "system")
    .flatMap((row) => (row.blocks as MessageBlock[]).filter((b) => b.kind === "meta"))
    .map((block) => (block as { text: string }).text);

postgres("computer health (PostgreSQL)", () => {
  it("asks once in the main chat after repeated hung checkpoints, even with approvals skipped", async () => {
    await withFixture(async (fx) => {
      for (let attempt = 1; attempt < RESTART_PROMPT_AFTER; attempt += 1) {
        await fx.sleep();
        expect((await fx.computerRow()).state).toBe("running");
        expect(asks(await fx.messages(fx.mainThread.id))).toEqual([]);
      }
      expect((await fx.health())?.unresponsiveCount).toBe(RESTART_PROMPT_AFTER - 1);

      await fx.sleep();
      const card = asks(await fx.messages(fx.mainThread.id));
      expect(card).toHaveLength(1);
      expect(card[0]).toMatchObject({
        status: "pending",
        text: `电脑连续 ${RESTART_PROMPT_AFTER} 次没有响应，要重启吗？`,
        computerRestart: { computerId: fx.computer.id, botId: fx.main.id },
        actions: [
          { id: "restart", label: "重启电脑" },
          { id: "keep", label: "先不重启" },
        ],
      });
      expect(card[0]?.detail).toContain("约 2 小时前保存");
      expect(card[0]?.detail).toContain("这之后的改动可能会丢失");
      // Not in the hidden worker's chat, and nothing restarted on its own.
      expect(await fx.messages(fx.workerThread.id)).toEqual([]);
      const after = await fx.computerRow();
      expect(after.state).toBe("running");
      expect(after.providerRef).toBe("sbx-1");
      expect(fx.sandbox.stop).not.toHaveBeenCalled();
      const health = await fx.health();
      expect(health?.restartMessageId).toBeTruthy();
      expect(health?.restartThreadId).toBe(fx.mainThread.id);

      // Still failing: no second card.
      await fx.sleep();
      expect(asks(await fx.messages(fx.mainThread.id))).toHaveLength(1);

      // It answers again: the count resets and the card closes itself.
      fx.sandboxState.exportHangs = false;
      await fx.sleep();
      expect((await fx.computerRow()).state).toBe("suspended");
      expect((await fx.health())?.unresponsiveCount).toBe(0);
      const closed = asks(await fx.messages(fx.mainThread.id));
      expect(closed).toHaveLength(1);
      expect(closed[0]?.computerRestart?.closed).toBe("recovered");
      expect(closed[0]?.status).toBe("pending");
    });
  });

  it("posts one disk notice in the main chat, rate-limited and re-armed below the threshold", async () => {
    await withFixture(async (fx) => {
      fx.sandboxState.backgroundActive = true;
      fx.sandboxState.resourceOutput = "disk 95 1048576\nmem 1000000 500000\n";
      await fx.sleep();
      expect(metas(await fx.messages(fx.mainThread.id))).toEqual([
        expect.stringContaining("磁盘已用 95%，只剩约 1.0 GB"),
      ]);
      expect(await fx.messages(fx.workerThread.id)).toEqual([]);
      const first = await fx.health();
      expect(first).toMatchObject({ diskPercent: 95, memoryPercent: 50, alertedResources: "disk" });
      // The computer itself is untouched: its lifecycle stamp does not move.
      expect((await fx.computerRow()).state).toBe("running");

      // Within the interval: no probe at all.
      const probes = () =>
        fx.sandbox.execute.mock.calls.filter(
          ([, request]) => !request.argv.includes(BACKGROUND_WORK_PROBE),
        ).length;
      expect(probes()).toBe(1);
      await fx.sleep();
      expect(probes()).toBe(1);

      const due = async () =>
        system(() =>
          fx.prisma.computerHealth.update({
            where: { computerId: fx.computer.id },
            data: { checkedAt: new Date(Date.now() - RESOURCE_CHECK_INTERVAL_MS - 1000) },
          }),
        );
      // Still full: no repeat.
      fx.sandboxState.resourceOutput = "disk 97 500000\nmem 1000000 500000\n";
      await due();
      await fx.sleep();
      expect(probes()).toBe(2);
      expect(metas(await fx.messages(fx.mainThread.id))).toHaveLength(1);

      // Cleaned up, then full again: one more notice.
      fx.sandboxState.resourceOutput = "disk 60 5000000\nmem 1000000 500000\n";
      await due();
      await fx.sleep();
      expect((await fx.health())?.alertedResources).toBeNull();
      fx.sandboxState.resourceOutput = "disk 92 800000\nmem 1000000 50000\n";
      await due();
      await fx.sleep();
      const notices = metas(await fx.messages(fx.mainThread.id));
      expect(notices).toHaveLength(2);
      expect(notices[1]).toContain("磁盘已用 92%");
      expect(notices[1]).toContain("内存已用 95%");
    });
  });
});
