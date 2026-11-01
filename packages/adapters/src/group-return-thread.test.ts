import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { messageBot } from "./bot-messages.js";
import { workerResultGroupThreadId } from "./group-return-thread.js";

const workerRun = { id: "worker-run", spaceId: "s", userId: "u" };
const worker = { id: "worker", spawnKey: "bg-worker:dispatcher:1" };

function prisma(task: { threadId: string } | null, groupThread: { id: string } | null) {
  return {
    backgroundTaskQueue: { findFirst: vi.fn(async () => task) },
    thread: { findFirst: vi.fn(async () => groupThread) },
  };
}

describe("workerResultGroupThreadId", () => {
  it("returns the group thread a worker's task was started from", async () => {
    const db = prisma({ threadId: "group-thread" }, { id: "group-thread" });
    await expect(
      workerResultGroupThreadId(db as never, {
        run: workerRun,
        sender: worker,
        targetBotId: "dispatcher",
        intent: "result",
      }),
    ).resolves.toBe("group-thread");
    expect(db.backgroundTaskQueue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workerRunId: "worker-run", botId: "dispatcher", spaceId: "s", userId: "u" },
      }),
    );
    expect(db.thread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "group-thread",
          group: {
            spaceId: "s",
            userId: "u",
            archivedAt: null,
            members: { some: { botId: "dispatcher", bot: { archivedAt: null } } },
          },
        },
      }),
    );
  });

  it("returns failures (status) to the group too", async () => {
    const db = prisma({ threadId: "group-thread" }, { id: "group-thread" });
    await expect(
      workerResultGroupThreadId(db as never, {
        run: workerRun,
        sender: worker,
        targetBotId: "dispatcher",
        intent: "status",
      }),
    ).resolves.toBe("group-thread");
  });

  it("keeps the private chat for non-workers, requests, DM tasks and gone groups", async () => {
    const group = prisma({ threadId: "group-thread" }, { id: "group-thread" });
    const base = { run: workerRun, targetBotId: "dispatcher" };
    await expect(
      workerResultGroupThreadId(group as never, {
        ...base,
        sender: { id: "bot", spawnKey: null },
        intent: "result",
      }),
    ).resolves.toBeUndefined();
    await expect(
      workerResultGroupThreadId(group as never, { ...base, sender: worker, intent: "request" }),
    ).resolves.toBeUndefined();
    expect(group.backgroundTaskQueue.findFirst).not.toHaveBeenCalled();
    await expect(
      workerResultGroupThreadId(prisma(null, null) as never, {
        ...base,
        sender: worker,
        intent: "result",
      }),
    ).resolves.toBeUndefined();
    await expect(
      workerResultGroupThreadId(prisma({ threadId: "dm-thread" }, null) as never, {
        ...base,
        sender: worker,
        intent: "result",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("worker result delivery", () => {
  function harness(groupThread: { id: string } | null) {
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "thread" }]),
      run: {
        findFirst: vi.fn(async () => ({ id: "worker-run" })),
        findUnique: vi.fn(async () => ({ status: "completed" })),
        create: vi.fn(async () => ({ id: "relay-run" })),
      },
      bot: { findFirst: vi.fn(async () => ({ id: "dispatcher" })) },
      task: { create: vi.fn(async () => ({ id: "task" })) },
      message: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: "m", seq: 1 })),
        update: vi.fn(async () => ({})),
      },
      event: { create: vi.fn(async () => ({ seq: 3 })) },
      thread: { update: vi.fn(async () => ({})) },
    };
    const db = {
      bot: {
        findMany: vi.fn(async () => [
          {
            id: "dispatcher",
            name: "团队-后端",
            title: "",
            spawnKey: null,
            thread: { id: "dispatcher-dm" },
          },
          { id: "worker", name: "后台1", title: "", spawnKey: worker.spawnKey, thread: null },
        ]),
      },
      message: { findUnique: vi.fn(async () => null) },
      backgroundTaskQueue: { findFirst: vi.fn(async () => ({ threadId: "group-thread" })) },
      thread: { findFirst: vi.fn(async () => groupThread) },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaClient;
    return {
      tx,
      deps: {
        prisma: db,
        events: { notify: vi.fn(async () => undefined) },
        jobs: { enqueue: vi.fn(async () => undefined) },
      },
    };
  }
  const run = {
    id: "worker-run",
    spaceId: "s",
    threadId: "worker-thread",
    botId: "worker",
    userId: "u",
    sourceMessageId: null,
  };

  it("wakes the dispatcher's relay in the group the task came from", async () => {
    const h = harness({ id: "group-thread" });
    await expect(
      messageBot(
        h.deps as never,
        run,
        { id: "worker", name: "后台1" },
        { bot_id: "dispatcher", message: "接口完成", intent: "result" },
        { allowTerminalSource: true },
      ),
    ).resolves.toMatchObject({ ok: true, runId: "relay-run" });
    expect(h.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ threadId: "group-thread", trigger: "bot_message" }),
      }),
    );
    expect(h.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "group-thread" }) }),
    );
  });

  it("falls back to the dispatcher's own chat when the group is gone", async () => {
    const h = harness(null);
    await messageBot(
      h.deps as never,
      run,
      { id: "worker", name: "后台1" },
      { bot_id: "dispatcher", message: "接口完成", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(h.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "dispatcher-dm" }) }),
    );
  });
});

describe("undelivered worker result notice", () => {
  const row = {
    spaceId: "s",
    userId: "u",
    botId: "dispatcher",
    threadId: "group-thread",
    name: "接口重构",
    workerRunId: "worker-run",
  };
  function db(groupThread: { id: string } | null, existing: unknown = null) {
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "group-thread" }]),
      message: {
        findUnique: vi.fn(async () => existing),
        create: vi.fn(async () => ({ id: "notice", seq: 1 })),
      },
      event: { create: vi.fn(async () => ({ seq: 9 })) },
      thread: { update: vi.fn(async () => ({})) },
    };
    return {
      tx,
      prisma: {
        thread: { findFirst: vi.fn(async () => groupThread) },
        $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      },
    };
  }

  it("posts one visible give-up line in the origin group, waking nobody", async () => {
    const { noticeUndeliveredWorkerResult } = await import("./group-return-thread.js");
    const h = db({ id: "group-thread" });
    const notify = vi.fn(async () => undefined);
    await noticeUndeliveredWorkerResult(
      { prisma: h.prisma as never, events: { notify } as never },
      row,
    );
    expect(h.tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "group-thread",
          clientNonce: "group-notice:undelivered:worker-run",
          blocks: [
            {
              kind: "text",
              text: "「接口重构」已结束，但结果多次重试后仍未能送达，请打开任务卡查看，或让我重新汇报。",
            },
          ],
        }),
      }),
    );
    expect(notify).toHaveBeenCalledWith("group-thread", 9);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("is idempotent and skips private-chat tasks", async () => {
    const { noticeUndeliveredWorkerResult } = await import("./group-return-thread.js");
    const replay = db({ id: "group-thread" }, { id: "notice" });
    await noticeUndeliveredWorkerResult({ prisma: replay.prisma as never }, row);
    expect(replay.tx.message.create).not.toHaveBeenCalled();
    const dm = db(null);
    await noticeUndeliveredWorkerResult({ prisma: dm.prisma as never }, row);
    expect(dm.prisma.$transaction).not.toHaveBeenCalled();
  });
});
