import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";
process.env.RAKAZO_RUN_CANCEL_POLL_MS ??= "500";
process.env.RAKAZO_DISPATCHER_MODE = "1";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;
type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
let harness: BotIntroHarness | undefined;

describeIntegration("background tasks: dispatcher stays idle, stop is immediate", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let db: Awaited<ReturnType<typeof createApp>>["prisma"];
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-bg-"));
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
    harness = handles;
    db = asSystem(handles.prisma);
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("dispatches, answers a mid-task message at once, and cancels the worker", async () => {
    const app = handles.app as App;
    const cookie = await signup(app, `bg-${stamp}@rakazo.test`, "Bg");
    const chief = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    await waitFor(async () => (await activeRuns([chief.id])) === 0);

    // 1. Dispatch: the main run ends right away while the worker keeps going.
    const t0 = Date.now();
    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: chief.id,
      text: "dispatch in background: hang until stopped",
    });
    await waitFor(async () => terminal(sent.runId));
    const dispatchMs = Date.now() - t0;
    const mainRun = await db.run.findUniqueOrThrow({ where: { id: sent.runId } });
    expect(mainRun.status).toBe("completed");
    const worker = await db.bot.findFirstOrThrow({
      where: { parentBotId: chief.id, spawnKey: { startsWith: "bg-worker:" } },
    });
    await waitFor(async () =>
      Boolean(await db.run.findFirst({ where: { botId: worker.id, status: "running" } })),
    );
    expect(await activeRuns([chief.id])).toBe(0);

    // Workers are hidden from every listing but still open from the task card.
    const listed = await rpc<Array<{ id: string }>>(app, cookie, "bots/list", {});
    expect(listed.map((b) => b.id)).toContain(chief.id);
    expect(listed.map((b) => b.id)).not.toContain(worker.id);
    const hits = await rpc<unknown>(app, cookie, "search/query", { q: "后台" });
    expect(JSON.stringify(hits)).not.toContain(worker.id);
    const boot = await rpc<{ bots: Array<{ id: string }>; thread: { botId: string } | null }>(
      app,
      cookie,
      "bootstrap",
      { botId: worker.id },
    );
    expect(boot.bots.map((b) => b.id)).not.toContain(worker.id);
    expect(boot.thread?.botId).toBe(worker.id);
    const opened = await rpc<{ id: string }>(app, cookie, "bots/get", { botId: worker.id });
    expect(opened.id).toBe(worker.id);
    const workerThread = await rpc<{ botId: string }>(app, cookie, "threads/get", {
      botId: worker.id,
    });
    expect(workerThread.botId).toBe(worker.id);

    // 2. Mid-task user message: a fresh main run starts (no steering into a busy run)
    //    and, being a stop request, cancels the worker.
    const t1 = Date.now();
    const stop = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: chief.id,
      // The scripted model takes an explicit command; real-model intent judgment over varied
      // wordings is covered by the production routing tests.
      text: "cancel all background tasks",
    });
    expect(stop.runId).not.toBe(sent.runId);
    await waitFor(async () => terminal(stop.runId));
    const mainReplyMs = Date.now() - t1;
    await waitFor(async () => (await activeRuns([worker.id])) === 0);
    const workerStoppedMs = Date.now() - t1;
    const workerRun = await db.run.findFirstOrThrow({
      where: { botId: worker.id },
      orderBy: { createdAt: "desc" },
    });
    expect(workerRun.status).toBe("cancelled");
    expect(
      await db.event.count({ where: { runId: workerRun.id, type: "run.cancelled" } }),
    ).toBeGreaterThan(0);
    const toolEvents = await db.event.findMany({
      where: { runId: stop.runId, type: "agent.tool.completed" },
      select: { payload: true },
    });
    expect(toolEvents.map((e) => e.payload)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "background_task_cancel" })]),
    );
    console.info(
      `[bg latency] dispatch turn ${dispatchMs} ms; stop: main reply ${mainReplyMs} ms, worker cancelled ${workerStoppedMs} ms`,
    );
  }, 60_000);

  it("runs three tasks in parallel, stops one by name, and keeps chatting", async () => {
    const app = handles.app as App;
    const cookie = await signup(app, `bg3-${stamp}@rakazo.test`, "Bg3");
    const chief = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Main",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    await waitFor(async () => (await activeRuns([chief.id])) === 0);
    const send = async (text: string) => {
      const t = Date.now();
      const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
        botId: chief.id,
        text,
      });
      await waitFor(async () => terminal(sent.runId));
      return { ...sent, ms: Date.now() - t };
    };
    const turns = [];
    for (const name of ["image", "video", "code"]) {
      turns.push(await send(`dispatch in background as ${name}: work until i stop`));
    }
    const workers = await db.bot.findMany({
      where: { parentBotId: chief.id, spawnKey: { startsWith: "bg-worker:" } },
      select: { id: true, title: true },
    });
    // Worker titles carry the task ref ("image #REF"); the name part identifies the task.
    const taskNames = workers.map((w) => w.title.replace(/ #[A-Z0-9]{4,10}$/, ""));
    expect([...taskNames].sort()).toEqual(["code", "image", "video"]);
    const ids = Object.fromEntries(workers.map((w, i) => [taskNames[i], w.id]));
    await waitFor(async () => (await activeRuns(workers.map((w) => w.id))) === 3);

    const stop = await send("cancel background task named video");
    await waitFor(async () => (await activeRuns([ids.video!])) === 0);
    expect(await activeRuns([ids.image!, ids.code!])).toBe(2);
    const chat = await send("hello, how are you?");
    expect(await activeRuns([ids.image!, ids.code!])).toBe(2);

    // The main run only talked and dispatched: no work tool ever ran on it.
    const mainRuns = await db.run.findMany({ where: { botId: chief.id }, select: { id: true } });
    const called = await db.event.findMany({
      where: { runId: { in: mainRuns.map((r) => r.id) }, type: "agent.tool.called" },
      select: { payload: true },
    });
    const names = called.map((e) => (e.payload as { name?: string }).name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^(background_task.*|message_user)$/);
    for (const turn of [...turns, stop, chat]) expect(turn.ms).toBeLessThan(5_000);
    console.info(
      `[bg parallel] dispatch ${turns.map((t) => t.ms).join("/")} ms; stop one ${stop.ms} ms; chat ${chat.ms} ms`,
    );
    await rpc(app, cookie, "threads/send", {
      botId: chief.id,
      text: "cancel all background tasks",
    });
    await waitFor(async () => (await activeRuns(workers.map((w) => w.id))) === 0);
  }, 60_000);

  it("drops a task the user retracts a second later and confirms truthfully", async () => {
    const app = handles.app as App;
    const cookie = await signup(app, `bgr-${stamp}@rakazo.test`, "BgR");
    const chief = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Retract",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    await waitFor(async () => (await activeRuns([chief.id])) === 0);
    const first = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: chief.id,
      text: "dispatch in background as boy: work until i stop",
    });
    await new Promise((r) => setTimeout(r, 1_000));
    const t = Date.now();
    const second = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: chief.id,
      text: "cancel all background tasks",
    });
    await waitFor(async () => terminal(first.runId));
    await waitFor(async () => terminal(second.runId));
    const replyMs = Date.now() - t;
    const worker = await db.bot.findFirstOrThrow({
      where: { parentBotId: chief.id, spawnKey: { startsWith: "bg-worker:" } },
    });
    await waitFor(async () => (await activeRuns([worker.id])) === 0);
    const workerRun = await db.run.findFirstOrThrow({
      where: { botId: worker.id },
      orderBy: { createdAt: "desc" },
    });
    expect(workerRun.status).toBe("cancelled");
    // The stop went through the cancel tool, whose result names what was really stopped.
    const results = await db.event.findMany({
      where: { runId: second.runId, type: "agent.tool.completed" },
      select: { payload: true },
    });
    expect(results.map((r) => r.payload as { outcome?: string; name?: string })).toContainEqual(
      expect.objectContaining({ name: "background_task_cancel", outcome: "succeeded" }),
    );
    expect(replyMs).toBeLessThan(5_000);
    // Still responsive afterwards.
    const after = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: chief.id,
      text: "thanks",
    });
    await waitFor(async () => terminal(after.runId), 5_000);
    console.info(`[bg retract] stop reply ${replyMs} ms`);
  }, 60_000);

  async function activeRuns(botIds: string[]) {
    return db.run.count({
      where: { botId: { in: botIds }, status: { in: [...ACTIVE_RUN_STATUSES] } },
    });
  }
  async function terminal(runId: string) {
    const run = await db.run.findUnique({ where: { id: runId }, select: { status: true } });
    return Boolean(run && ["completed", "failed", "cancelled"].includes(run.status));
  }
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
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return discardBotIntroFromCreate(harness, cookie, proc, parsed.json as T);
}
