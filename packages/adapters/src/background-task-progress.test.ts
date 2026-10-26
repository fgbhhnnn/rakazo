import {
  formatTaskRunTime,
  TaskProgressBlockSchema,
  taskProgressCounts,
  taskProgressHeadline,
  taskProgressRunSeconds,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  latestStep,
  TASK_STUCK_MS,
  type TaskSnapshot,
  takeMilestones,
  taskProgressEntry,
} from "./background-task-progress.js";
import { WORKER_PROGRESS_NOTICE } from "./worker-progress.js";

const t0 = new Date("2026-10-25T15:00:00Z");
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
const STUCK = 10 * 60_000;
let seq = 0;
const ev = (type: string, payload: Record<string, unknown>, seconds: number) => ({
  seq: ++seq,
  type,
  payload,
  createdAt: at(seconds),
});
const line = (text: string, s: number) => ev("thread.progress", { text, activity: true }, s);
const called = (name: string, id: string, s: number) =>
  ev("agent.tool.called", { name, executionId: id }, s);
const completed = (name: string, id: string, s: number) =>
  ev("agent.tool.completed", { name, executionId: id, outcome: "completed" }, s);
const note = (text: string, s: number) =>
  ev(
    "thread.progress",
    { text: `Progress: ${text}`, activity: true, notice: WORKER_PROGRESS_NOTICE, note: text },
    s,
  );

function row(overrides: Partial<TaskSnapshot["row"]> = {}): TaskSnapshot["row"] {
  return {
    id: "row-1",
    ref: "TAB12CD3",
    name: "竞品调研",
    status: "started",
    args: {},
    error: null,
    createdAt: at(0),
    startedAt: at(5),
    finishedAt: null,
    workerBotId: "worker-1",
    workerRunId: "run-1",
    ...overrides,
  };
}
const runInfo = (status: string, extra: Partial<NonNullable<TaskSnapshot["run"]>> = {}) => ({
  status,
  error: null,
  completedAt: null,
  botOutcomeReturnedAt: null,
  ...extra,
});

