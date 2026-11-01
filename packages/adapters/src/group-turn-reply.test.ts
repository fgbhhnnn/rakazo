import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { FinalizeRunInput } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createDispatcherTurnLedger } from "./dispatcher-reply-guard.js";
import {
  groupTurnReplyBlocks,
  groupTurnReplyText,
  holdsGroupTurnReply,
} from "./group-turn-reply.js";
import type { RunContext } from "./run-context.js";
import { createReplyState, publishMidTurnNarration } from "./run-progress.js";
import { messagingTools } from "./run-tools-messaging.js";
import { completeRun, consumeRunEvents } from "./run-turn.js";

async function harness(name = "团队-调研经理", dispatcherTurn = true) {
  const finalizeRun = vi.fn(async (_input: FinalizeRunInput) => false as const);
  const append = vi.fn(async () => ({ seq: 1 }));
  const messageCreate = vi.fn(async (_input: { data: { blocks: MessageBlock[] } }) => ({
    id: "handoff-message",
  }));
  const run = {
    id: "run",
    spaceId: "space",
    botId: "research",
    threadId: "thread",
    taskId: "task",
    userId: "user",
    trigger: "user",
    createdAt: new Date(),
    startedAt: new Date(Date.now() - 120_000),
  };
  const deps = {
    prisma: {
      message: {
        findMany: vi.fn(async () => []),
        create: messageCreate,
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => null),
      },
      chatGroup: {
        findFirst: vi.fn(async () => ({
          name: "Test team",
          thread: { id: run.threadId },
          members: [{ bot: { id: run.botId, name } }, { bot: { id: "ops", name: "团队-运营" } }],
        })),
        update: vi.fn(),
      },
      run: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
          where.id
            ? {
                id: run.id,
                thread: { groupId: "group" },
                sourceMessage: {
                  id: "human-message",
                  role: "user",
                  botId: null,
                  blocks: [{ kind: "text", text: "Review the sources" }],
                },
              }
            : null,
        ),
        findUnique: vi.fn(async () => ({ status: "running" })),
        create: vi.fn(async () => ({ id: "target-run" })),
      },
      task: { create: vi.fn(async () => ({ id: "target-task" })) },
      thread: { update: vi.fn(async () => ({ nextMessageSeq: 1, nextEventSeq: 1 })) },
      event: { create: vi.fn(async () => ({ seq: 1 })) },
      $queryRaw: vi.fn(async () => [{ id: "group" }]),
    },
    events: { append, finalizeRun, notify: vi.fn(async () => undefined) },
    jobs: { enqueue: vi.fn(async () => undefined) },
  } as unknown as RunContext["deps"];
  deps.prisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(deps.prisma),
  ) as never;
  const ctx = {
    deps,
    run,
    runId: run.id,
    bot: { id: run.botId, name },
    thread: { id: run.threadId, groupId: "group" },
    state: {
      reply: await createReplyState(deps, run as never, []),
      dispatcherTurn,
      turnLedger: createDispatcherTurnLedger(),
      handedOff: false,
      handoffTargets: [],
      approval: { pausePending: false },
      lease: { valid: true, lastCheckAt: Date.now() },
      toolCallStreak: {},
      computerUse: {},
    },
    computer: { lazy: { throwIfFailed() {} }, checkpoint: { flush: vi.fn() } },
    tools: { approvedReplays: { assertDrained() {} } },
    source: { peerMessage: null },
    secrets: [],
    attempt: { id: "attempt" },
    workerId: "worker",
    fence: 1,
    abortController: new AbortController(),
    attachedFilePaths: new Set(),
    settleRunningHelpers: vi.fn(),
  } as unknown as RunContext;
  async function events(...items: AgentRuntimeEvent[]) {
    await consumeRunEvents(
      ctx,
      (async function* () {
        yield* items;
      })(),
    );
  }
  function finalText() {
    const input = finalizeRun.mock.calls[0]?.[0];
    return input?.outcome === "completed"
      ? input.blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("")
      : undefined;
  }
  async function handoff(brief: string) {
    const finish = vi.fn((result: unknown) => result);
    await messagingTools.handoff_to_bot!(ctx, {
      args: { bot_id: "ops", message: brief },
      finish,
    } as never);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  }
  function writtenTexts() {
    return messageCreate.mock.calls.flatMap(([input]) =>
      input.data.blocks.flatMap((b) => (b.kind === "text" || b.kind === "handoff" ? [b.text] : [])),
    );
  }
  return { ctx, events, handoff, writtenTexts, finalizeRun, finalText, append, messageCreate };
}

