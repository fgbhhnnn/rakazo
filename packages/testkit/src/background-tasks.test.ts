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

    // 2. Mid-task user message: a fresh main run starts (no steering into a busy run)
    //    and, being a stop request, cancels the worker.
    const t1 = Date.now();
    const stop = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: chief.id,
      text: "不做了",
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
