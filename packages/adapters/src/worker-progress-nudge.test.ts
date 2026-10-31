import { describe, expect, it } from "vitest";
import { PROGRESS_NUDGE_AFTER_MS, shouldNudgeWorkerProgress } from "./worker-progress-nudge.js";

describe("worker progress nudge", () => {
  it("waits about 45 minutes before nudging", () => {
    expect(PROGRESS_NUDGE_AFTER_MS).toBe(45 * 60_000);
  });

  it("nudges only long-running workers that never reported progress and were not nudged", () => {
    const now = new Date("2026-10-26T12:00:00Z");
    const old = new Date(now.getTime() - PROGRESS_NUDGE_AFTER_MS - 1_000);
    expect(
      shouldNudgeWorkerProgress({
        runStatus: "running",
        runCreatedAt: old,
        taskStartedAt: old,
        hasProgressNote: false,
        alreadyNudged: false,
        now,
        afterMs: PROGRESS_NUDGE_AFTER_MS,
      }),
    ).toBe(true);
  });

  it("skips when the run is too young, already reported, already nudged, or not active", () => {
    const now = new Date("2026-10-26T12:00:00Z");
    const old = new Date(now.getTime() - PROGRESS_NUDGE_AFTER_MS - 1_000);
    const young = new Date(now.getTime() - 60_000);
    expect(
      shouldNudgeWorkerProgress({
        runStatus: "running",
        runCreatedAt: young,
        taskStartedAt: young,
        hasProgressNote: false,
        alreadyNudged: false,
        now,
        afterMs: PROGRESS_NUDGE_AFTER_MS,
      }),
    ).toBe(false);
    expect(
      shouldNudgeWorkerProgress({
        runStatus: "running",
        runCreatedAt: old,
        taskStartedAt: old,
        hasProgressNote: true,
        alreadyNudged: false,
        now,
        afterMs: PROGRESS_NUDGE_AFTER_MS,
      }),
    ).toBe(false);
    expect(
      shouldNudgeWorkerProgress({
        runStatus: "running",
        runCreatedAt: old,
        taskStartedAt: old,
        hasProgressNote: false,
        alreadyNudged: true,
        now,
        afterMs: PROGRESS_NUDGE_AFTER_MS,
      }),
    ).toBe(false);
    expect(
      shouldNudgeWorkerProgress({
        runStatus: "completed",
        runCreatedAt: old,
        taskStartedAt: old,
        hasProgressNote: false,
        alreadyNudged: false,
        now,
        afterMs: PROGRESS_NUDGE_AFTER_MS,
      }),
    ).toBe(false);
  });
});
