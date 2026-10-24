import { describe, expect, it, vi } from "vitest";
import {
  MAIN_BOT_INSTRUCTIONS_HEADER,
  workerDisabledWithMain,
  workerInstructions,
} from "./worker-main-settings.js";
import {
  pendingAskFromBlocks,
  WORKER_NEEDS_USER_NOTE,
  workerNeedsUserBlocks,
  workerPending,
} from "./worker-needs-user.js";
import { dataBotId, loadWorkerOwner, mcpScopeBotId, recallForRun } from "./worker-owner-scope.js";

const worker = { id: "w1", spawnKey: "bg-worker:main:1", parentBotId: "main" };
const child = { id: "c1", spawnKey: "main:helper", parentBotId: "main" };
const context = { spaceId: "s", userId: "u", botId: "w1" } as never;

describe("worker owner scope", () => {
  it("maps only hidden background workers to their main bot", () => {
    expect(dataBotId(worker)).toBe("main");
    expect(dataBotId(child)).toBe("c1");
    expect(dataBotId({ id: "b", spawnKey: null, parentBotId: null })).toBe("b");
    // A worker key that names another parent is not trusted.
    expect(dataBotId({ id: "x", spawnKey: "bg-worker:other:1", parentBotId: "main" })).toBe("x");
  });

  it("loads the main bot only for workers", async () => {
    const findUnique = vi.fn(async () => ({ id: "main", memoryScope: "shared" }));
    await expect(loadWorkerOwner({ bot: { findUnique } } as never, worker)).resolves.toEqual({
      id: "main",
      memoryScope: "shared",
    });
    await expect(loadWorkerOwner({ bot: { findUnique } } as never, child)).resolves.toBeNull();
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("resolves the MCP scope and falls back to the bot's own id on failure", async () => {
    const rows: Record<string, unknown> = { w1: worker, c1: child };
    const prisma = {
      bot: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null),
      },
    };
    await expect(mcpScopeBotId(prisma as never, "w1")).resolves.toBe("main");
    await expect(mcpScopeBotId(prisma as never, "c1")).resolves.toBe("c1");
    await expect(mcpScopeBotId(prisma as never, "gone")).resolves.toBe("gone");
    const failing = { bot: { findUnique: vi.fn(async () => Promise.reject(new Error("db"))) } };
    await expect(mcpScopeBotId(failing as never, "w1")).resolves.toBe("w1");
  });

  it("recalls the main bot's durable memory plus the worker's own thread history", async () => {
    const recall = vi.fn(async (request: { botId: string; historyGeneration?: number }) =>
      request.botId === "main"
        ? { ok: true as const, value: [{ memory: "owner fact", score: 0.5, id: "m1" }] }
        : {
            ok: true as const,
            value: [
              { memory: "history chunk", score: 0.9, id: "h1" },
              { memory: "owner fact", score: 0.4, id: "m1" },
            ],
          },
    );
    const request = {
      query: "q",
      scope: "isolated" as const,
      botId: "w1",
      historyGeneration: 3,
      limit: 5,
    };
    const out = await recallForRun({ recall }, request, { id: "main", scope: "shared" }, context);
    expect(recall).toHaveBeenCalledWith(
      { query: "q", scope: "shared", botId: "main", limit: 5 },
      context,
    );
    expect(recall).toHaveBeenCalledWith(request, context);
    expect(out).toEqual({
      ok: true,
      value: [
        { memory: "history chunk", score: 0.9, id: "h1" },
        { memory: "owner fact", score: 0.5, id: "m1" },
      ],
    });
    // No compacted history: only the main bot's memory.
    recall.mockClear();
    const { historyGeneration: _h, ...durable } = request;
    await recallForRun({ recall }, durable, { id: "main", scope: "shared" }, context);
    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall).toHaveBeenCalledWith({ ...durable, scope: "shared", botId: "main" }, context);
    // Ordinary bots are untouched.
    recall.mockClear();
    await recallForRun({ recall }, request, null, context);
    expect(recall).toHaveBeenCalledWith(request, context);
    expect(recall).toHaveBeenCalledTimes(1);
  });

  it("keeps the other result when one recall fails, and caps the merge at the limit", async () => {
    const failOwner = vi.fn(async (request: { botId: string }) =>
      request.botId === "main"
        ? { ok: false as const, error: "down" }
        : { ok: true as const, value: [{ memory: "h", score: 1 }] },
    );
    const request = {
      query: "q",
      scope: "isolated" as const,
      botId: "w1",
      historyGeneration: 1,
      limit: 1,
    };
    await expect(
      recallForRun({ recall: failOwner }, request, { id: "main", scope: "isolated" }, context),
    ).resolves.toEqual({ ok: true, value: [{ memory: "h", score: 1 }] });
    const many = vi.fn(async (r: { botId: string }) => ({
      ok: true as const,
      value: [{ memory: `${r.botId}-a`, score: r.botId === "main" ? 0.2 : 0.8 }],
    }));
    await expect(
      recallForRun({ recall: many }, request, { id: "main", scope: "isolated" }, context),
    ).resolves.toEqual({ ok: true, value: [{ memory: "w1-a", score: 0.8 }] });
  });
});

