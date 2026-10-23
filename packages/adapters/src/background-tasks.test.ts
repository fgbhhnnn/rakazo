import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const messageBot = vi.fn();
const spawnBot = vi.fn();
vi.mock("./bot-messages.js", () => ({ messageBot: (...a: unknown[]) => messageBot(...a) }));
vi.mock("./child-bots.js", () => ({ spawnBot: (...a: unknown[]) => spawnBot(...a) }));

const {
  backgroundTaskConcurrency,
  backgroundTaskMessage,
  backgroundWorkerSpawnKey,
  buildBackgroundTaskMessage,
  cancelBackgroundTask,
  launchBackgroundTask,
  workerDisabledTools,
} = await import("./background-tasks.js");
const { BACKGROUND_WORK_LAUNCH, CANCEL_COMPUTER_RUN_WORK } = await import("./computer-idle.js");
const { stopThreadRunsForBots } = await import("./thread-stop.js");

const run = { id: "run-main", spaceId: "s1", threadId: "t-main", botId: "b-main", userId: "u1" };
const bot = { id: "b-main", name: "Chief", computerId: null };
const names = ["shell", "read", "background_task", "spawn_bot", "web_search", "message_user"];

function worker(slot: number) {
  return {
    id: `w${slot}`,
    name: `Chief · 后台${slot}`,
    spawnKey: backgroundWorkerSpawnKey(bot.id, slot),
    thread: { id: `t-w${slot}` },
  };
}

function fakeDeps(opts: { workers: ReturnType<typeof worker>[]; active?: Record<string, string> }) {
  const prisma = {
    bot: {
      findMany: vi.fn(async () => opts.workers),
      update: vi.fn(async () => ({})),
    },
    thread: { findFirst: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    message: { findFirst: vi.fn(async () => null) },
    backgroundTaskQueue: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "q1",
        createdAt: new Date(),
        ...data,
      })),
      count: vi.fn(async () => 1),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    run: {
      findFirst: vi.fn(async ({ where }: { where: { botId: string } }) =>
        opts.active?.[where.botId]
          ? {
              id: `r-${where.botId}`,
              taskId: "task",
              status: opts.active[where.botId],
              createdAt: new Date(),
            }
          : null,
      ),
    },
  };
  return {
    prisma,
    deps: {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn() },
      sandbox: {},
    } as never,
  };
}

beforeEach(() => {
  messageBot.mockReset().mockResolvedValue({ ok: true });
  spawnBot.mockReset();
});

describe("background task helpers", () => {
  it("disables delegation tools and applies allowlists", () => {
    expect(workerDisabledTools(names, undefined)).toEqual(["background_task", "spawn_bot"]);
    expect(workerDisabledTools(names, ["read"])).toEqual(
      ["background_task", "message_user", "shell", "spawn_bot", "web_search"].sort(),
    );
  });

  it("reads the concurrency limit", () => {
    expect(backgroundTaskConcurrency({})).toBe(4);
    expect(backgroundTaskConcurrency({ RAKAZO_BACKGROUND_TASKS_PER_BOT: "5" })).toBe(5);
  });

  it("bounds the task message", () => {
    const text = buildBackgroundTaskMessage({
      name: "x",
      task: "y".repeat(50_000),
      agent: "general",
    });
    expect(text.length).toBeLessThanOrEqual(8000);
  });
});

