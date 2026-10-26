import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";

vi.mock("./page-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./page-tools.js")>()),
  runPageTool: vi.fn(async () => ({
    result: { ok: true, pageId: "page-1" },
    block: { kind: "page", pageId: "page-1" },
  })),
}));
vi.mock("./run-messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-messages.js")>()),
  publishMessage: vi.fn(async () => undefined),
}));
vi.mock("./scratchpad-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scratchpad-tools.js")>()),
  listScratchpadItemsFromTool: vi.fn(async () => ({ items: [] })),
}));
vi.mock("./worker-owner-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-owner-scope.js")>()),
  recallForRun: vi.fn(async () => ({ memories: [] })),
}));

import { runPageTool } from "./page-tools.js";
import { publishMessage } from "./run-messages.js";
import { memoryTools } from "./run-tools-memory.js";
import { pageTools } from "./run-tools-pages.js";
import { taskTools } from "./run-tools-tasks.js";
import { listScratchpadItemsFromTool } from "./scratchpad-tools.js";
import { recallForRun } from "./worker-owner-scope.js";

const OWNER_SCOPE = { kind: "owner-durable" };
const OWNER = { botId: "main-bot", scope: { kind: "owner-recall" } };

/** A hidden worker's run: the worker is `worker-bot`, its data belongs to `main-bot`. */
function workerContext(overrides: Partial<Record<string, unknown>> = {}) {
  const semantic = {
    save: vi.fn(async () => ({ ok: true })),
    forget: vi.fn(async () => ({ ok: true })),
    recall: vi.fn(async () => ({ memories: [] })),
  };
  const ctx = {
    deps: { prisma: {}, artifacts: {} },
    run: { id: "run-1", spaceId: "space-1", userId: "user-1", threadId: "thread-1" },
    thread: { id: "thread-1", groupId: "group-1", historyCompactedUpToSeq: null },
    bot: { id: "worker-bot" },
    memoryBotId: "main-bot",
    secrets: ["s3cret"],
    context: { operationId: "op" },
    memory: {
      semantic,
      scope: { kind: "worker-run" },
      durableScope: OWNER_SCOPE,
      owner: OWNER,
    },
    ...overrides,
  } as unknown as RunContext;
  return { ctx, semantic };
}

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return {
    name,
    args,
    executionId: `exec-${name}`,
    finish: (result: unknown) => result,
  } as unknown as ToolCall;
}

describe("hidden worker tool scope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes Pages for the main bot, with secrets masked, and posts the card", async () => {
    const { ctx } = workerContext();
    const result = await pageTools.write_page!(ctx, toolCall("write_page", { title: "Report" }));
    expect(result).toEqual({ ok: true, pageId: "page-1" });
    expect(runPageTool).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        botId: "main-bot",
        spaceId: "space-1",
        groupId: "group-1",
        runId: "run-1",
        operationId: "exec-write_page",
        secrets: ["s3cret"],
      }),
      "write_page",
      { title: "Report" },
    );
    expect(publishMessage).toHaveBeenCalledWith(ctx.deps, ctx.run, "bot", [
      { kind: "page", pageId: "page-1" },
    ]);
  });

  it("refuses Page tools without artifact storage instead of falling through", async () => {
    const { ctx } = workerContext({ deps: { prisma: {} } });
    expect(await pageTools.read_page!(ctx, toolCall("read_page"))).toEqual({
      error: "page storage unavailable",
    });
    expect(runPageTool).not.toHaveBeenCalled();
  });

  it("reads the main bot's scratchpad", async () => {
    const { ctx } = workerContext();
    await taskTools.scratchpad_list!(ctx, toolCall("scratchpad_list"));
    expect(listScratchpadItemsFromTool).toHaveBeenCalledWith(
      ctx.deps,
      expect.objectContaining({ botId: "main-bot", spaceId: "space-1" }),
    );
  });

  it("saves and forgets durable facts in the main bot's memory", async () => {
    const { ctx, semantic } = workerContext();
    await memoryTools.save_memory!(ctx, toolCall("save_memory", { content: "likes tea" }));
    await memoryTools.forget_memory!(ctx, toolCall("forget_memory", { id: "fact-1" }));
    expect(semantic.save).toHaveBeenCalledWith(
      expect.objectContaining({ scope: OWNER_SCOPE, botId: "main-bot" }),
      ctx.context,
    );
    expect(semantic.forget).toHaveBeenCalledWith(
      expect.objectContaining({ id: "fact-1", scope: OWNER_SCOPE, botId: "main-bot" }),
      ctx.context,
    );
  });

  it("recalls with the owner's memories included", async () => {
    const { ctx, semantic } = workerContext();
    await memoryTools.recall_memory!(ctx, toolCall("recall_memory", { query: "tea" }));
    expect(recallForRun).toHaveBeenCalledWith(
      semantic,
      expect.objectContaining({ query: "tea" }),
      OWNER,
      ctx.context,
    );
  });
});
