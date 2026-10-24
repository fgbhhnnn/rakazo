import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";
process.env.RAKAZO_DISPATCHER_MODE = "1";
process.env.RAKAZO_DISPATCHER_TURN_MAX_MS = "5000";
process.env.RAKAZO_BACKGROUND_TASKS_PER_BOT = "2";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;
type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type BgModule = typeof import("../../adapters/src/background-tasks.ts");
type RowsModule = typeof import("../../adapters/src/background-task-rows.ts");

/** A fresh copy of the module: its own in-process locks and lease owner, like another process. */
async function freshModule(): Promise<BgModule> {
  vi.resetModules();
  return import("../../adapters/src/background-tasks.ts");
}

describeIntegration("background task rows: claims, recovery, FIFO, attribution", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let db: Awaited<ReturnType<typeof createApp>>["prisma"];
  let rows: RowsModule;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-bgl-"));
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
    rows = await import("../../adapters/src/background-task-rows.ts");
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A dispatcher bot plus a main run held "running", the way a live dispatcher turn is. */
  async function dispatcher(label: string) {
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
    const deps = {
      prisma: db,
      jobs: handles.jobs,
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

  const launchArgs = (name: string) => ({ name, task: `${name}: work until i stop` });
  const options = (key: string) => ({ builtinToolNames: ["shell", "read"], deliveryKey: key });

  it("two processes launching at once never exceed the limit or share a worker", async () => {
    const { deps: liveDeps, run, bot } = await dispatcher("Race");
    // Keep worker runs from executing (and failing at once), which would free slots mid-test.
    const deps = { ...(liveDeps as object), jobs: { enqueue: async () => undefined } } as never;
    const a = await freshModule();
    const b = await freshModule();
    const results = await Promise.all([
      a.launchBackgroundTask(deps, run, bot, launchArgs("r1"), options("k1")),
      b.launchBackgroundTask(deps, run, bot, launchArgs("r2"), options("k2")),
      b.launchBackgroundTask(deps, run, bot, launchArgs("r3"), options("k3")),
      a.launchBackgroundTask(deps, run, bot, launchArgs("r4"), options("k4")),
    ]);
    for (const out of results) expect(out).toMatchObject({ ok: true });
    const all = await db.backgroundTaskQueue.findMany({ where: { botId: bot.id } });
    expect(all).toHaveLength(4);
    const holding = all.filter((r) => r.status === "started" || r.status === "claiming");
    expect(holding).toHaveLength(2);
    expect(new Set(holding.map((r) => r.workerBotId)).size).toBe(2);
    expect(holding.every((r) => r.workerRunId)).toBe(true);
    expect(all.filter((r) => r.status === "queued")).toHaveLength(2);
    // The task id handed to the model is the row's ref, not a worker id.
    const refs = new Set(all.map((r) => r.ref));
    for (const out of results) expect(refs.has((out as { task_id: string }).task_id)).toBe(true);
  }, 60_000);

  it("recovers a crash between claim and start, and frees a slot whose run is gone", async () => {
    const { deps, run, bot } = await dispatcher("Crash");
    const mod = await freshModule();
    const base = {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      runId: run.id,
      threadId: run.threadId,
      task: "x",
      args: {},
    };
    const past = new Date(Date.now() - 60_000);
    const retry = await db.backgroundTaskQueue.create({
      data: {
        ...base,
        name: "retry",
        ref: "RETRY1",
        status: "claiming",
        attempts: 1,
        leaseOwner: "dead",
        leaseExpiresAt: past,
      },
    });
    const exhausted = await db.backgroundTaskQueue.create({
      data: {
        ...base,
        name: "spent",
        ref: "SPENT1",
        status: "claiming",
        attempts: mod.MAX_TASK_START_ATTEMPTS,
        leaseOwner: "dead",
        leaseExpiresAt: past,
      },
    });
    const live = await db.backgroundTaskQueue.create({
      data: {
        ...base,
        name: "live",
        ref: "LIVE01",
        status: "claiming",
        attempts: 1,
        leaseOwner: "other",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const orphan = await db.backgroundTaskQueue.create({
      data: {
        ...base,
        name: "orphan",
        ref: "ORPHN1",
        status: "started",
        attempts: 1,
        workerRunId: "missing-run",
      },
    });
    await mod.recoverBackgroundTasks(deps, { botId: bot.id });
    const by = async (id: string) => db.backgroundTaskQueue.findUniqueOrThrow({ where: { id } });
    expect((await by(retry.id)).status).toBe("queued");
    expect((await by(exhausted.id)).status).toBe("failed");
    // A live claim of another process is left alone.
    expect((await by(live.id)).status).toBe("claiming");
    const o = await by(orphan.id);
    expect(o.status).toBe("failed");
    expect(o.finishedAt).not.toBeNull();
  }, 60_000);

  it("keeps FIFO order and never starts a task cancelled while queued", async () => {
    const { deps: liveDeps, run, bot } = await dispatcher("Fifo");
    // Worker runs are never executed here: in this harness they fail at once ("connect a model"),
    // which frees their slot mid-test and makes the queue order depend on timing.
    const deps = { ...(liveDeps as object), jobs: { enqueue: async () => undefined } } as never;
    const mod = await freshModule();
    for (const name of ["f1", "f2", "f3", "f4"]) {
      await mod.launchBackgroundTask(deps, run, bot, launchArgs(name), options(name));
    }
    const ordered = await db.backgroundTaskQueue.findMany({
      where: { botId: bot.id },
      orderBy: { createdAt: "asc" },
    });
    expect(ordered.map((r) => r.status)).toEqual(["started", "started", "queued", "queued"]);
    // f3 is cancelled while queued (CAS on status=queued); free one slot by finishing f1.
    await db.backgroundTaskQueue.updateMany({
      where: { id: ordered[2]!.id, status: "queued" },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    const f1Run = await db.run.findUniqueOrThrow({ where: { id: ordered[0]!.workerRunId! } });
    await db.run.updateMany({
      where: {
        botId: f1Run.botId,
        status: { in: ["queued", "leased", "running", "waiting_input"] },
      },
      data: { status: "completed", completedAt: new Date() },
    });
    await rows.finalizeBackgroundTaskForRun(db, { ...f1Run, status: "completed" });
    await mod.startQueuedBackgroundTasks(deps, bot.id, run);
    const after = await db.backgroundTaskQueue.findMany({
      where: { botId: bot.id },
      orderBy: { createdAt: "asc" },
    });
    expect(after.map((r) => [r.name, r.status])).toEqual([
      ["f1", "completed"],
      ["f2", "started"],
      ["f3", "cancelled"],
      ["f4", "started"],
    ]);
    expect(after[2]!.workerBotId).toBeNull();
    // f4 reuses f1's worker slot.
    expect(after[3]!.workerBotId).toBe(after[0]!.workerBotId);
    // A task started from the queue still gets its "title #REF" card in the dispatcher's chat;
    // f1/f2 were announced by their own background_task calls, f3 never started.
    const readCards = async () =>
      (
        await db.message.findMany({ where: { threadId: run.threadId }, orderBy: { seq: "asc" } })
      ).flatMap((m) =>
        (Array.isArray(m.blocks) ? (m.blocks as Array<Record<string, unknown>>) : []).filter(
          (b) => b.kind === "child_bot",
        ),
      );
    // The card is posted off the queue's critical path.
    await waitFor(async () => (await readCards()).length > 0);
    const cards = await readCards();
    expect(cards).toEqual([
      expect.objectContaining({
        botId: after[3]!.workerBotId,
        name: `后台任务：f4 #${after[3]!.ref}`,
      }),
    ]);
  }, 60_000);

  it("credits a late result from an older run to its own task, not the slot's new task", async () => {
    const { deps, run, bot } = await dispatcher("Attrib");
    const mod = await freshModule();
    await mod.launchBackgroundTask(deps, run, bot, launchArgs("old"), options("old"));
    const old = await db.backgroundTaskQueue.findFirstOrThrow({
      where: { botId: bot.id, name: "old" },
    });
    const oldRun = await db.run.findUniqueOrThrow({ where: { id: old.workerRunId! } });
    // The old task ends; its slot is reused by a new task.
    await db.run.updateMany({
      where: {
        botId: oldRun.botId,
        status: { in: ["queued", "leased", "running", "waiting_input"] },
      },
      data: { status: "completed", completedAt: new Date() },
    });
    await rows.finalizeBackgroundTaskForRun(db, { ...oldRun, status: "completed" });
    await mod.launchBackgroundTask(deps, run, bot, launchArgs("new"), options("new"));
    await mod.launchBackgroundTask(deps, run, bot, launchArgs("new2"), options("new2"));
    const fresh = await db.backgroundTaskQueue.findFirstOrThrow({
      where: { botId: bot.id, workerBotId: oldRun.botId, status: "started" },
    });
    expect(fresh.id).not.toBe(old.id);
    // The old run's (late) outcome is attributed to the old task only.
    const credited = await rows.backgroundTaskForWorkerRun(db, oldRun);
    expect(credited?.id).toBe(old.id);
    await rows.finalizeBackgroundTaskForRun(db, { ...oldRun, status: "completed" });
    const still = await db.backgroundTaskQueue.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(still.status).toBe("started");
    // A stray run with no task of its own is not credited to the slot's current task either.
    expect(
      await rows.backgroundTaskForWorkerRun(db, { id: "stray-run", botId: oldRun.botId }),
    ).toBeNull();
  }, 60_000);

  it("defers a dispatcher wake only behind an earlier turn that is still alive", async () => {
    const { run } = await dispatcher("Wake");
    const { earlierDispatcherTurnAlive } = await import(
      "../../adapters/src/dispatcher-turn-guard.ts"
    );
    const later = {
      id: "later-wake",
      botId: run.botId,
      threadId: run.threadId,
      createdAt: new Date(),
    };
    await db.run.update({
      where: { id: run.id },
      data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    expect(await earlierDispatcherTurnAlive(db, later)).toBe(true);
    // A turn whose lease expired is dead (the reconciler recovers it): the wake may proceed.
    await db.run.update({
      where: { id: run.id },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
    });
    expect(await earlierDispatcherTurnAlive(db, later)).toBe(false);
  }, 60_000);
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
