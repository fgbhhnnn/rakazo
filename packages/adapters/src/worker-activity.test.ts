import { describe, expect, it } from "vitest";
import { activitySummary, summarizeWorkerActivity, workerActivity } from "./worker-activity.js";
import { WORKER_PROGRESS_NOTICE } from "./worker-progress.js";

const t0 = new Date("2026-10-25T01:00:00Z");
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
let seq = 0;
const ev = (type: string, payload: Record<string, unknown>, seconds: number) => ({
  seq: ++seq,
  type,
  payload,
  createdAt: at(seconds),
});
const line = (text: string, s: number) => ev("thread.progress", { text, activity: true }, s);
const called = (name: string, executionId: string, s: number) =>
  ev("agent.tool.called", { name, executionId }, s);
const completed = (
  name: string,
  executionId: string,
  s: number,
  outcome = "completed",
  durationMs?: number,
) =>
  ev(
    "agent.tool.completed",
    { name, executionId, outcome, ...(durationMs !== undefined ? { durationMs } : {}) },
    s,
  );

describe("worker activity", () => {
  it("pairs each call with its activity line, outcome and duration, and shows the open call", () => {
    const events = [
      line("Running: ls ./jobs", 0),
      called("shell", "e1", 0),
      completed("shell", "e1", 2, "completed", 1800),
      ev("thread.progress", { text: "narration", activity: false }, 3),
      line("Running: ./gradlew assembleDebug", 10),
      called("shell", "e2", 10),
      completed("shell", "e2", 70, "failed", 60_000),
      line("Reading build.log", 71),
      called("read_file", "e3", 71),
      completed("read_file", "e3", 72),
      line("Running: emulator -avd test", 80),
      called("shell", "e4", 80),
    ];
    const result = summarizeWorkerActivity([...events].reverse(), {
      now: at(380),
      timeZone: "Asia/Shanghai",
    });
    expect(
      result.recent_activity.map((entry) => [entry.tool, entry.summary, entry.outcome]),
    ).toEqual([
      ["shell", "Running: ls ./jobs", "completed"],
      ["shell", "Running: ./gradlew assembleDebug", "failed"],
      ["read_file", "Reading build.log", "completed"],
      ["shell", "Running: emulator -avd test", "running"],
    ]);
    expect(result.recent_activity.map((entry) => entry.duration_s)).toEqual([2, 60, 1, undefined]);
    expect(result.recent_activity[0]?.at).toContain("(UTC+08:00)");
    expect(result.current_call).toEqual({
      tool: "shell",
      summary: "Running: emulator -avd test",
      started_at: expect.stringContaining("(UTC+08:00)"),
      running_for_s: 300,
    });
  });

  it("keeps parallel calls apart and skips notes and stray lines", () => {
    const events = [
      line("Searching web: rakazo", 0),
      line("Fetching https://example.com", 0),
      called("web_search", "p1", 0),
      called("web_fetch", "p2", 0),
      completed("web_fetch", "p2", 3),
      completed("web_search", "p1", 4),
      line("leftover line with no call", 5),
      completed("shell", "unknown", 6),
      ev(
        "thread.progress",
        { text: "Progress: built", activity: true, notice: WORKER_PROGRESS_NOTICE, note: "built" },
        7,
      ),
      called("shell", "s1", 9),
      completed("shell", "s1", 10),
    ];
    const result = summarizeWorkerActivity(events, { now: at(20) });
    expect(result.recent_activity.map((entry) => [entry.tool, entry.summary ?? null])).toEqual([
      ["web_search", "Searching web: rakazo"],
      ["web_fetch", "Fetching https://example.com"],
      ["shell", null],
    ]);
    expect(result.current_call).toBeUndefined();
  });

  it("lists only the last calls", () => {
    const events = Array.from({ length: 10 }, (_, index) => [
      line(`step ${index}`, index * 10),
      called("shell", `x${index}`, index * 10),
      completed("shell", `x${index}`, index * 10 + 1),
    ]).flat();
    const result = summarizeWorkerActivity(events, { now: at(200) });
    expect(result.recent_activity).toHaveLength(6);
    expect(result.recent_activity.map((entry) => entry.summary)).toEqual([
      "step 4",
      "step 5",
      "step 6",
      "step 7",
      "step 8",
      "step 9",
    ]);
    expect(
      summarizeWorkerActivity(events, { now: at(200), limit: 2 }).recent_activity,
    ).toHaveLength(2);
  });

  it("redacts and caps activity lines", () => {
    const summary = activitySummary(
      `Running: curl -H "Authorization: Bearer sk-live-abcdef123456" ${"a".repeat(300)}`,
    );
    expect(summary).not.toContain("sk-live-abcdef123456");
    expect(summary).toHaveLength(160);
    expect(activitySummary("  mail\nops@example.com  ")).toBe("mail [Redacted]");
    expect(activitySummary("   ")).toBeUndefined();
  });

  it("reads one run's events with the latest note and last event time", async () => {
    const events = [
      line("Running: make", 0),
      called("shell", "m1", 0),
      completed("shell", "m1", 5),
    ];
    const queries: unknown[] = [];
    const prisma = {
      event: {
        findMany: async (query: unknown) => {
          queries.push(query);
          return [...events].reverse();
        },
        findFirst: async (query: { where: Record<string, unknown> }) => {
          queries.push(query);
          return query.where.payload
            ? { payload: { note: "make done", notice: WORKER_PROGRESS_NOTICE }, createdAt: at(6) }
            : { createdAt: at(9) };
        },
      },
    };
    const activity = await workerActivity(prisma as never, "run-9", { now: at(30) });
    expect(activity.recent_activity).toEqual([
      {
        tool: "shell",
        summary: "Running: make",
        outcome: "completed",
        duration_s: 5,
        at: expect.any(String),
      },
    ]);
    expect(activity.current_call).toBeUndefined();
    expect(activity.last_event_at).toBe("2026-10-25T01:00:09 (UTC)");
    expect(activity.progress_note).toEqual({ text: "make done", at: expect.any(String) });
    expect(queries).toContainEqual(
      expect.objectContaining({
        where: {
          runId: "run-9",
          type: "thread.progress",
          payload: { path: ["notice"], equals: WORKER_PROGRESS_NOTICE },
        },
      }),
    );
  });
});
