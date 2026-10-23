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
process.env.RAKAZO_DISPATCHER_TURN_MAX_MS = "5000";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;
type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
let harness: BotIntroHarness | undefined;

describeIntegration("background task queue: soft max, FIFO overflow, auto-start", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let db: Awaited<ReturnType<typeof createApp>>["prisma"];
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-bgq-"));
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

  async function setup(label: string) {
    const app = handles.app as App;
    const cookie = await signup(app, `${label}-${stamp}@rakazo.test`, label);
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: label,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    await waitFor(async () => (await activeRuns([bot.id])) === 0);
    const send = (text: string) =>
      rpc<{ runId: string }>(app, cookie, "threads/send", { botId: bot.id, text });
    return { app, cookie, bot, send };
  }

  it("runs 4 of 6 tasks, queues 2, cancels a queued one and auto-starts the other", async () => {
    const { app, cookie, bot, send } = await setup("Queue");
    for (let i = 1; i <= 6; i += 1) {
      const sent = await send(`dispatch in background as t${i}: work for 6 seconds`);
      await waitFor(async () => terminal(sent.runId), 10_000);
    }
    const workers = await db.bot.findMany({
      where: { parentBotId: bot.id, spawnKey: { startsWith: "bg-worker:" } },
      select: { id: true },
    });
    expect(workers).toHaveLength(4);
    const queued = await db.backgroundTaskQueue.findMany({
      where: { botId: bot.id },
      orderBy: { createdAt: "asc" },
    });
    expect(queued.map((q) => [q.name, q.status])).toEqual([
      ["t5", "queued"],
      ["t6", "queued"],
    ]);
    // Hidden workers keep the main bot visibly busy while its own turn is over.
    const snap = await rpc<{
      run: { status: string } | null;
      backgroundTasks?: { running: number; queued: number };
    }>(app, cookie, "threads/get", { botId: bot.id });
    expect(snap.backgroundTasks).toEqual({ running: 4, queued: 2 });
    const roster = await rpc<Array<{ id: string; status: string }>>(app, cookie, "bots/list", {});
    expect(roster.find((row) => row.id === bot.id)?.status).toBe("running");
    expect(roster.some((row) => row.id !== bot.id && row.status === "running")).toBe(false);
    // The main bot's reply to a queued request says so with its position.
    const stopped = await send("cancel background task named t5");
    await waitFor(async () => terminal(stopped.runId), 10_000);
    await waitFor(async () => {
      const rows = await db.backgroundTaskQueue.findMany({ where: { botId: bot.id } });
      return rows.find((r) => r.name === "t5")?.status === "cancelled";
    });
    // When the first workers finish, their result wakes the main bot, which starts t6.
    await waitFor(async () => {
      const t6 = await db.backgroundTaskQueue.findFirst({ where: { botId: bot.id, name: "t6" } });
      return t6?.status === "started";
    }, 60_000);
    // The queued request was sent by a main run that ended long ago: the hand-off must still
    // reach a worker (it once failed with "source run is no longer active" and reverted).
    await waitFor(async () => {
      const t6 = await db.backgroundTaskQueue.findFirstOrThrow({
        where: { botId: bot.id, name: "t6" },
      });
      if (t6.status !== "started" || !t6.workerBotId) return false;
      const worker = await db.bot.findUniqueOrThrow({ where: { id: t6.workerBotId } });
      const runs = await db.run.count({
        where: { botId: worker.id, createdAt: { gte: t6.startedAt ?? new Date() } },
      });
      return worker.title === "t6" && runs > 0;
    }, 30_000);
    const t6Row = await db.backgroundTaskQueue.findFirstOrThrow({
      where: { botId: bot.id, name: "t6" },
    });
    expect(t6Row.status).toBe("started");
    const t5 = await db.backgroundTaskQueue.findFirstOrThrow({
      where: { botId: bot.id, name: "t5" },
    });
    expect(t5.status).toBe("cancelled");
    expect(t5.workerBotId).toBeNull();
  }, 120_000);

  async function relayMessages(botId: string) {
    const wakes = await db.run.findMany({
      where: { botId, trigger: "bot_message" },
      select: { id: true },
    });
    return db.message.findMany({
      where: { role: "bot", botId, runId: { in: wakes.map((r) => r.id) } },
      select: { id: true },
    });
  }
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