describe("background task progress card entries", () => {
  it("shows a running task's open call as its latest step", () => {
    const events = [
      line("Searching the web: rakazo pricing", 10),
      called("web_search", "e1", 10),
      completed("web_search", "e1", 14),
      line("Reading https://example.com/pricing", 20),
      called("web_fetch", "e2", 20),
    ];
    const entry = taskProgressEntry(
      { row: row(), run: runInfo("running"), events, lastEventAt: at(20) },
      { now: at(60), stuckMs: STUCK },
    );
    expect(entry).toMatchObject({
      ref: "TAB12CD3",
      state: "running",
      lane: "computer",
      workerBotId: "worker-1",
      startedAt: at(5).toISOString(),
      step: "Reading https://example.com/pricing",
    });
    expect(entry.finishedAt).toBeUndefined();
    expect(TaskProgressBlockSchema.shape.tasks.element.parse(entry)).toEqual(entry);
  });

  it("shows continuing when the task was auto-continued after an incomplete final", () => {
    const entry = taskProgressEntry(
      {
        row: row({
          ref: "TIZS60WO",
          name: "按原版截图改布局",
          args: { incompleteContinues: 1, incompleteContinuing: true },
        }),
        run: runInfo("running"),
      },
      { now: at(60), stuckMs: STUCK },
    );
    expect(entry.state).toBe("continuing");
    expect(entry.step).toBeUndefined();
    expect(entry.finishedAt).toBeUndefined();
    expect(TaskProgressBlockSchema.shape.tasks.element.parse(entry).state).toBe("continuing");
  });

  it("keeps a real step while continuing when the worker has events", () => {
    const events = [line("Reading layout screenshot", 20), called("web_fetch", "e2", 20)];
    const entry = taskProgressEntry(
      {
        row: row({
          ref: "TIZS60WO",
          name: "按原版截图改布局",
          args: { incompleteContinues: 1, incompleteContinuing: true },
        }),
        run: runInfo("running"),
        events,
        lastEventAt: at(20),
      },
      { now: at(60), stuckMs: STUCK },
    );
    expect(entry.state).toBe("continuing");
    expect(entry.step).toBe("Reading layout screenshot");
  });

  it("prefers the worker's own note when it came after its last call", () => {
    const events = [
      line("Running: ./gradlew build", 10),
      called("shell", "e1", 10),
      completed("shell", "e1", 70),
      note("Build done; emulator booting (about 3 min)", 75),
    ];
    expect(latestStep(events, at(80))).toBe("Build done; emulator booting (about 3 min)");
    // A later call wins over an older note.
    const later = [...events, line("Running: adb install", 90), called("shell", "e2", 90)];
    expect(latestStep(later, at(95))).toBe("Running: adb install");
  });

  it("marks a running task stuck once it has been quiet past the threshold, and keeps when", () => {
    const quiet = { row: row(), run: runInfo("running"), events: [], lastEventAt: at(60) };
    expect(taskProgressEntry(quiet, { now: at(60 + 599), stuckMs: STUCK }).state).toBe("running");
    const stuck = taskProgressEntry(quiet, { now: at(60 + 600), stuckMs: STUCK });
    expect(stuck).toMatchObject({ state: "stuck", stuckSince: at(660).toISOString() });
    const later = taskProgressEntry(quiet, {
      now: at(2000),
      stuckMs: STUCK,
      prev: { ...stuck, notified: ["stuck"] },
    });
    expect(later).toMatchObject({ stuckSince: at(660).toISOString(), notified: ["stuck"] });
    // Activity again: no longer stuck, and a later stuck spell is reported again.
    const back = taskProgressEntry(
      { ...quiet, lastEventAt: at(1990) },
      { now: at(2000), stuckMs: STUCK, prev: later },
    );
    expect(back.state).toBe("running");
    expect(back.stuckSince).toBeUndefined();
    expect(back.notified).toBeUndefined();
  });

  it("never calls a task stuck while it waits on the user", () => {
    const entry = taskProgressEntry(
      {
        row: row(),
        run: runInfo("waiting_input"),
        lastBlocks: [{ kind: "ask", text: "允许打开 example.com 吗？", approvalEffectId: "fx" }],
        lastEventAt: at(10),
      },
      { now: at(5000), stuckMs: STUCK },
    );
    expect(entry).toMatchObject({ state: "needs_user", step: "允许打开 example.com 吗？" });
  });

  it("maps queued, finished, failed and cancelled rows", () => {
    const opts = { now: at(100), stuckMs: STUCK };
    expect(
      taskProgressEntry(
        { row: row({ status: "queued", startedAt: null, workerRunId: null }), position: 2 },
        opts,
      ),
    ).toMatchObject({ state: "queued", position: 2 });
    const done = taskProgressEntry(
      { row: row({ status: "completed", finishedAt: at(90) }), run: runInfo("completed") },
      opts,
    );
    expect(done).toMatchObject({ state: "done", finishedAt: at(90).toISOString() });
    expect(taskProgressRunSeconds(done, at(5000))).toBe(85);
    expect(
      taskProgressEntry(
        {
          row: row({
            status: "failed",
            error: "worker hand-off did not complete",
            finishedAt: at(50),
          }),
        },
        opts,
      ),
    ).toMatchObject({ state: "failed", step: "worker hand-off did not complete" });
    expect(
      taskProgressEntry({ row: row({ status: "cancelled", finishedAt: at(40) }) }, opts).state,
    ).toBe("cancelled");
    expect(
      taskProgressEntry({ row: row({ args: { lane: "think" } }), run: runInfo("running") }, opts)
        .lane,
    ).toBe("think");
  });

  it("says each milestone once: stuck, and a failure the main bot never heard about", () => {
    const snapshots = new Map<string, TaskSnapshot>([
      ["TSTUCK01", { row: row({ ref: "TSTUCK01" }), run: runInfo("running") }],
      [
        "TFAIL001",
        { row: row({ ref: "TFAIL001", status: "failed", workerRunId: null }), run: null },
      ],
      [
        "TFAIL002",
        {
          row: row({ ref: "TFAIL002", status: "failed" }),
          run: runInfo("failed", { botOutcomeReturnedAt: at(50) }),
        },
      ],
    ]);
    const entries = [
      {
        ref: "TSTUCK01",
        name: "导出报表",
        state: "stuck" as const,
        queuedAt: at(0).toISOString(),
        stuckSince: at(660).toISOString(),
        step: "Running: python export.py",
      },
      {
        ref: "TFAIL001",
        name: "发图",
        state: "failed" as const,
        queuedAt: at(0).toISOString(),
        step: "worker hand-off did not complete",
      },
      { ref: "TFAIL002", name: "写稿", state: "failed" as const, queuedAt: at(0).toISOString() },
    ];
    const first = takeMilestones(entries, snapshots, { now: at(660), stuckMs: STUCK });
    expect(first.lines).toHaveLength(2);
    expect(first.lines[0]).toContain("「导出报表 #TSTUCK01」已经约 10 分钟没有新进展");
    expect(first.lines[0]).toContain("Running: python export.py");
    expect(first.lines[1]).toContain(
      "「发图 #TFAIL001」没能完成：worker hand-off did not complete",
    );
    expect(first.entries.map((entry) => entry.notified)).toEqual([
      ["stuck"],
      ["failed"],
      undefined,
    ]);
    const again = takeMilestones(first.entries, snapshots, { now: at(900), stuckMs: STUCK });
    expect(again.lines).toEqual([]);
  });
});

describe("task progress helpers", () => {
  it("counts a task stuck after ten quiet minutes", () => {
    expect(TASK_STUCK_MS).toBe(10 * 60_000);
  });

  it("formats run time and counts", () => {
    expect(formatTaskRunTime(45)).toBe("45s");
    expect(formatTaskRunTime(12 * 60 + 5)).toBe("12m");
    expect(formatTaskRunTime(3900)).toBe("1h 05m");
    const block = {
      tasks: [
        { ref: "A", name: "a", state: "running" as const, queuedAt: "x" },
        { ref: "B", name: "b", state: "stuck" as const, queuedAt: "x" },
        { ref: "C", name: "c", state: "done" as const, queuedAt: "x" },
        { ref: "D", name: "d", state: "failed" as const, queuedAt: "x" },
      ],
    };
    expect(taskProgressCounts(block)).toEqual({ active: 2, done: 1, failed: 1, attention: 1 });
    expect(taskProgressHeadline(block)).toBe("后台任务进度：2 个进行中 · 1 个完成 · 1 个未完成");
  });
});
