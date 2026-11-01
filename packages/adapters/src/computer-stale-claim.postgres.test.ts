import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { createDb, createThreadEvents, runAsSystem, runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { RESTART_PROMPT_AFTER, SUSPEND_CLAIM_STALE_MS } from "./computer-health.js";
import { BACKGROUND_WORK_PROBE, sleepComputerIfIdle } from "./computer-idle.js";
import type { E2BSandboxSdk } from "./e2b-sandbox.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;
type ProviderAnswer = "paused" | "running" | "gone" | "error";
const system = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
const SANDBOX = "izl0ucema1g3ro5v5jwmm";

async function withFixture(run: (fx: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const { prisma, pool } = createDb(process.env.DATABASE_URL!);
  const id = `sc-${randomUUID()}`;
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
      data: { id: `${id}-org`, name: "SC", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId: `${id}-org`, name: "SC" } });
    const computer = await prisma.computer.create({
      data: {
        spaceId,
        userId,
        scope: "team",
        scopeKey: `${id}-scope`,
        homeKey: `${id}-home`,
        kind: "e2b",
        providerRef: SANDBOX,
        state: "running",
        runningSince: new Date(Date.now() - 17 * 60 * 60 * 1000),
        homeRevisionAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.computerRun.create({
      data: {
        computerId: computer.id,
        spaceId,
        userId,
        kind: "e2b",
        providerRef: SANDBOX,
        startedAt: computer.runningSince!,
      },
    });
    const main = await prisma.bot.create({
      data: { spaceId, userId, name: "Chief", color: "ink", computerId: computer.id },
    });
    const mainThread = await prisma.thread.create({ data: { spaceId, userId, botId: main.id } });
    return { computer, main, mainThread };
  });

  const provider = { answer: "paused" as ProviderAnswer };
  // The real E2B status check over a fake SDK: it must never resume (connect to) the sandbox.
  const sdk = {
    create: vi.fn(async () => {
      throw new Error("no new sandbox in this test");
    }),
    connect: vi.fn(async () => {
      throw new Error("checking a stale claim must not resume the sandbox");
    }),
    getInfo: vi.fn(async () => {
      if (provider.answer === "gone") {
        throw Object.assign(new Error(`Sandbox ${SANDBOX} not found`), {
          name: "SandboxNotFoundError",
        });
      }
      if (provider.answer === "error") throw new Error("503: service unavailable");
      return { state: provider.answer };
    }),
  };
  const e2b = new E2BSandboxProvider("test-key", sdk as unknown as E2BSandboxSdk);
  const sandboxState = { exportHangs: true };
  const sandbox = {
    isStopped: vi.fn((ref: ComputerRef, context: AdapterContext) => e2b.isStopped(ref, context)),
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
  /**
   * The production state: hung checkpoints posted the restart card, failures kept counting to
   * 27, and a sleep job died with its worker while holding a "suspending" claim.
   */
  const reproduceProductionState = async () => {
    // It was awake for every one of those failed saves.
    provider.answer = "running";
    for (let attempt = 0; attempt < RESTART_PROMPT_AFTER; attempt += 1) await sleep();
    expect(asks(await messages(rows.mainThread.id))).toHaveLength(1);
    await system(async () => {
      await prisma.computerHealth.update({
        where: { computerId: rows.computer.id },
        data: { unresponsiveCount: 27 },
      });
      await prisma.computer.update({
        where: { id: rows.computer.id },
        data: {
          state: "suspending",
          updatedAt: new Date(Date.now() - SUSPEND_CLAIM_STALE_MS - 60_000),
        },
      });
    });
    sandbox.isStopped.mockClear();
    sandbox.exportWorkspace.mockClear();
    sandbox.execute.mockClear();
    jobs.enqueue.mockClear();
  };
  return {
    ...rows,
    prisma,
    provider,
    sdk,
    sandbox,
    sandboxState,
    jobs,
    sleep,
    messages,
    health,
    computerRow,
    reproduceProductionState,
  };
}

const asks = (rows: { blocks: unknown }[]) =>
  rows.flatMap((row) =>
    (row.blocks as MessageBlock[]).filter((b): b is AskBlock => b.kind === "ask"),
  );

postgres("stale suspend claim settled with the provider (PostgreSQL)", () => {
  it("heals the production state on the next idle check when E2B already paused the sandbox", async () => {
    await withFixture(async (fx) => {
      await fx.reproduceProductionState();
      const before = await fx.health();
      expect(before).toMatchObject({ unresponsiveCount: 27 });
      expect(before?.restartMessageId).toBeTruthy();
      expect((await fx.computerRow()).state).toBe("suspending");

      fx.provider.answer = "paused";
      await fx.sleep();

      const after = await fx.computerRow();
      expect(after.state).toBe("suspended");
      expect(after.runningSince).toBeNull();
      expect(after.providerRef).toBe(SANDBOX);
      expect(after.controlHolder).toBe("none");
      const health = await fx.health();
      expect(health?.unresponsiveCount).toBe(0);
      expect(health?.restartMessageId).toBeNull();
      const card = asks(await fx.messages(fx.mainThread.id));
      expect(card).toHaveLength(1);
      expect(card[0]?.computerRestart?.closed).toBe("recovered");
      // The open run closed; nothing resumed, probed or saved the sandbox.
      const runs = await system(() =>
        fx.prisma.computerRun.findMany({ where: { computerId: fx.computer.id } }),
      );
      expect(runs.every((run) => run.endedAt !== null)).toBe(true);
      expect(fx.sdk.getInfo).toHaveBeenCalledWith(
        SANDBOX,
        expect.objectContaining({ apiKey: "test-key" }),
      );
      expect(fx.sdk.connect).not.toHaveBeenCalled();
      expect(fx.sandbox.execute).not.toHaveBeenCalled();
      expect(fx.sandbox.exportWorkspace).not.toHaveBeenCalled();
      expect(fx.sandbox.stop).not.toHaveBeenCalled();
      expect(fx.jobs.enqueue).not.toHaveBeenCalled();

      // The next idle check finds it asleep and leaves it alone.
      await fx.sleep();
      expect((await fx.computerRow()).state).toBe("suspended");
      expect((await fx.health())?.unresponsiveCount).toBe(0);
      expect(fx.sdk.connect).not.toHaveBeenCalled();
      expect(fx.sandbox.exportWorkspace).not.toHaveBeenCalled();
    });
  });

  it.each(["running", "gone", "error"] as const)(
    "keeps counting a stale claim when E2B answers %s",
    async (answer) => {
      await withFixture(async (fx) => {
        await fx.reproduceProductionState();
        const card = (await fx.health())?.restartMessageId;

        fx.provider.answer = answer;
        await fx.sleep();

        const after = await fx.computerRow();
        expect(after.state).toBe("running");
        expect(after.runningSince).not.toBeNull();
        const health = await fx.health();
        expect(health?.unresponsiveCount).toBe(28);
        expect(health?.restartMessageId).toBe(card);
        const asked = asks(await fx.messages(fx.mainThread.id));
        expect(asked).toHaveLength(1);
        expect(asked[0]?.computerRestart?.closed).toBeUndefined();
        expect(fx.sandbox.isStopped).toHaveBeenCalledOnce();
        expect(fx.sdk.connect).not.toHaveBeenCalled();
        expect(fx.jobs.enqueue).toHaveBeenCalledOnce();
      });
    },
  );

  it("closes the card once a later save succeeds after a stale claim was counted", async () => {
    await withFixture(async (fx) => {
      await fx.reproduceProductionState();
      fx.provider.answer = "running";
      await fx.sleep();
      expect((await fx.health())?.unresponsiveCount).toBe(28);

      fx.sandboxState.exportHangs = false;
      await fx.sleep();

      expect((await fx.computerRow()).state).toBe("suspended");
      expect((await fx.health())?.unresponsiveCount).toBe(0);
      expect(asks(await fx.messages(fx.mainThread.id))[0]?.computerRestart?.closed).toBe(
        "recovered",
      );
    });
  });
});
