import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";
process.env.RAKAZO_DISPATCHER_MODE = "1";
process.env.RAKAZO_DISPATCHER_TURN_MAX_MS = "5000";
process.env.RAKAZO_BACKGROUND_TASKS_PER_BOT = "2";
process.env.RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT = "3";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;
type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type BgModule = typeof import("../../adapters/src/background-tasks.ts");
type LanesModule = typeof import("../../adapters/src/background-task-lanes.ts");

describeIntegration("background task lanes (PostgreSQL)", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let db: Awaited<ReturnType<typeof createApp>>["prisma"];
  let bg: BgModule;
  let lanes: LanesModule;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-lanes-"));
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
    });
    db = asSystem(handles.prisma);
    bg = await import("../../adapters/src/background-tasks.ts");
    lanes = await import("../../adapters/src/background-task-lanes.ts");
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A dispatcher bot plus a main run held "running", the way a live dispatcher turn is. */
  async function dispatcher(label: string, live = false) {
    const app = handles.app as App;
    const cookie = await signup(app, `${label}-${stamp}@rakazo.test`, label);
    const bot = await rpc<{ id: string; name: string }>(app, cookie, "bots/create", {
      name: label,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "hello",
    });
    await waitFor(async () => {
      const r = await db.run.findUnique({ where: { id: sent.runId }, select: { status: true } });
      return Boolean(r && ["completed", "failed", "cancelled"].includes(r.status));
    });
    const run = await db.run.update({
      where: { id: sent.runId },
      data: { status: "running", completedAt: null },
    });
    const full = await db.bot.findUniqueOrThrow({ where: { id: bot.id } });
    // Without live jobs worker runs never execute, so slots stay held for the whole test.
    const deps = {
      prisma: db,
      jobs: live ? handles.jobs : { enqueue: async () => undefined },
      events: { notify: async () => undefined },
    } as never;
    const dispatchRun = {
      id: run.id,
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      userId: run.userId,
    };
    const dispatchBot = { id: full.id, name: full.name, computerId: full.computerId };
    return { deps, run: dispatchRun, bot: dispatchBot };
  }

  const builtinToolNames = [
    "shell",
    "read_file",
    "browser_navigate",
    "computer_act",
    "web_search",
    "web_fetch",
    "report_progress",
    "background_task",
  ];
  const opts = (key: string) => ({ builtinToolNames, deliveryKey: key });
  const task = (name: string, lane?: string) => ({
    name,
    task: `${name}: work until i stop`,
    ...(lane ? { lane } : {}),
  });

  it("runs each lane up to its own limit with its own FIFO queue and slots", async () => {
    const { deps, run, bot } = await dispatcher("Lanes");
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, lane] of [
      ["c1", undefined],
      ["t1", "think"],
      ["c2", "computer"],
      ["t2", "think"],
      ["c3", undefined],
      ["t3", "think"],
      ["t4", "think"],
      ["t5", "think"],
    ] as const) {
      out[name] = (await bg.launchBackgroundTask(
        deps,
        run,
        bot,
        task(name, lane),
        opts(name),
      )) as never;
    }
    // Computer lane: 2 slots. Think lane: 3 slots. Each queue counts its own positions.
    for (const name of ["c1", "c2", "t1", "t2", "t3"])
      expect(out[name]).toMatchObject({ status: "started" });
    expect(out.c1).toMatchObject({ lane: "computer" });
    expect(out.t1).toMatchObject({ lane: "think" });
    expect(out.c3).toMatchObject({
      status: "queued",
      lane: "computer",
      position: 1,
      running: 2,
      limit: 2,
    });
    expect(out.t4).toMatchObject({
      status: "queued",
      lane: "think",
      position: 1,
      running: 3,
      limit: 3,
    });
    expect(out.t5).toMatchObject({ status: "queued", lane: "think", position: 2 });
    expect(String(out.t4?.note)).toContain("思考队列第 1 位");
    expect(String(out.c3?.note)).toContain("电脑队列第 1 位");

    const rows = await db.backgroundTaskQueue.findMany({ where: { botId: bot.id } });
    const byName = new Map(rows.map((r) => [r.name, r]));
    const laneArg = (name: string) =>
      (byName.get(name)?.args as { lane?: string } | undefined)?.lane;
    // Unlabelled and explicit computer tasks store no lane: they are plain pre-lane rows.
    expect(laneArg("c1")).toBeUndefined();
    expect(laneArg("c2")).toBeUndefined();
    expect(laneArg("t1")).toBe("think");

    const workers = await db.bot.findMany({
      where: { parentBotId: bot.id },
      select: {
        id: true,
        spawnKey: true,
        computerId: true,
        disabledBuiltinTools: true,
        instructions: true,
        name: true,
      },
    });
    const slotOf = (id: string | null) =>
      lanes.workerSlotOfSpawnKey(workers.find((w) => w.id === id)?.spawnKey);
    expect(["c1", "c2"].map((n) => slotOf(byName.get(n)!.workerBotId)).sort()).toEqual([1, 2]);
    expect(["t1", "t2", "t3"].map((n) => slotOf(byName.get(n)!.workerBotId)).sort()).toEqual([
      101, 102, 103,
    ]);
    for (const worker of workers) {
      // Every worker stays a hidden "· 后台<n>" worker under the same spawn-key prefix.
      expect(worker.spawnKey?.startsWith(`${bg.BACKGROUND_WORKER_SPAWN_PREFIX}${bot.id}:`)).toBe(
        true,
      );
      expect(worker.name).toMatch(/ · 后台\d+$/);
      if (lanes.isThinkWorker(worker)) {
        // No computer at all, so its runs never wake or hold the dispatcher's computer.
        expect(worker.computerId).toBeNull();
        for (const name of ["shell", "read_file", "browser_navigate", "computer_act"])
          expect(worker.disabledBuiltinTools).toContain(name);
        expect(worker.disabledBuiltinTools).not.toContain("web_search");
        expect(worker.instructions).toContain("【思考任务】");
      } else {
        expect(worker.computerId).toBe(bot.computerId);
        expect(worker.disabledBuiltinTools).not.toContain("shell");
        expect(worker.instructions).not.toContain("【思考任务】");
      }
      // The nesting ban holds in both lanes.
      expect(worker.disabledBuiltinTools).toContain("background_task");
    }

    const status = (await bg.backgroundTaskStatus(deps, run, bot, {})) as {
      limit: number;
      think_limit: number;
      tasks: { name: string; lane: string; state: string; position?: number }[];
    };
    expect(status.limit).toBe(2);
    expect(status.think_limit).toBe(3);
    const st = new Map(status.tasks.map((t) => [t.name, t]));
    expect(st.get("c3")).toMatchObject({ lane: "computer", state: "queued", position: 1 });
    expect(st.get("t4")).toMatchObject({ lane: "think", state: "queued", position: 1 });
    expect(st.get("t5")).toMatchObject({ lane: "think", state: "queued", position: 2 });
    expect(st.get("t1")?.lane).toBe("think");

    // Freeing a think slot starts the next think task only; the full computer lane stays full.
    const t1 = byName.get("t1")!;
    await db.run.update({
      where: { id: t1.workerRunId! },
      data: { status: "completed", completedAt: new Date() },
    });
    await db.backgroundTaskQueue.update({
      where: { id: t1.id },
      data: { status: "completed", finishedAt: new Date() },
    });
    await bg.startQueuedBackgroundTasks(deps, bot.id, run);
    const after = new Map(
      (await db.backgroundTaskQueue.findMany({ where: { botId: bot.id } })).map((r) => [r.name, r]),
    );
    expect(after.get("t4")?.status).toBe("started");
    expect(after.get("t4")?.workerBotId).toBe(t1.workerBotId);
    expect(after.get("t5")?.status).toBe("queued");
    expect(after.get("c3")?.status).toBe("queued");

    // Freeing a computer slot starts the computer head; think tasks never take computer slots.
    const c1 = byName.get("c1")!;
    await db.run.update({
      where: { id: c1.workerRunId! },
      data: { status: "completed", completedAt: new Date() },
    });
    await db.backgroundTaskQueue.update({
      where: { id: c1.id },
      data: { status: "completed", finishedAt: new Date() },
    });
    await bg.startQueuedBackgroundTasks(deps, bot.id, run);
    const later = new Map(
      (await db.backgroundTaskQueue.findMany({ where: { botId: bot.id } })).map((r) => [r.name, r]),
    );
    expect(later.get("c3")?.status).toBe("started");
    expect(later.get("c3")?.workerBotId).toBe(c1.workerBotId);
    expect(later.get("t5")?.status).toBe("queued");
  }, 90_000);

  it("treats an unlabelled pre-lane row as a computer task and reports cancel positions per lane", async () => {
    const { deps, run, bot } = await dispatcher("Legacy");
    for (const name of ["c1", "c2"])
      await bg.launchBackgroundTask(deps, run, bot, task(name), opts(name));
    // A row written before lanes existed: no lane in its args.
    await db.backgroundTaskQueue.create({
      data: {
        spaceId: run.spaceId,
        botId: bot.id,
        userId: run.userId,
        runId: run.id,
        threadId: run.threadId,
        name: "legacy",
        task: "legacy work",
        ref: "LEGACY01",
        args: { agent: "general", disabled: [] },
      },
    });
    for (const name of ["t1", "t2", "t3", "t4"])
      await bg.launchBackgroundTask(deps, run, bot, task(name, "think"), opts(name));
    const legacy = await db.backgroundTaskQueue.findFirstOrThrow({
      where: { botId: bot.id, name: "legacy" },
    });
    // The computer lane is full, so the legacy row waits there even though think slots were free.
    expect(legacy.status).toBe("queued");
    const status = (await bg.backgroundTaskStatus(deps, run, bot, {})) as {
      tasks: { name: string; lane: string; position?: number }[];
    };
    const st = new Map(status.tasks.map((t) => [t.name, t]));
    expect(st.get("legacy")).toMatchObject({ lane: "computer", position: 1 });
    expect(st.get("t4")).toMatchObject({ lane: "think", position: 1 });

    const t1 = await db.backgroundTaskQueue.findFirstOrThrow({
      where: { botId: bot.id, name: "t1" },
    });
    const cancelled = (await bg.cancelBackgroundTask(deps, run, bot, { task_id: t1.ref })) as {
      started_from_queue: { name: string }[];
      still_queued: { name: string; position: number }[];
    };
    // The freed think slot went to the think queue's head, not to the older computer-lane row.
    expect(cancelled.started_from_queue.map((t) => t.name)).toEqual(["t4"]);
    expect(cancelled.still_queued).toEqual([
      expect.objectContaining({ name: "legacy", position: 1 }),
    ]);
  }, 90_000);

  it("never dedupes a think task against its computer re-dispatch", async () => {
    const { deps, run, bot } = await dispatcher("Redispatch");
    const a = await bg.launchBackgroundTask(deps, run, bot, task("same", "think"), opts("a"));
    const b = await bg.launchBackgroundTask(deps, run, bot, task("same", "computer"), opts("b"));
    const c = await bg.launchBackgroundTask(deps, run, bot, task("same", "think"), opts("c"));
    expect(a).toMatchObject({ status: "started", lane: "think" });
    expect(b).toMatchObject({ status: "started", lane: "computer" });
    expect(c).toMatchObject({ status: "already_running" });
    expect(await bg.launchBackgroundTask(deps, run, bot, task("x", "gpu"), opts("d"))).toEqual({
      error: 'lane must be "think" or "computer"',
    });
  }, 90_000);

  it("runs a think worker to completion without a computer and refuses its computer tools", async () => {
    const { deps, run, bot } = await dispatcher("ThinkRun", true);
    const launched = (await bg.launchBackgroundTask(
      deps,
      run,
      bot,
      { name: "probe", task: "run the shell command echo lanes-probe", lane: "think" },
      opts("probe"),
    )) as { status: string; worker_id: string };
    expect(launched.status).toBe("started");
    const row = await db.backgroundTaskQueue.findFirstOrThrow({
      where: { botId: bot.id, name: "probe" },
    });
    await waitFor(async () => {
      const r = await db.run.findUnique({
        where: { id: row.workerRunId! },
        select: { status: true },
      });
      return Boolean(r && ["completed", "failed", "cancelled"].includes(r.status));
    }, 60_000);
    const workerRun = await db.run.findUniqueOrThrow({ where: { id: row.workerRunId! } });
    expect(workerRun.error ?? "").not.toContain("no computer");
    expect(workerRun.status).toBe("completed");
    const worker = await db.bot.findUniqueOrThrow({ where: { id: launched.worker_id } });
    expect(worker.computerId).toBeNull();
    // The shell call was refused, never run: no computer lease or provisioning for this run.
    const events = await db.event.findMany({ where: { runId: workerRun.id } });
    const text = JSON.stringify(events.map((e) => e.payload));
    expect(text).toContain("需要电脑");
    expect(text).not.toContain("lanes-probe\\n");
    expect(await db.computerExecutionLease.count({ where: { runId: workerRun.id } })).toBe(0);
    expect(events.some((e) => e.type === "computer.requested")).toBe(false);
  }, 90_000);
});

async function waitFor(pred: () => Promise<boolean>, ms = 20_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for database state");
}

async function signup(app: App, email: string, name: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (res.status >= 400) throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  return sessionCookieHeader(res);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400) throw new Error(parsed.error?.message ?? text);
  return parsed.json as T;
}