describe("launchBackgroundTask", () => {
  it("returns immediately after queueing, without waiting for the worker", async () => {
    const { deps } = fakeDeps({ workers: [worker(1)] });
    const started = Date.now();
    const out = await launchBackgroundTask(
      deps,
      run,
      bot,
      { name: "ocr", task: "do it" },
      {
        builtinToolNames: names,
        deliveryKey: "k1",
      },
    );
    expect(out).toMatchObject({ ok: true, task_id: "w1" });
    expect(Date.now() - started).toBeLessThan(200);
    expect(messageBot).toHaveBeenCalledWith(
      deps,
      run,
      { id: "b-main", name: "Chief" },
      expect.objectContaining({ bot_id: "w1", intent: "request" }),
    );
  });

  it("skips busy slots and queues past the limit", async () => {
    const busy = fakeDeps({
      workers: [worker(1), worker(2), worker(3)],
      active: { w1: "running", w2: "queued" },
    });
    const out = await launchBackgroundTask(
      busy.deps,
      run,
      bot,
      { task: "t" },
      {
        builtinToolNames: names,
        deliveryKey: "k",
      },
    );
    expect(out).toMatchObject({ task_id: "w3" });
    const full = fakeDeps({
      workers: [worker(1), worker(2), worker(3), worker(4)],
      active: { w1: "running", w2: "running", w3: "running", w4: "running" },
    });
    const refused = await launchBackgroundTask(
      full.deps,
      run,
      bot,
      { task: "t" },
      {
        builtinToolNames: names,
        deliveryKey: "k",
      },
    );
    expect(refused).toMatchObject({ ok: true, status: "queued", task_id: "q:q1", position: 1 });
    expect(full.prisma.backgroundTaskQueue.create).toHaveBeenCalledTimes(1);
    expect(messageBot).toHaveBeenCalledTimes(1);
  });
});

describe("backgroundTaskMessage", () => {
  it("steers a running worker mid-run instead of queueing a new run", async () => {
    const { deps, prisma } = fakeDeps({ workers: [worker(1)], active: { w1: "running" } });
    const tx = {
      $queryRaw: vi.fn(),
      thread: {
        findUniqueOrThrow: vi.fn(async () => ({ nextMessageSeq: 5, nextEventSeq: 3 })),
        update: vi.fn(async () => ({ nextMessageSeq: 6, nextEventSeq: 4 })),
      },
      message: { create: vi.fn(async ({ data }: { data: object }) => ({ id: "m1", ...data })) },
      steeringMessage: { create: vi.fn(async () => ({})) },
      run: { findUnique: vi.fn(async () => ({ status: "running", startedAt: new Date(0) })) },
      event: { create: vi.fn(async ({ data }: { data: object }) => ({ seq: 4, ...data })) },
    };
    Object.assign(prisma, { $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)) });
    const out = await backgroundTaskMessage(
      deps,
      run,
      bot,
      { task_id: "w1", message: "只做前 10 页" },
      "k",
    );
    expect(out).toMatchObject({ ok: true });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: { messageId: "m1", botId: "w1", userId: "u1", runId: "r-w1" },
    });
    expect(messageBot).not.toHaveBeenCalled();
  });
});

