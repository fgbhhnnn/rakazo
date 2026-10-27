import { describe, expect, it, vi } from "vitest";
import { createDispatcherTurnLedger, guardDispatcherReply } from "./dispatcher-reply-guard.js";
import {
  noticeHandoffToolFailure,
  planGroupReply,
  postGroupNotice,
  routeGroupReply,
} from "./group-reply-routing.js";

vi.mock("./group-handoff.js", () => ({ handoffToGroupBot: vi.fn() }));
const { handoffToGroupBot } = await import("./group-handoff.js");
const handoff = vi.mocked(handoffToGroupBot);

const members = [
  { id: "pm", name: "团队-产品" },
  { id: "fe", name: "团队-前端" },
  { id: "be", name: "团队-后端" },
];
const run = { id: "run-1", spaceId: "s", threadId: "group-thread", botId: "be", userId: "u" };

function prisma(options: { existingNotice?: boolean } = {}) {
  const created: unknown[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => []),
    message: {
      findUnique: vi.fn(async () => (options.existingNotice ? { id: "m0" } : null)),
      create: vi.fn(async (args: { data: unknown }) => {
        created.push(args.data);
        return { id: "m1" };
      }),
    },
    thread: { update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 2 })) },
    run: { findUnique: vi.fn(async () => null) },
    event: { create: vi.fn(async () => ({ seq: 7 })) },
  };
  return {
    created,
    prisma: {
      chatGroup: {
        findFirst: vi.fn(async () => ({ members: members.map((bot) => ({ bot })) })),
      },
      $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
    },
  };
}

const text = (value: string) => [{ kind: "text" as const, text: value }];

describe("planGroupReply", () => {
  const plan = (reply: string, extra: { handoffTargets?: string[]; handedOff?: boolean } = {}) =>
    planGroupReply({ prisma: prisma().prisma } as never, {
      groupId: "g",
      bot: { id: "be", spawnKey: null },
      handedOff: extra.handedOff ?? false,
      handoffTargets: extra.handoffTargets ?? [],
      blocks: text(reply),
    });

  it("routes an exact member @Name in the reply, Chinese text right after it", async () => {
    const result = await plan("接口已完成。@团队-前端请对接登录页");
    expect(result.plan?.target).toEqual({ id: "fe", name: "团队-前端" });
    expect(result.blocks).toEqual(text("接口已完成。@团队-前端请对接登录页"));
  });

  it("does not route when the tool already handed off, or the turn was handed off", async () => {
    expect((await plan("@团队-前端 看下", { handoffTargets: ["pm"] })).plan).toBeUndefined();
    expect((await plan("@团队-前端 看下", { handedOff: true })).plan).toBeUndefined();
  });

  it("never routes to itself", async () => {
    expect((await plan("@团队-后端 我继续")).plan).toBeUndefined();
  });

  it("appends a note to a handoff claim nothing backs", async () => {
    const result = await plan("已交给前端处理。");
    expect(result.plan).toBeUndefined();
    expect(result.blocks).toEqual(text("已交给前端处理。\n（未实际交接给 团队-前端）"));
  });

  it("accepts a claim backed by the reply's own @Name or by the tool", async () => {
    expect((await plan("已交给@团队-前端。")).blocks).toEqual(text("已交给@团队-前端。"));
    expect((await plan("已交给前端。", { handoffTargets: ["fe"] })).blocks).toEqual(
      text("已交给前端。"),
    );
  });

  it("skips members the latest human message already @-addressed, and only those", async () => {
    const db = prisma();
    const findFirst = vi.fn(async (_args: unknown) => ({
      blocks: text("@团队-前端 做登录页，@团队-后端 做接口"),
    }));
    const withHuman = { ...db.prisma, message: { findFirst } };
    const before = new Date("2026-10-27T12:00:00Z");
    const planWith = (reply: string) =>
      planGroupReply({ prisma: withHuman } as never, {
        groupId: "g",
        bot: { id: "be", spawnKey: null },
        handedOff: false,
        handoffTargets: [],
        blocks: text(reply),
        humanTurn: { threadId: "group-thread", before },
      });
    // Quoting the human's "@团队-前端" does not hand the same work to it again...
    expect((await planWith("收到：@团队-前端 做登录页")).plan).toBeUndefined();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: "group-thread", role: "user", createdAt: { lte: before } },
      }),
    );
    // ...but a member the human did not address is still the next stage.
    expect((await planWith("@团队-前端 已知悉。@团队-产品 请验收")).plan?.target).toEqual({
      id: "pm",
      name: "团队-产品",
    });
    // A handoff claim stays honest: being addressed by the human is not a handoff by this bot.
    expect((await planWith("已交给前端。")).blocks).toEqual(
      text("已交给前端。\n（未实际交接给 团队-前端）"),
    );
  });

  it("leaves DMs and hidden workers alone", async () => {
    const dm = await planGroupReply({ prisma: prisma().prisma } as never, {
      groupId: null,
      bot: { id: "be" },
      handedOff: false,
      handoffTargets: [],
      blocks: text("已交给前端。"),
    });
    expect(dm).toEqual({ blocks: text("已交给前端。") });
    const worker = await planGroupReply({ prisma: prisma().prisma } as never, {
      groupId: "g",
      bot: { id: "w", spawnKey: "bg-worker:x" },
      handedOff: false,
      handoffTargets: [],
      blocks: text("已交给前端。"),
    });
    expect(worker.blocks).toEqual(text("已交给前端。"));
  });

  it("keeps a group handoff claim out of the dispatcher's worker-claim rewrite", async () => {
    const result = await plan("已交给前端处理。");
    const guarded = guardDispatcherReply(true, result.blocks, createDispatcherTurnLedger(), {
      wokenByWorker: false,
      runId: "r",
      exemptClaim: result.isTeamClaim,
    });
    expect(guarded.recheckClaim).toBe(false);
    expect(guarded.blocks).toEqual(result.blocks);
    const unexempted = guardDispatcherReply(true, result.blocks, createDispatcherTurnLedger(), {
      wokenByWorker: false,
      runId: "r",
    });
    expect(unexempted.recheckClaim).toBe(true);
  });
});

