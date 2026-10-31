import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleIncompleteWorkerResult,
  withTruncatedOutputPrefix,
} from "./worker-incomplete-continue.js";
import { MAX_INCOMPLETE_CONTINUES } from "./worker-incomplete-result.js";
import { INCOMPLETE_LAST_SIGNATURE_KEY, resultSignature } from "./worker-result-repeat.js";
import { INCOMPLETE_TRUNCATED_PREFIX_KEY } from "./worker-truncated-output.js";

const TIZS60WO = `首页两段和网页样式都已上传。我先把能独立提交的文件推进分支，首页完整文件随后补上。
<tool_call>
COMPOSIO_MULTI_EXECUTE_TOOL
tools
[{"arguments":{"owner":"fgbhhnnn"},"tool_slug":"GITHUB_CREATE_A_TREE"}]`;

function prismaHarness(options: {
  continues?: number;
  continuing?: boolean;
  status?: string;
  workerBotId?: string;
  extraArgs?: Record<string, unknown>;
}) {
  const args: Record<string, unknown> = { lane: "computer", ...options.extraArgs };
  if (options.continues) args.incompleteContinues = options.continues;
  if (options.continuing) args.incompleteContinuing = true;
  const row = {
    id: "task-1",
    args,
    status: options.status ?? "started",
    workerBotId: options.workerBotId ?? "worker-1",
    workerRunId: "run-1",
    ref: "TIZS60WO",
    name: "按原版截图改布局",
  };
  const updates: unknown[] = [];
  const messageCreate = vi.fn().mockResolvedValue({
    id: "msg-continue",
    blocks: [{ kind: "bot_message_received" }],
  });
  const runCreate = vi.fn().mockResolvedValue({ id: "run-2" });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "thread" }]),
    message: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: messageCreate,
      update: vi.fn().mockResolvedValue({}),
    },
    task: { create: vi.fn().mockResolvedValue({ id: "task-row" }) },
    run: {
      create: runCreate,
      findUnique: vi.fn().mockResolvedValue({
        status: "queued",
        startedAt: null,
        firstResponseAt: null,
        userId: "u",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    event: { create: vi.fn().mockResolvedValue({ seq: 9, createdAt: new Date() }) },
    thread: {
      update: vi
        .fn()
        .mockResolvedValueOnce({ nextMessageSeq: 2 })
        .mockResolvedValue({ nextEventSeq: 10 }),
    },
  };
  const prisma = {
    backgroundTaskQueue: {
      findFirst: vi.fn().mockResolvedValue({
        id: row.id,
        name: row.name,
        ref: row.ref,
        status: row.status,
      }),
      findUnique: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockImplementation(async ({ data }: { data: unknown }) => {
        updates.push(data);
        return { count: 1 };
      }),
    },
    $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
  };
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(undefined);
  return {
    deps: {
      prisma: prisma as never,
      events: { notify },
      jobs: { enqueue },
    } as never,
    updates,
    enqueue,
    runCreate,
    messageCreate,
    row,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("handleIncompleteWorkerResult", () => {
  const run = {
    id: "run-1",
    spaceId: "s",
    threadId: "worker-thread",
    botId: "worker-1",
    userId: "u",
  };
  const dispatcher = { id: "main-1", name: "主 bot" };

  it("auto-continues the same worker for a #TIZS60WO truncated final (attempt 1)", async () => {
    const h = prismaHarness({});
    const decision = await handleIncompleteWorkerResult(h.deps as never, {
      run,
      dispatcher,
      text: TIZS60WO,
      reason: "truncated_tool_call",
    });
    expect(decision).toMatchObject({ action: "continue", attempt: 1, runId: "run-2" });
    if (decision.action === "continue") {
      expect(decision.cleanedText).toContain("首页两段");
      expect(decision.cleanedText).not.toContain("<tool_call>");
    }
    expect(h.enqueue).toHaveBeenCalled();
    expect(h.updates.some((u) => (u as { workerRunId?: string }).workerRunId === "run-2")).toBe(
      true,
    );
    const argsUpdate = h.updates.find(
      (u) => (u as { args?: { incompleteContinues?: number } }).args?.incompleteContinues === 1,
    ) as { args: { incompleteContinuing: boolean } };
    expect(argsUpdate.args.incompleteContinuing).toBe(true);
    const createdMsg = JSON.stringify(h.messageCreate.mock.calls);
    expect(createdMsg).toContain("系统自动继续");
    expect(createdMsg).not.toContain("<tool_call>");
  });

  it("marks the task failed after the continue cap with an honest note", async () => {
    const h = prismaHarness({ continues: MAX_INCOMPLETE_CONTINUES });
    const decision = await handleIncompleteWorkerResult(h.deps as never, {
      run,
      dispatcher,
      text: "还没做完，稍后继续。",
      reason: "unfinished_phrase",
    });
    expect(decision.action).toBe("fail");
    if (decision.action === "fail") {
      expect(decision.continues).toBe(MAX_INCOMPLETE_CONTINUES);
      expect(decision.note).toContain("未完成");
      expect(decision.note).toContain("还没做完");
    }
    expect(h.updates[0]).toMatchObject({ status: "failed" });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("stops when a continuation repeats the previous final nearly verbatim", async () => {
    const summary = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 节已写好。`).join("\n");
    const text = `${summary}\n我还没做完，稍后继续。`;
    const h = prismaHarness({
      continues: 1,
      continuing: true,
      extraArgs: { [INCOMPLETE_LAST_SIGNATURE_KEY]: resultSignature(text) },
    });
    const decision = await handleIncompleteWorkerResult(h.deps as never, {
      run,
      dispatcher,
      text: `${text}\n`,
      reason: "unfinished_phrase",
    });
    expect(decision.action).toBe("fail");
    if (decision.action === "fail") {
      expect(decision.continues).toBe(1);
      expect(decision.note).toContain("几乎相同");
      expect(decision.note).toContain("第 12 节已写好");
    }
    expect(h.updates[0]).toMatchObject({ status: "failed" });
    expect((h.updates[0] as { error: string }).error).toContain("repeated");
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("keeps continuing when the continuation changed, and stores its signature", async () => {
    const h = prismaHarness({
      continues: 1,
      continuing: true,
      extraArgs: { [INCOMPLETE_LAST_SIGNATURE_KEY]: resultSignature("完全不同的旧回复。") },
    });
    const decision = await handleIncompleteWorkerResult(h.deps as never, {
      run,
      dispatcher,
      text: "新做了两页，我还没做完，稍后继续。",
      reason: "unfinished_phrase",
    });
    expect(decision).toMatchObject({ action: "continue", attempt: 2 });
    const argsUpdate = h.updates.find(
      (u) => (u as { args?: { incompleteContinues?: number } }).args?.incompleteContinues === 2,
    ) as { args: Record<string, unknown> };
    expect(argsUpdate.args[INCOMPLETE_LAST_SIGNATURE_KEY]).toEqual(
      resultSignature("新做了两页，我还没做完，稍后继续。"),
    );
    expect(argsUpdate.args[INCOMPLETE_TRUNCATED_PREFIX_KEY]).toBeUndefined();
  });

  it("exhausted note keeps the full text, not the first 3000 characters", async () => {
    const text = `${"第一节内容。".repeat(1_500)}\n第七节结尾。我还没做完，稍后继续。`;
    expect(text.length).toBeGreaterThan(3_000);
    const h = prismaHarness({ continues: MAX_INCOMPLETE_CONTINUES });
    const decision = await handleIncompleteWorkerResult(h.deps as never, {
      run,
      dispatcher,
      text,
      reason: "unfinished_phrase",
    });
    expect(decision.action).toBe("fail");
    if (decision.action === "fail") {
      expect(decision.cleanedText).toBe(text);
      expect(decision.note).toContain(text.trim());
      expect(decision.lead).toContain("【未确认完成】");
      expect(decision.note.startsWith(decision.lead)).toBe(true);
    }
  });

  it("continues a cut-off final and stores the text written so far", async () => {
    const h = prismaHarness({});
    const decision = await handleIncompleteWorkerResult(h.deps as never, {
      run,
      dispatcher,
      text: "## 4. 版本计划\n- 当前测试服版本为 v1.",
      reason: "truncated_output",
    });
    expect(decision).toMatchObject({ action: "continue", attempt: 1 });
    const argsUpdate = h.updates.find(
      (u) => (u as { args?: { incompleteContinues?: number } }).args?.incompleteContinues === 1,
    ) as { args: Record<string, unknown> };
    expect(argsUpdate.args[INCOMPLETE_TRUNCATED_PREFIX_KEY]).toBe(
      "## 4. 版本计划\n- 当前测试服版本为 v1.",
    );
    const createdMsg = JSON.stringify(h.messageCreate.mock.calls);
    expect(createdMsg).toContain("原样接着往下写");
    expect(createdMsg).toContain("当前测试服版本为 v1.");
  });

  it("joins a second cut-off onto the stored prefix", async () => {
    const h = prismaHarness({
      continues: 1,
      continuing: true,
      extraArgs: { [INCOMPLETE_TRUNCATED_PREFIX_KEY]: "第一段。当前版本为 v1." },
    });
    await handleIncompleteWorkerResult(h.deps as never, {
      run,
      dispatcher,
      text: "2.0，第二段写到一半",
      reason: "truncated_output",
    });
    const argsUpdate = h.updates.find(
      (u) => (u as { args?: { incompleteContinues?: number } }).args?.incompleteContinues === 2,
    ) as { args: Record<string, unknown> };
    expect(argsUpdate.args[INCOMPLETE_TRUNCATED_PREFIX_KEY]).toBe(
      "第一段。当前版本为 v1.2.0，第二段写到一半",
    );
  });

  it("an exhausted cut-off relays the joined text", async () => {
    const h = prismaHarness({
      continues: MAX_INCOMPLETE_CONTINUES,
      extraArgs: { [INCOMPLETE_TRUNCATED_PREFIX_KEY]: "第一段。" },
    });
    const decision = await handleIncompleteWorkerResult(h.deps as never, {
      run,
      dispatcher,
      text: "第二段仍被截断",
      reason: "truncated_output",
    });
    expect(decision.action).toBe("fail");
    if (decision.action === "fail") {
      expect(decision.cleanedText).toBe("第一段。第二段仍被截断");
      expect(decision.note).toContain("输出长度上限");
    }
  });

  it("joins the stored prefix onto the continuation's final result", async () => {
    const h = prismaHarness({
      continues: 1,
      extraArgs: { [INCOMPLETE_TRUNCATED_PREFIX_KEY]: "前半部分，当前版本为 v1." },
    });
    expect(
      await withTruncatedOutputPrefix((h.deps as { prisma: never }).prisma, run, "2.0。全文完。"),
    ).toBe("前半部分，当前版本为 v1.2.0。全文完。");
    const plain = prismaHarness({});
    expect(
      await withTruncatedOutputPrefix((plain.deps as { prisma: never }).prisma, run, "全文。"),
    ).toBe("全文。");
  });

  it("skips when the queue row is no longer started", async () => {
    const h = prismaHarness({ status: "completed" });
    const decision = await handleIncompleteWorkerResult(h.deps as never, {
      run,
      dispatcher,
      text: TIZS60WO,
      reason: "truncated_tool_call",
    });
    expect(decision).toEqual({ action: "skip" });
  });
});