describe("cancelBackgroundTask", () => {
  it("cancels all workers through the Stop path", async () => {
    const { deps } = fakeDeps({ workers: [worker(1), worker(2)] });
    const stop = vi.fn(async () => ({ runIds: ["r"] }));
    const out = await cancelBackgroundTask(deps, run, bot, { task_id: "all" }, stop);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledWith(
      { spaceId: "s1", userId: "u1" },
      { threadId: "t-w1", botIds: ["w1"] },
    );
    expect(out).toMatchObject({ ok: true, cancelled: [{ task_id: "w1" }, { task_id: "w2" }] });
  });

  it("marks the worker run cancelled and kills its shell work on the computer", async () => {
    const execute = vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    });
    const tx = {
      $queryRaw: vi.fn(),
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      run: {
        updateManyAndReturn: vi.fn(async () => [{ id: "r-w1", botId: "w1" }]),
        findUnique: vi.fn(async () => ({ status: "cancelled" })),
      },
      steeringMessage: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      computerExecutionLease: {
        findMany: vi.fn(async () => [{ computerId: "c1", botId: "w1", runId: "r-w1", fence: 1 }]),
      },
      computer: {
        findMany: vi.fn(async () => [
          {
            id: "c1",
            homeKey: "h",
            kind: "fake",
            providerRef: "ref1",
            executionBotId: null,
            executionRunId: null,
          },
        ]),
      },
      event: {
        create: vi.fn(async ({ data }: { data: object }) => ({ seq: 1, ...data })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
      bot: { findMany: vi.fn(async () => [worker(1)]) },
      computer: { updateMany: vi.fn(async () => ({ count: 0 })) },
      computerExecutionLease: { updateMany: vi.fn(async () => ({ count: 1 })) },
      backgroundTaskQueue: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
      },
    };
    const deps = {
      prisma,
      sandbox: { execute, releaseScreen: vi.fn(async () => undefined) },
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn() },
    } as never;
    const started = performance.now();
    const out = await cancelBackgroundTask(deps, run, bot, { task_id: "w1" });
    const ms = performance.now() - started;
    expect(out).toMatchObject({ ok: true, cancelled: [{ task_id: "w1", cancelled_runs: 1 }] });
    expect(tx.run.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "cancelled" }) }),
    );
    expect(tx.event.create).toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "ref1" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["rakazo-cancel-run-work", "c1", "r-w1"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "r-w1" }),
    );
    // biome-ignore lint/suspicious/noConsole: report observed cancel latency
    console.info(`[cancel latency] orchestration (mocked DB/sandbox): ${ms.toFixed(1)} ms`);
    expect(stopThreadRunsForBots).toBeTypeOf("function");
  });

  it("really kills a worker's running shell command (CANCEL_COMPUTER_RUN_WORK)", async () => {
    const computerId = `c-${randomUUID()}`;
    const runId = `r-${randomUUID()}`;
    const child = spawn(
      "bash",
      [
        "-c",
        BACKGROUND_WORK_LAUNCH,
        "rakazo-background-launch",
        computerId,
        runId,
        randomUUID(),
        "sleep 60",
      ],
      { stdio: "ignore" },
    );
    const exited = new Promise<number>((resolve) =>
      child.on("exit", () => resolve(performance.now())),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(child.exitCode).toBeNull();
    const started = performance.now();
    await new Promise<void>((resolve) =>
      spawn("bash", ["-c", CANCEL_COMPUTER_RUN_WORK, "rakazo-cancel-run-work", computerId, runId], {
        stdio: "ignore",
      }).on("exit", () => resolve()),
    );
    const exitedAt = await exited;
    const ms = exitedAt - started;
    // biome-ignore lint/suspicious/noConsole: report observed cancel latency
    console.info(`[cancel latency] real shell kill: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(5000);
  });
});

describe("worker context", () => {
  it("starts an unrelated task fresh but keeps context for a routed follow-up", async () => {
    const { deps, prisma } = fakeDeps({ workers: [worker(1)] });
    prisma.thread.findFirst.mockResolvedValue({ id: "t-w1", nextMessageSeq: 12 } as never);
    await launchBackgroundTask(
      deps,
      run,
      bot,
      { name: "video", task: "make it" },
      {
        builtinToolNames: names,
        deliveryKey: "k",
      },
    );
    expect(prisma.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t-w1" },
        data: expect.objectContaining({ historyCompactedUpToSeq: 11 }),
      }),
    );
    prisma.thread.update.mockClear();
    // Follow-up ("配音换成男声") to the now idle worker: same worker, history kept.
    const out = await backgroundTaskMessage(
      deps,
      run,
      bot,
      { task_id: "w1", message: "配音换成男声" },
      "k2",
    );
    expect(out).toMatchObject({ ok: true, task_id: "w1" });
    expect(prisma.thread.update).not.toHaveBeenCalled();
    expect(messageBot).toHaveBeenLastCalledWith(
      deps,
      run,
      expect.anything(),
      expect.objectContaining({ bot_id: "w1", message: "配音换成男声" }),
    );
  });
});
