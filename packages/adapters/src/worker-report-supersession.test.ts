import type { TaskProgressEntry } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  completedWorkerNeedsResult,
  suppressObsoleteFailureMilestones,
  suppressObsoleteWorkerReport,
} from "./worker-report-supersession.js";

function harness(
  options: {
    taskStatus?: string;
    runStatus?: string;
    replacement?: boolean;
    parentStatus?: string;
    movedOn?: boolean;
  } = {},
) {
  const task = {
    id: "old",
    spaceId: "space",
    userId: "user",
    botId: "运营",
    threadId: "group",
    taskHash: "same-work",
    name: "调研报告",
    runId: "parent",
    status: options.taskStatus ?? "started",
    createdAt: new Date(100),
  };
  const prisma = {
    backgroundTaskQueue: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(task)
        .mockResolvedValue(options.replacement ? { id: "new" } : null),
    },
    run: {
      findUnique: vi
        .fn()
        .mockResolvedValueOnce({ status: options.runStatus ?? "failed" })
        .mockResolvedValue({ status: options.parentStatus ?? "completed", createdAt: new Date(0) }),
      findFirst: vi.fn(async () => (options.movedOn ? { id: "new-human-turn" } : null)),
    },
  };
  return { prisma, task };
}

describe("obsolete background reports", () => {
  it.each(["调研", "运营"])(
    "also suppresses an obsolete %s progress-card failure notice",
    async (name) => {
      const { prisma } = harness({ replacement: true });
      const entry: TaskProgressEntry = {
        ref: "old",
        name,
        state: "failed",
        queuedAt: new Date(0).toISOString(),
      };
      const snapshots = new Map([["old", { row: { workerRunId: "worker-run" } }]]);
      const entries = await suppressObsoleteFailureMilestones(prisma as never, [entry], snapshots);
      expect(entries[0]?.notified).toEqual(["failed"]);
      expect(entry.notified).toBeUndefined();
      expect(await suppressObsoleteFailureMilestones(prisma as never, entries, snapshots)).toEqual(
        entries,
      );
      expect(prisma.backgroundTaskQueue.findFirst).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps current and unstarted-task failures and leaves running cards alone", async () => {
    const { prisma } = harness();
    const entries: TaskProgressEntry[] = [
      { ref: "current", name: "current", state: "failed", queuedAt: new Date(0).toISOString() },
      { ref: "unstarted", name: "unstarted", state: "failed", queuedAt: new Date(0).toISOString() },
      { ref: "running", name: "running", state: "running", queuedAt: new Date(0).toISOString() },
    ];
    const snapshots = new Map([["current", { row: { workerRunId: "worker-run" } }]]);
    expect(await suppressObsoleteFailureMilestones(prisma as never, entries, snapshots)).toEqual(
      entries,
    );
  });

  it("uses friendly, bounded failure text on cards for historical internal errors", async () => {
    const { prisma } = harness();
    const entries: TaskProgressEntry[] = [
      {
        ref: "task",
        name: "运营",
        state: "failed",
        queuedAt: new Date(0).toISOString(),
        step: `Internal server error${"x".repeat(140)}`,
      },
    ];
    const result = await suppressObsoleteFailureMilestones(prisma as never, entries, new Map());
    expect(result[0]?.step).not.toContain("Internal server error");
    expect(result[0]?.step).toContain("服务暂时繁忙");
    expect(result[0]?.step?.length).toBeLessThanOrEqual(160);
    expect(prisma.backgroundTaskQueue.findFirst).not.toHaveBeenCalled();
  });

  it("keeps reconciliation open for a completed run with an outstanding result", async () => {
    const { prisma } = harness({ runStatus: "completed" });
    expect(await completedWorkerNeedsResult(prisma as never, "worker-run")).toBe(true);
    prisma.run.findUnique.mockResolvedValue({ status: "failed" });
    expect(await completedWorkerNeedsResult(prisma as never, "worker-run")).toBe(false);
    prisma.run.findUnique.mockResolvedValue({
      status: "completed",
      botOutcomeReturnedAt: new Date(),
    });
    expect(await completedWorkerNeedsResult(prisma as never, "worker-run")).toBe(false);
  });
  it("keeps a current failure after an ordinary completed dispatch turn", async () => {
    const { prisma } = harness();
    expect(await suppressObsoleteWorkerReport(prisma as never, "worker-run", "failure")).toBe(
      false,
    );
  });
  it.each(["failure", "undelivered"] as const)("suppresses a replaced task's %s", async (kind) => {
    const { prisma, task } = harness({ replacement: true });
    expect(await suppressObsoleteWorkerReport(prisma as never, "worker-run", kind)).toBe(true);
    expect(prisma.backgroundTaskQueue.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "group",
          spaceId: "space",
          userId: "user",
          AND: [
            {
              OR: [
                {
                  botId: "运营",
                  taskHash: task.taskHash,
                  status: { in: ["queued", "claiming", "started", "completed"] },
                },
                { name: task.name, status: "completed" },
              ],
            },
          ],
        }),
      }),
    );
  });
  it.each(["cancelled", "failed"])(
    "suppresses failures after the parent is %s",
    async (parentStatus) => {
      const { prisma } = harness({ parentStatus });
      expect(await suppressObsoleteWorkerReport(prisma as never, "worker-run", "failure")).toBe(
        true,
      );
    },
  );
  it("suppresses reports after a newer human turn, and cancelled tasks", async () => {
    const moved = harness({ movedOn: true });
    expect(
      await suppressObsoleteWorkerReport(moved.prisma as never, "worker-run", "undelivered"),
    ).toBe(true);
    const cancelled = harness({ taskStatus: "cancelled" });
    expect(
      await suppressObsoleteWorkerReport(cancelled.prisma as never, "worker-run", "result"),
    ).toBe(true);
  });
  it.each([{ runStatus: "completed" }, { taskStatus: "completed" }])(
    "never reports finished work as failed: %j",
    async (options) => {
      const { prisma } = harness(options);
      expect(await suppressObsoleteWorkerReport(prisma as never, "worker-run", "failure")).toBe(
        true,
      );
    },
  );
  it("keeps successful results and genuine undelivered notices", async () => {
    const result = harness({ replacement: true, runStatus: "completed" });
    expect(await suppressObsoleteWorkerReport(result.prisma as never, "worker-run", "result")).toBe(
      false,
    );
    const notice = harness({ runStatus: "completed", taskStatus: "completed" });
    expect(
      await suppressObsoleteWorkerReport(notice.prisma as never, "worker-run", "undelivered"),
    ).toBe(false);
    const status = harness({ runStatus: "completed", taskStatus: "completed" });
    expect(await suppressObsoleteWorkerReport(status.prisma as never, "worker-run", "status")).toBe(
      false,
    );
  });
  it("does not apply background policy to untracked bot messages", async () => {
    const { prisma } = harness();
    prisma.backgroundTaskQueue.findFirst.mockReset().mockResolvedValue(null);
    expect(await suppressObsoleteWorkerReport(prisma as never, "ordinary-run", "failure")).toBe(
      false,
    );
  });
});
