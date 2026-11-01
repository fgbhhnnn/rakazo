import { describe, expect, it, vi } from "vitest";
import { groupBackgroundTasks } from "./group-background-tasks.js";
import { threadSnapshot } from "./thread-target.js";

describe("group background work", () => {
  it("includes background work in threads/get's snapshot when all foreground runs are idle", async () => {
    const tx = {
      $queryRaw: async () => [],
      message: { findMany: async () => [] },
      event: { findFirst: async () => null },
      run: { findMany: async () => [] },
    };
    const prisma = {
      $transaction: async (callback: (value: typeof tx) => unknown) => callback(tx),
      backgroundTaskQueue: { groupBy: async () => [{ status: "started", _count: { _all: 1 } }] },
    };
    const snapshot = await threadSnapshot({ prisma: prisma as never }, {
      kind: "group",
      groupId: "group",
      groupName: "team",
      threadId: "thread",
      members: [
        { botId: "research", name: "调研" },
        { botId: "operations", name: "运营" },
      ],
    } as never);
    expect(snapshot.backgroundTasks).toEqual({ running: 1, queued: 0 });
    expect(snapshot.activeRuns).toEqual([]);
    expect(snapshot.run).toBeNull();
  });
  it("includes think and computer tasks for research and operations members in their origin group", async () => {
    const groupBy = vi.fn(async () => [
      { status: "queued", _count: { _all: 2 } },
      { status: "claiming", _count: { _all: 1 } },
      { status: "started", _count: { _all: 3 } },
    ]);
    expect(
      await groupBackgroundTasks({ backgroundTaskQueue: { groupBy } } as never, "group-thread", [
        { botId: "调研" },
        { botId: "运营" },
      ]),
    ).toEqual({ running: 4, queued: 2 });
    expect(groupBy).toHaveBeenCalledWith({
      by: ["status"],
      where: {
        threadId: "group-thread",
        botId: { in: ["调研", "运营"] },
        status: { in: ["queued", "claiming", "started"] },
      },
      _count: { _all: true },
    });
  });
  it("returns zero when no background work remains", async () => {
    expect(
      await groupBackgroundTasks(
        { backgroundTaskQueue: { groupBy: async () => [] } } as never,
        "empty",
        [],
      ),
    ).toEqual({ running: 0, queued: 0 });
  });
});