const text = (value: string): AgentRuntimeEvent => ({ type: "text", text: value });
const tool = (name: string): AgentRuntimeEvent => ({
  type: "tool",
  name,
  args: {},
  executionId: name,
});

describe("one written group reply per bot turn", () => {
  it.each([true, false])(
    "seq35/36/38: holds repeated lead-ins and suppresses the post-handoff variant (dispatcher=%s)",
    async (dispatcher) => {
      const h = await harness("团队-调研经理", dispatcher);
      const lead = "图片还未完成，交给运营补齐。";
      await h.events(text(lead), tool("read_file"), text(lead), tool("handoff_to_bot"));
      await h.handoff(lead);
      const final = "补图已交给运营，使用已授权素材。";
      await h.events(text(final), { type: "done" });
      await completeRun(h.ctx);
      expect(h.writtenTexts()).toEqual([lead]);
      expect(h.ctx.state.reply.midTurnUserTexts).toEqual([]);
      expect(h.finalText()).toBe("");
      expect(h.finalizeRun.mock.calls[0]?.[0]).toMatchObject({ blocks: [] });
      expect(h.finalizeRun).toHaveBeenCalledOnce();
      expect(h.append).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.progress" }));
    },
  );

  it.each(["团队-调研经理", "团队-SEO", "团队-GEO", "团队-运营", "团队-投流"])(
    "seq54/56: %s leaves the handoff brief as its only reply even when the target replied",
    async (name) => {
      const h = await harness(name);
      await h.events(text("当前阶段已完成，下一阶段由运营接手。"), tool("handoff_to_bot"));
      const brief = "当前阶段已完成，下一阶段由运营接手。";
      await h.handoff(brief);
      const final = "产品页和博客已交给运营，投流随后继续。";
      await h.events(text(final), { type: "done" });
      h.ctx.deps.prisma.message.findFirst = vi.fn(
        async ({ where }: { where: { clientNonce?: unknown; botId?: string } }) =>
          where.clientNonce
            ? {
                seq: 5,
                blocks: [
                  { kind: "handoff", fromBotId: "research", toBotId: "ops", text: "next stage" },
                ],
              }
            : where.botId
              ? { id: "target-reply" }
              : null,
      ) as never;
      await completeRun(h.ctx);
      expect(h.writtenTexts()).toEqual([brief]);
      expect(h.finalText()).toBe("");
    },
  );

  it("holds explicit message_user progress and retains it if no final follows", async () => {
    const h = await harness();
    const message = "素材清单已准备好。";
    const finish = vi.fn((result: unknown) => result);
    await messagingTools.message_user!(h.ctx, { args: { message }, finish } as never);
    await h.events({ type: "done" });
    await completeRun(h.ctx);
    expect(h.messageCreate).not.toHaveBeenCalled();
    expect(h.finalText()).toBe(message);
    expect(finish).toHaveBeenCalledWith({ ok: true });
  });

  it("does not restore held narration after an empty handed-off turn", async () => {
    const h = await harness();
    await h.events(text("素材交接说明。"), tool("handoff_to_bot"));
    h.ctx.state.handedOff = true;
    await h.events({ type: "done" });
    await completeRun(h.ctx);
    expect(h.finalText()).toBe("");
  });

  it("keeps the normal final answer when no handoff was made", async () => {
    const h = await harness();
    await h.events(text("正在核对。"), tool("read_file"), text("来源已核对完成。"));
    await completeRun(h.ctx);
    expect(h.finalText()).toBe("来源已核对完成。");
  });

  it("keeps a single fallback reply after a refused handoff", async () => {
    const h = await harness();
    h.ctx.run.trigger = "follow_up";
    await h.events(text("The sources need review."), tool("handoff_to_bot"));
    const finish = vi.fn((result: unknown) => result);
    await messagingTools.handoff_to_bot!(h.ctx, {
      args: { bot_id: "missing-member", message: "Review the sources" },
      finish,
    } as never);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ reason: "not_in_group" }));
    expect(h.ctx.state.handedOff).toBe(false);
    await completeRun(h.ctx);
    expect(h.messageCreate).not.toHaveBeenCalled();
    expect(h.finalText()).toBe("The sources need review.");
  });

  it("preserves attachments after a handoff while dropping long final variants and tool steps", async () => {
    const h = await harness();
    h.ctx.state.handedOff = true;
    const file: MessageBlock = {
      kind: "file",
      artifactId: "artifact",
      name: "sources.txt",
      mimeType: "text/plain",
      size: 10,
    };
    expect(groupTurnReplyBlocks(h.ctx, [{ kind: "text", text: "x".repeat(1000) }, file])).toEqual([
      file,
    ]);
    expect(groupTurnReplyBlocks(h.ctx, [{ kind: "steps", steps: [] }])).toEqual([]);
  });

  it("does not send a suppressed handoff variant in a completion notification or peer result", async () => {
    const h = await harness();
    expect(groupTurnReplyText(h.ctx, "Final answer")).toBe("Final answer");
    await h.handoff("Please review the sources");
    expect(groupTurnReplyText(h.ctx, "I handed off the sources")).toBe("");
    h.ctx.thread.groupId = null;
    expect(groupTurnReplyText(h.ctx, "Private answer")).toBe("Private answer");
  });

  it("restores only the last held narration when no final answer follows several tools", async () => {
    const h = await harness();
    await h.events(text("正在核对。"), tool("read_file"), text("核对完成。"), tool("read_file"));
    await completeRun(h.ctx);
    expect(h.finalText()).toBe("核对完成。");
  });

  it("preserves truncation feedback for explicit group progress", async () => {
    const h = await harness();
    const finish = vi.fn((result: unknown) => result);
    await messagingTools.message_user!(h.ctx, {
      args: { message: "x".repeat(501) },
      finish,
    } as never);
    expect(finish).toHaveBeenCalledWith({ ok: true, truncated: true });
    expect(h.ctx.state.reply.publishedMidTurnUserMessage).toBe(false);
  });

  it("keeps the empty-run fallback and explicit silence behavior", async () => {
    const empty = await harness();
    await completeRun(empty.ctx);
    expect(empty.finalText()).toBe("done.");
    const silent = await harness();
    silent.ctx.run.trigger = "reaction";
    silent.ctx.allowSilentEmptyRun = true;
    await silent.events(text("NO_RESPONSE"), { type: "done" });
    await completeRun(silent.ctx);
    expect(silent.finalText()).toBe("");
  });

  it("holds narration even before a connection card or after steering", async () => {
    const h = await harness();
    await h.events(text("正在整理素材。"), {
      type: "steered",
      fromRunUser: true,
    } as AgentRuntimeEvent);
    await publishMidTurnNarration(h.ctx, true);
    expect(h.messageCreate).not.toHaveBeenCalled();
    expect(h.ctx.state.reply.lastDiscardedMidTurnNarration).toBe("正在整理素材。");
  });

  it("leaves private chats, hidden workers and background ticket work on their existing paths", async () => {
    const h = await harness();
    h.ctx.thread.groupId = null;
    expect(holdsGroupTurnReply(h.ctx)).toBe(false);
    h.ctx.thread.groupId = "group";
    h.ctx.bot.spawnKey = "bg-worker:research:1";
    expect(holdsGroupTurnReply(h.ctx)).toBe(false);
    h.ctx.bot.spawnKey = null;
    h.ctx.run.trigger = "tickets";
    expect(holdsGroupTurnReply(h.ctx)).toBe(false);
  });
});
