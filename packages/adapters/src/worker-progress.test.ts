import { BUILTIN_TOOL_NAMES } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { BACKGROUND_AGENT_PROFILES, WORKER_INSTRUCTIONS } from "./background-tasks.js";
import { builtinAgentTools } from "./builtin-tools.js";
import { applyDispatcherToolPolicy } from "./dispatcher-mode.js";
import {
  progressNoteText,
  REPORT_PROGRESS_TOOL,
  reportWorkerProgress,
  WORKER_PROGRESS_INSTRUCTION,
  WORKER_PROGRESS_MAX_CHARS,
  WORKER_PROGRESS_MIN_INTERVAL_MS,
  WORKER_PROGRESS_NOTICE,
  withholdWorkerOnlyTools,
} from "./worker-progress.js";
import { workerDisabledTools, workerToolSurface } from "./worker-tool-policy.js";

const worker = { id: "worker-1", spawnKey: "bg-worker:main-bot:1", disabledBuiltinTools: [] };
const mainBot = { id: "main-1", spawnKey: null, disabledBuiltinTools: [] };
const run = { id: "run-1", spaceId: "space-1" };

interface StoredEvent {
  runId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  seq: number;
}

/** An event table that answers the one query reportWorkerProgress makes. */
function fakeStore(clock: { now: Date }) {
  const rows: StoredEvent[] = [];
  const appended: Record<string, unknown>[] = [];
  const prisma = {
    event: {
      findFirst: async (query: {
        where: { runId: string; type: string; payload: { path: string[]; equals: string } };
      }) => {
        const { runId, type, payload } = query.where;
        const hits = rows
          .filter(
            (row) =>
              row.runId === runId &&
              row.type === type &&
              row.payload[payload.path[0] as string] === payload.equals,
          )
          .sort((a, b) => b.seq - a.seq);
        return hits[0] ? { createdAt: hits[0].createdAt } : null;
      },
    },
  };
  const events = {
    append: async (input: Record<string, unknown>) => {
      appended.push(input);
      rows.push({
        runId: String(input.runId),
        type: String(input.type),
        payload: input.payload as Record<string, unknown>,
        createdAt: clock.now,
        seq: rows.length + 1,
      });
      return input as never;
    },
  };
  return { prisma: prisma as never, events: events as never, appended };
}

