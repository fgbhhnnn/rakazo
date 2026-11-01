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

describeIntegration("dispatcher main turns: relay, priority, watchdog, failures", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let db: Awaited<ReturnType<typeof createApp>>["prisma"];
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-dispatch-"));
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

  it("relays every worker result to the user's thread exactly once, even mid-chat", async () => {
    const { bot, send } = await setup("Relay");
    const dispatched = await send("dispatch in background as quick: work for 2 seconds");
    await waitFor(async () => terminal(dispatched.runId));
    // The user keeps chatting while the worker runs and finishes.
    const chats = [];
    for (let i = 0; i < 3; i += 1) {
      const t = Date.now();
      const chat = await send(`just chatting ${i}`);
      await waitFor(async () => terminal(chat.runId), 5_000);
      chats.push(Date.now() - t);
      await new Promise((r) => setTimeout(r, 700));
    }
    const worker = await db.bot.findFirstOrThrow({
      where: { parentBotId: bot.id, spawnKey: { startsWith: "bg-worker:" } },
      select: { id: true },
    });
    const workerRun = await db.run.findFirstOrThrow({
      where: { botId: worker.id },
      orderBy: { createdAt: "desc" },
    });
    await waitFor(async () => terminal(workerRun.id));
    const finishedAt = Date.now();
    let relays: Array<{ id: string }> = [];
    await waitFor(async () => {
      relays = await relayMessages(bot.id);
      return relays.length > 0;
    }, 15_000);
    const relayMs = Date.now() - finishedAt;
    // Settle, then make sure nothing posted the relay twice.
    await waitFor(async () => (await activeRuns([bot.id, worker.id])) === 0);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await relayMessages(bot.id)).toHaveLength(1);
    const thread = await db.thread.findFirstOrThrow({
      where: { botId: bot.id, groupId: null },
      select: { id: true },
    });
    const relay = await db.message.findUniqueOrThrow({ where: { id: relays[0]!.id } });
    expect(relay.threadId).toBe(thread.id);
    expect(relayMs).toBeLessThan(10_000);
    for (const ms of chats) expect(ms).toBeLessThan(5_000);
    console.info(`[relay] chat ${chats.join("/")} ms; relay ${relayMs} ms after worker finished`);
  }, 60_000);

  it("answers at once while the shared computer is suspending", async () => {
    const { bot, send } = await setup("Suspend");
    const row = await db.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { computerId: true },
    });
    expect(row.computerId).toBeTruthy();
    await db.computer.update({
      where: { id: row.computerId! },
      data: { state: "suspending", updatedAt: new Date() },
    });
    const t = Date.now();
    // The main turn only talks and dispatches; the worker is the one that waits for the computer.
    const sent = await send("dispatch in background as later: work for 1 seconds");
    await waitFor(async () => terminal(sent.runId), 5_000);
    const run = await db.run.findUniqueOrThrow({ where: { id: sent.runId } });
    expect(run.status).toBe("completed");
    const computer = await db.computer.findUniqueOrThrow({ where: { id: row.computerId! } });
    expect(computer.state).toBe("suspending");
    console.info(`[suspending] reply ${Date.now() - t} ms`);
  }, 30_000);

  it("restarts a hung main turn at most twice, then says so truthfully", async () => {
    const { bot, send } = await setup("Hung");
    const sent = await send("hang until stopped");
    await waitFor(async () => {
      const runs = await db.run.findMany({ where: { botId: bot.id, trigger: "user" } });
      return runs.length === 3 && runs.every((r) => r.status === "failed");
    }, 40_000);
    const chain = await db.run.findMany({
      where: { botId: bot.id, trigger: "user" },
      orderBy: { createdAt: "asc" },
      select: { id: true, retryOfRunId: true },
    });
    expect(chain[0]!.id).toBe(sent.runId);
    expect(chain[1]!.retryOfRunId).toBe(chain[0]!.id);
    expect(chain[2]!.retryOfRunId).toBe(chain[1]!.id);
    await waitFor(async () =>
      Boolean(
        await db.message.findFirst({ where: { role: "bot", botId: bot.id, runId: chain[2]!.id } }),
      ),
    );
    const notices = await db.message.findMany({
      where: { role: "bot", botId: bot.id, runId: { in: chain.map((r) => r.id) } },
      select: { blocks: true },
    });
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0]!.blocks)).toContain("回复超时");
    // Still answers the next message.
    const next = await send("hello again");
    await waitFor(async () => terminal(next.runId), 5_000);
  }, 60_000);

  it("posts a truthful error when the model call fails", async () => {
    const { bot, send } = await setup("Fails");
    const sent = await send("please fail this run");
    await waitFor(async () => terminal(sent.runId));
    const run = await db.run.findUniqueOrThrow({ where: { id: sent.runId } });
    expect(run.status).toBe("failed");
    await waitFor(async () =>
      Boolean(await db.message.findFirst({ where: { role: "bot", botId: bot.id, runId: run.id } })),
    );
    const notice = await db.message.findFirstOrThrow({
      where: { role: "bot", botId: bot.id, runId: run.id },
    });
    expect(JSON.stringify(notice.blocks)).toContain("这次回复失败了");
    expect(JSON.stringify(notice.blocks)).toContain("Scripted run failure");
  }, 30_000);

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