describe("worker needs user", () => {
  const approval = {
    kind: "ask",
    approvalEffectId: "e1",
    text: "Allow deploy?",
    status: "pending",
  };
  it("reads the pending ask of a waiting worker", () => {
    expect(pendingAskFromBlocks([{ kind: "text", text: "hi" }, approval])).toEqual({
      kind: "approval",
      text: "Allow deploy?",
    });
    expect(pendingAskFromBlocks([{ kind: "ask", input: "secret", text: "Token?" }])).toEqual({
      kind: "secret",
      text: "Token?",
    });
    expect(pendingAskFromBlocks([{ kind: "ask", text: "Which?" }])).toEqual({
      kind: "question",
      text: "Which?",
    });
    expect(pendingAskFromBlocks([{ ...approval, status: "answered" }])).toBeUndefined();
    expect(pendingAskFromBlocks(null)).toBeUndefined();
    expect(pendingAskFromBlocks([{ kind: "ask", text: "x".repeat(500) }])?.text.length).toBe(300);
  });

  it("is set only while the worker run waits on the user", () => {
    expect(workerPending("waiting_input", [approval])).toEqual({
      kind: "approval",
      text: "Allow deploy?",
    });
    expect(workerPending("takeover", [])).toEqual({ kind: "takeover", text: "" });
    expect(workerPending("waiting_input", [])).toEqual({ kind: "question", text: "" });
    for (const status of ["running", "queued", "completed", undefined]) {
      expect(workerPending(status, [approval])).toBeUndefined();
    }
  });

  it("builds the main-chat line and a card to the worker's chat", () => {
    expect(
      workerNeedsUserBlocks(
        { workerId: "w1", name: "部署", ref: "B2" },
        { kind: "secret", text: "" },
      ),
    ).toEqual([
      { kind: "text", text: "任务 #B2（部署）需要你提供凭据" },
      {
        kind: "child_bot",
        botId: "w1",
        name: "后台任务：部署 #B2",
        title: "任务 #B2 · 需要你提供凭据，点开处理",
        status: "created",
      },
    ]);
    expect(WORKER_NEEDS_USER_NOTE).toContain("Never approve or deny for them");
  });
});

describe("worker main settings", () => {
  it("appends the main bot's instructions below the worker rules", () => {
    expect(workerInstructions("RULES", "Be brief.")).toBe(
      `RULES\n\n${MAIN_BOT_INSTRUCTIONS_HEADER}\n\nBe brief.`,
    );
    expect(workerInstructions("RULES", "  ")).toBe("RULES");
    expect(workerInstructions("RULES", null)).toBe("RULES");
  });

  it("unions the main bot's disabled tools into the task's", () => {
    expect(workerDisabledWithMain(["ask_user", "spawn_bot"], ["web_search", "ask_user"])).toEqual([
      "ask_user",
      "spawn_bot",
      "web_search",
    ]);
    expect(workerDisabledWithMain(["ask_user"], null)).toEqual(["ask_user"]);
  });
});