describe("report_progress", () => {
  it("is registered once as a builtin and in the contract name list", () => {
    expect(builtinAgentTools.filter((tool) => tool.name === REPORT_PROGRESS_TOOL)).toHaveLength(1);
    expect(BUILTIN_TOOL_NAMES).toContain(REPORT_PROGRESS_TOOL);
    const tool = builtinAgentTools.find((entry) => entry.name === REPORT_PROGRESS_TOOL);
    expect(tool?.inputSchema).toMatchObject({ required: ["text"] });
    expect(tool?.description).toContain("the user is not notified");
  });

  it("is offered to hidden workers only, never to the main bot or a regular bot", () => {
    const workerDisabled = new Set<string>();
    withholdWorkerOnlyTools(worker, workerDisabled);
    expect(workerDisabled.has(REPORT_PROGRESS_TOOL)).toBe(false);

    const mainDisabled = new Set<string>();
    withholdWorkerOnlyTools(mainBot, mainDisabled);
    expect([...mainDisabled]).toEqual([REPORT_PROGRESS_TOOL]);

    const offered = [{ name: "shell" }, { name: REPORT_PROGRESS_TOOL }];
    for (const dispatcherMode of [false, true]) {
      const disabled = new Set<string>();
      applyDispatcherToolPolicy(dispatcherMode, mainBot, disabled, offered);
      expect(disabled.has(REPORT_PROGRESS_TOOL)).toBe(true);
      const workerSet = new Set<string>();
      applyDispatcherToolPolicy(dispatcherMode, worker, workerSet, offered);
      expect(workerSet.has(REPORT_PROGRESS_TOOL)).toBe(false);
    }
  });

  it("survives every worker profile's tool allowlist", () => {
    const names = builtinAgentTools.map((tool) => tool.name);
    for (const profile of Object.values(BACKGROUND_AGENT_PROFILES)) {
      expect(workerToolSurface(names, profile.tools)).toContain(REPORT_PROGRESS_TOOL);
    }
    expect(workerDisabledTools(names, ["shell"])).not.toContain(REPORT_PROGRESS_TOOL);
    expect(workerToolSurface(names, ["shell"]).sort()).toEqual(
      ["shell", REPORT_PROGRESS_TOOL].sort(),
    );
  });

  it("is in the worker instructions as a milestones-only line", () => {
    expect(WORKER_INSTRUCTIONS).toContain(WORKER_PROGRESS_INSTRUCTION);
    expect(WORKER_PROGRESS_INSTRUCTION).toContain("report_progress");
    expect(WORKER_PROGRESS_INSTRUCTION).toContain("不要每一步都报");
    expect(WORKER_INSTRUCTIONS).not.toContain("主 bot 和用户看不到你的中间过程");
  });

  it("cleans, redacts and caps the note", () => {
    expect(progressNoteText("  build\n done \t ok ")).toBe("build done ok");
    const redacted = progressNoteText(
      "logged in as ops@example.com with token=abc123def and key hunter2-secret",
      ["hunter2-secret"],
    );
    expect(redacted).not.toContain("ops@example.com");
    expect(redacted).not.toContain("abc123def");
    expect(redacted).not.toContain("hunter2-secret");
    const long = progressNoteText("x".repeat(1000));
    expect(long).toHaveLength(WORKER_PROGRESS_MAX_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("saves a note as a tagged progress event in the worker's own thread", async () => {
    const clock = { now: new Date("2026-10-25T01:00:00Z") };
    const store = fakeStore(clock);
    const result = await reportWorkerProgress(store, {
      run,
      threadId: "worker-thread",
      bot: worker,
      args: { text: "APK built; booting emulator" },
      now: () => clock.now,
    });
    expect(result).toMatchObject({ ok: true });
    expect(String(result.note)).toContain("the user is not notified");
    expect(store.appended).toEqual([
      {
        spaceId: "space-1",
        threadId: "worker-thread",
        botId: "worker-1",
        runId: "run-1",
        type: "thread.progress",
        payload: {
          text: "Progress: APK built; booting emulator",
          activity: true,
          notice: WORKER_PROGRESS_NOTICE,
          note: "APK built; booting emulator",
        },
      },
    ]);
  });

  it("answers a too-early note gently and saves nothing", async () => {
    const clock = { now: new Date("2026-10-25T01:00:00Z") };
    const store = fakeStore(clock);
    const input = { run, threadId: "t", bot: worker, now: () => clock.now };
    await reportWorkerProgress(store, { ...input, args: { text: "first" } });
    clock.now = new Date(clock.now.getTime() + 30_000);
    const early = await reportWorkerProgress(store, { ...input, args: { text: "second" } });
    expect(early).toEqual({
      ok: false,
      too_soon: true,
      retry_after_s: (WORKER_PROGRESS_MIN_INTERVAL_MS - 30_000) / 1000,
      note: expect.stringContaining("Keep working"),
    });
    expect(early).not.toHaveProperty("error");
    expect(store.appended).toHaveLength(1);

    clock.now = new Date(clock.now.getTime() + WORKER_PROGRESS_MIN_INTERVAL_MS);
    const later = await reportWorkerProgress(store, { ...input, args: { text: "third" } });
    expect(later).toMatchObject({ ok: true });
    expect(store.appended.map((entry) => (entry.payload as { note: string }).note)).toEqual([
      "first",
      "third",
    ]);
  });

  it("lets only one of two parallel notes through", async () => {
    const clock = { now: new Date("2026-10-25T01:00:00Z") };
    const store = fakeStore(clock);
    const input = { run, threadId: "t", bot: worker, now: () => clock.now };
    const results = await Promise.all([
      reportWorkerProgress(store, { ...input, args: { text: "a" } }),
      reportWorkerProgress(store, { ...input, args: { text: "b" } }),
    ]);
    expect(results.filter((result) => result.ok === true)).toHaveLength(1);
    expect(results.filter((result) => result.too_soon === true)).toHaveLength(1);
    expect(store.appended).toHaveLength(1);
  });

  it("refuses the main bot and empty notes without saving", async () => {
    const clock = { now: new Date("2026-10-25T01:00:00Z") };
    const store = fakeStore(clock);
    expect(
      await reportWorkerProgress(store, { run, threadId: "t", bot: mainBot, args: { text: "hi" } }),
    ).toEqual({ error: "report_progress is only for background workers." });
    expect(
      await reportWorkerProgress(store, { run, threadId: "t", bot: worker, args: { text: "  " } }),
    ).toMatchObject({ error: expect.stringContaining("text is required") });
    expect(store.appended).toHaveLength(0);
  });
});