describe("routeGroupReply", () => {
  const target = { id: "fe", name: "团队-前端" };

  it("hands off through the same path as the tool, after the reply", async () => {
    const db = prisma();
    handoff.mockResolvedValueOnce({ ok: true } as never);
    await routeGroupReply({ prisma: db.prisma } as never, run, {
      groupId: "g",
      target,
      replyText: "@团队-前端请对接",
    });
    expect(handoff).toHaveBeenLastCalledWith(
      expect.anything(),
      run,
      "g",
      { bot_id: "fe", message: "@团队-前端请对接" },
      { allowFinishedSource: true },
    );
    expect(db.created).toEqual([]);
  });

  it("says the chain limit in the group instead of stopping silently", async () => {
    const db = prisma();
    const events = { notify: vi.fn(async () => undefined) };
    handoff.mockResolvedValueOnce({ error: "limit", reason: "hop_limit" });
    await routeGroupReply({ prisma: db.prisma, events } as never, run, {
      groupId: "g",
      target,
      replyText: "@团队-前端",
    });
    expect(db.created).toMatchObject([
      {
        threadId: "group-thread",
        role: "bot",
        botId: "be",
        clientNonce: "group-notice:run-1",
        blocks: [{ kind: "text", text: "已达到连续交接上限，等你回复。" }],
      },
    ]);
    expect(events.notify).toHaveBeenCalledWith("group-thread", 7);
  });

  it("stays quiet for a reply to the member who handed the stage over", async () => {
    const db = prisma();
    handoff.mockResolvedValueOnce({ error: "back", reason: "hand_back" });
    await routeGroupReply({ prisma: db.prisma } as never, run, {
      groupId: "g",
      target,
      replyText: "@团队-前端 done",
    });
    expect(db.created).toEqual([]);
  });

  it("explains other failures in the group", async () => {
    const db = prisma();
    handoff.mockResolvedValueOnce({ error: "x", reason: "not_in_group" });
    await routeGroupReply(
      { prisma: db.prisma, events: { notify: vi.fn(async () => undefined) } } as never,
      run,
      { groupId: "g", target, replyText: "@团队-前端" },
    );
    expect(db.created).toMatchObject([
      { blocks: [{ kind: "text", text: "未能交接给 团队-前端：对方不是本群成员。" }] },
    ]);
  });
});

describe("group notices", () => {
  it("posts at most one notice per run", async () => {
    const db = prisma({ existingNotice: true });
    const events = { notify: vi.fn(async () => undefined) };
    await postGroupNotice({ prisma: db.prisma, events } as never, run, "x");
    expect(db.created).toEqual([]);
    expect(events.notify).not.toHaveBeenCalled();
  });

  it("posts the hop-limit notice for a tool failure in a group only", async () => {
    const events = { notify: vi.fn(async () => undefined) };
    const inGroup = prisma();
    await noticeHandoffToolFailure(
      { prisma: inGroup.prisma, events } as never,
      {
        ...run,
        groupId: "g",
      },
      "hop_limit",
    );
    expect(inGroup.created).toHaveLength(1);
    const other = prisma();
    await noticeHandoffToolFailure(
      { prisma: other.prisma, events } as never,
      {
        ...run,
        groupId: "g",
      },
      "self_target",
    );
    await noticeHandoffToolFailure(
      { prisma: other.prisma, events } as never,
      {
        ...run,
        groupId: null,
      },
      "hop_limit",
    );
    expect(other.created).toEqual([]);
  });
});
