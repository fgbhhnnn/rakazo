import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { FinalizeRunInput } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createDispatcherTurnLedger } from "./dispatcher-reply-guard.js";
import { isVisibleGroupTurn, prepareGroupTurnReply } from "./group-turn-reply.js";
import type { RunContext } from "./run-context.js";
import { createReplyState, publishMidTurnNarration } from "./run-progress.js";
import { messagingTools } from "./run-tools-messaging.js";
import { completeRun, consumeRunEvents } from "./run-turn.js";

async function harness(name = "团队-调研经理", dispatcherTurn = true) {
  const finalizeRun = vi.fn(async (_input: FinalizeRunInput) => false as const);
  const append = vi.fn(async () => ({ seq: 1 }));
  const posted: { blocks: MessageBlock[] }[] = [];
  const messageCreate = vi.fn(async (_input: { data: { blocks: MessageBlock[] } }) => {
    posted.push({ blocks: _input.data.blocks });
    return { id: "handoff-message" };
  });
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
        findMany: vi.fn(async () => posted),
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
    return messageCreate.mock.calls
      .flatMap(([input]) =>
        input.data.blocks.flatMap((b) =>
          b.kind === "text" || b.kind === "handoff" ? [b.text] : [],
        ),
      )
      .filter(Boolean);
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

describe("only duplicate group replies are suppressed", () => {
  it.each([true, false])(
    "seq35/36/38: dedupes repeated lead-ins and preserves distinct post-handoff text (dispatcher=%s)",
    async (dispatcher) => {
      const h = await harness("团队-调研经理", dispatcher);
      const lead = "图片还未完成，交给运营补齐。";
      await h.events(text(lead), tool("read_file"), text(lead), tool("handoff_to_bot"));
      await h.handoff(lead);
      const final = "补图已交给运营，使用已授权素材。";
      await h.events(text(final), { type: "done" });
      await completeRun(h.ctx);
      expect(h.writtenTexts()).toEqual([lead]);
      expect(h.ctx.state.reply.midTurnUserTexts).toEqual([lead]);
      expect(h.finalText()).toBe(final);
      expect(h.finalizeRun.mock.calls[0]?.[0]).toMatchObject({
        blocks: [
          {
            kind: "steps",
            steps: [
              { label: "Read file", count: 1 },
              { label: "Handoff to bot", count: 1 },
            ],
          },
          { kind: "text", text: final },
        ],
      });
      expect(h.finalizeRun).toHaveBeenCalledOnce();
      expect(h.append).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.progress" }));
    },
  );

  it.each(["团队-调研经理", "团队-SEO", "团队-GEO", "团队-运营", "团队-投流"])(
    "seq54/56: %s preserves a distinct final reply even when the target replied",
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
      expect(h.finalText()).toBe(final);
    },
  );

  it("posts explicit message_user progress once if no final follows", async () => {
    const h = await harness();
    const message = "素材清单已准备好。";
    const finish = vi.fn((result: unknown) => result);
    await messagingTools.message_user!(h.ctx, { args: { message }, finish } as never);
    await h.events({ type: "done" });
    await completeRun(h.ctx);
    expect(h.writtenTexts()).toEqual([message]);
    expect(h.messageCreate).toHaveBeenCalledOnce();
    expect(h.finalText()).toBe("");
    expect(finish).toHaveBeenCalledWith({ ok: true });
  });

  it("suppresses a final repeat of a handoff without hiding a distinct completion", async () => {
    const h = await harness();
    const brief = "Sources checked. Please review.";
    await h.handoff(brief);
    await h.events(text(brief), { type: "done" });
    await completeRun(h.ctx);
    expect(h.writtenTexts()).toEqual([brief]);
    expect(h.finalText()).toBe("");
    expect(h.finalizeRun.mock.calls[0]?.[0]).toMatchObject({ blocks: [] });
    const completion = "Drafter 已完成，交回 Planner。";
    expect(
      await prepareGroupTurnReply(h.ctx, [{ kind: "text", text: completion }], completion),
    ).toEqual({ blocks: [{ kind: "text", text: completion }], text: completion });
  });

  it("dedupes explicit progress without using up the budget for a new beat", async () => {
    const h = await harness();
    const finish = vi.fn((result: unknown) => result);
    for (const message of ["Sources checked.", "Sources checked.", "Draft complete."]) {
      await messagingTools.message_user!(h.ctx, { args: { message }, finish } as never);
    }
    expect(h.writtenTexts()).toEqual(["Sources checked.", "Draft complete."]);
    expect(h.ctx.state.reply.midTurnProgressCount).toBe(2);
    expect(finish.mock.calls).toEqual([[{ ok: true }], [{ ok: true }], [{ ok: true }]]);
    await h.events(text("Draft complete."), { type: "done" });
    await completeRun(h.ctx);
    expect(h.finalText()).toBe("");
  });

  it("does not post a repeated preview on steering, and still answers the new message", async () => {
    const h = await harness();
    const message = "Sources checked.";
    await messagingTools.message_user!(h.ctx, { args: { message }, finish: vi.fn() } as never);
    await h.events(text(message), { type: "steered", fromRunUser: true } as AgentRuntimeEvent);
    expect(h.writtenTexts()).toEqual([message]);
    expect(h.ctx.state.reply.midTurnUserTexts).toEqual([message]);
    expect(h.ctx.state.reply.midTurnProgressCount).toBe(1);
    await messagingTools.message_user!(h.ctx, {
      args: { message: "Draft updated." },
      finish: vi.fn(),
    } as never);
    expect(h.writtenTexts()).toEqual([message, "Draft updated."]);
  });

  it("does not restore already visible narration after an empty handed-off turn", async () => {
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
    h.ctx.state.reply.turnStartedAtMs = Date.now();
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

  it("preserves distinct long final text and attachments after a handoff; drops duplicate text and tool steps", async () => {
    const h = await harness();
    h.ctx.state.handedOff = true;
    const file: MessageBlock = {
      kind: "file",
      artifactId: "artifact",
      name: "sources.txt",
      mimeType: "text/plain",
      size: 10,
    };
    const blocks: MessageBlock[] = [{ kind: "text", text: "x".repeat(1000) }, file];
    expect((await prepareGroupTurnReply(h.ctx, blocks, "x".repeat(1000))).blocks).toEqual(blocks);
    await h.handoff("x".repeat(1000));
    expect(
      (
        await prepareGroupTurnReply(
          h.ctx,
          [...blocks, { kind: "steps", steps: [] }],
          "x".repeat(1000),
        )
      ).blocks,
    ).toEqual([file, { kind: "steps", steps: [] }]);
    expect(
      (
        await prepareGroupTurnReply(
          h.ctx,
          [blocks[0]!, { kind: "steps", steps: [] }],
          "x".repeat(1000),
        )
      ).blocks,
    ).toEqual([]);
    expect((await prepareGroupTurnReply(h.ctx, [{ kind: "steps", steps: [] }], "")).blocks).toEqual(
      [{ kind: "steps", steps: [] }],
    );
  });

  it("suppresses only duplicate text in a completion notification or peer result", async () => {
    const h = await harness();
    expect((await prepareGroupTurnReply(h.ctx, [], "Final answer")).text).toBe("Final answer");
    await h.handoff("Please review the sources");
    expect((await prepareGroupTurnReply(h.ctx, [], "Please review the sources")).text).toBe("");
    expect((await prepareGroupTurnReply(h.ctx, [], "I handed off the sources")).text).toBe(
      "I handed off the sources",
    );
    h.ctx.thread.groupId = null;
    expect((await prepareGroupTurnReply(h.ctx, [], "Private answer")).text).toBe("Private answer");
  });

  it("preserves unposted notes when no final answer follows several tools", async () => {
    const h = await harness();
    h.ctx.state.reply.turnStartedAtMs = Date.now();
    await h.events(text("正在核对。"), tool("read_file"), text("核对完成。"), tool("read_file"));
    await completeRun(h.ctx);
    expect(h.finalText()).toBe("正在核对。\n\n核对完成。");
  });

  it("preserves truncation feedback for explicit group progress", async () => {
    const h = await harness();
    const finish = vi.fn((result: unknown) => result);
    await messagingTools.message_user!(h.ctx, {
      args: { message: "x".repeat(501) },
      finish,
    } as never);
    expect(finish).toHaveBeenCalledWith({
      ok: true,
      truncated: true,
      note: expect.stringContaining("cut off"),
    });
    expect(h.ctx.state.reply.publishedMidTurnUserMessage).toBe(true);
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

  it("posts narration once before a connection card or after steering", async () => {
    const h = await harness();
    await h.events(text("正在整理素材。"), {
      type: "steered",
      fromRunUser: true,
    } as AgentRuntimeEvent);
    await publishMidTurnNarration(h.ctx, true);
    expect(h.writtenTexts()).toEqual(["正在整理素材。"]);
    expect(h.messageCreate).toHaveBeenCalledOnce();
    expect(h.ctx.state.reply.lastDiscardedMidTurnNarration).toBe("");
  });

  it("leaves private chats, hidden workers and background ticket work on their existing paths", async () => {
    const h = await harness();
    h.ctx.thread.groupId = null;
    expect(isVisibleGroupTurn(h.ctx)).toBe(false);
    h.ctx.thread.groupId = "group";
    h.ctx.bot.spawnKey = "bg-worker:research:1";
    expect(isVisibleGroupTurn(h.ctx)).toBe(false);
    h.ctx.bot.spawnKey = null;
    h.ctx.run.trigger = "tickets";
    expect(isVisibleGroupTurn(h.ctx)).toBe(false);
  });
});
