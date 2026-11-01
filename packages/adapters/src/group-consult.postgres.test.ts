import { randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import { createDb, createThreadMessageInTransaction, runAsSystem } from "@rakazo/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askTeammate,
  reconcileTeammateQuestions,
  stageSourceForHandoff,
  wakeAsker,
} from "./group-consult.js";
import { handoffToGroupBot } from "./group-handoff.js";
import { GROUP_HELD_RUN_MAX_MS } from "./group-held-runs.js";
import { settleHandoffNarration } from "./group-stale-narration.js";
import { teamRunForRun } from "./group-team-run.js";
import { afterGroupTurn } from "./group-turn-end.js";

/**
 * ask_teammate end to end against the database: a member asks another member a question, the
 * answer is routed back and the asker continues its own stage, inside and outside a team run,
 * within its bounds (one per turn, no nested asks, per-request and per-pair caps), with a
 * visible notice when no answer comes, and without overlapping turns of one bot.
 */

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("teammate questions (PostgreSQL)", () => {
  const { prisma, pool } = createDb(process.env.DATABASE_URL ?? "");
  const sys = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
  const notify = vi.fn(async () => undefined);
  const enqueue = vi.fn(async (_job: { payload: { runId?: string } }) => undefined);
  const deps = { prisma, events: { notify }, jobs: { enqueue } } as never;
  const enqueued = () => enqueue.mock.calls.map(([job]) => job.payload.runId);

  beforeEach(() => {
    enqueue.mockClear();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.$disconnect();
    await pool.end();
  });

  /** Roster order is join order: the first member leads team runs. */
  async function team(names: string[]) {
    const id = `consult-${randomUUID()}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    return sys(async () => {
      await prisma.user.create({ data: { id: userId, name: "Owner", email: `${id}@rakazo.test` } });
      await prisma.organization.create({
        data: { id: `${id}-org`, name: "Org", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId: `${id}-org`, name: "S" } });
      const bots: Awaited<ReturnType<typeof prisma.bot.create>>[] = [];
      for (const name of names) {
        bots.push(
          await prisma.bot.create({
            data: { spaceId, userId, name, color: "ink", description: "", title: "" },
          }),
        );
      }
      const group = await prisma.chatGroup.create({ data: { spaceId, userId, name: "团队" } });
      for (const bot of bots) {
        await prisma.chatGroupMember.create({ data: { groupId: group.id, botId: bot.id } });
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
      const thread = await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } });
      const byName = (name: string) => {
        const bot = bots.find((entry) => entry.name === name);
        if (!bot) throw new Error(name);
        return bot;
      };
      return { userId, spaceId, group, thread, bots, byName };
    });
  }
  type Team = Awaited<ReturnType<typeof team>>;

  async function say(fx: Team, text: string, botName?: string) {
    return sys(() =>
      prisma.$transaction((tx) =>
        createThreadMessageInTransaction(tx, {
          threadId: fx.thread.id,
          role: botName ? "bot" : "user",
          ...(botName ? { botId: fx.byName(botName).id } : {}),
          blocks: [{ kind: "text", text }],
        }),
      ),
    );
  }

  /** The human message woke this bot, like thread-target does. */
  async function wake(fx: Team, messageId: string, name: string) {
    const botId = fx.byName(name).id;
    return sys(async () => {
      const task = await prisma.task.create({
        data: {
          spaceId: fx.spaceId,
          botId,
          threadId: fx.thread.id,
          userId: fx.userId,
          prompt: "p",
          status: "running",
        },
      });
      return prisma.run.create({
        data: {
          spaceId: fx.spaceId,
          botId,
          threadId: fx.thread.id,
          taskId: task.id,
          userId: fx.userId,
          status: "running",
          trigger: "user",
          sourceMessageId: messageId,
        },
      });
    });
  }
  type RunRow = Awaited<ReturnType<typeof wake>>;

  const bot = (fx: Team, id: string) => {
    const row = fx.bots.find((entry) => entry.id === id);
    if (!row) throw new Error(id);
    return row;
  };
  const thread = (fx: Team) => ({ groupId: fx.group.id });
  const ask = (fx: Team, run: RunRow, to: string, question = `${to}，接口字段是什么？`) =>
    sys(() => askTeammate(deps, run, fx.group.id, { bot_id: fx.byName(to).id, question }));
  const handoff = (fx: Team, run: RunRow, to: string, message = `请做：${to}`) =>
    sys(() => handoffToGroupBot(deps, run, fx.group.id, { bot_id: fx.byName(to).id, message }));
  async function finish(fx: Team, run: RunRow, reply: string, blocks?: MessageBlock[]) {
    await sys(() => prisma.run.update({ where: { id: run.id }, data: { status: "completed" } }));
    return sys(() =>
      afterGroupTurn(deps, run, {
        thread: thread(fx),
        bot: bot(fx, run.botId),
        blocks: blocks ?? [{ kind: "text", text: reply }],
        handoffTargets: [],
        continued: false,
      }),
    );
  }
  const followUps = (fx: Team, name: string) =>
    sys(() =>
      prisma.run.findMany({
        where: { threadId: fx.thread.id, botId: fx.byName(name).id, trigger: "follow_up" },
        orderBy: { createdAt: "asc" },
        include: { task: true },
      }),
    );
  /** The latest follow-up queued for this bot, now started. */
  async function nextRun(fx: Team, name: string): Promise<RunRow> {
    const row = (await followUps(fx, name)).at(-1);
    if (!row) throw new Error(`no follow-up for ${name}`);
    await sys(() => prisma.run.update({ where: { id: row.id }, data: { status: "running" } }));
    return row;
  }
  const texts = async (fx: Team) => {
    const rows = await sys(() =>
      prisma.message.findMany({ where: { threadId: fx.thread.id }, orderBy: { seq: "asc" } }),
    );
    return rows.map((row) =>
      (row.blocks as MessageBlock[])
        .map((block) =>
          block.kind === "text" ? block.text : block.kind === "handoff" ? block.text : "",
        )
        .join(""),
    );
  };
  const teamRow = (fx: Team) =>
    sys(() => prisma.groupTeamRun.findFirstOrThrow({ where: { threadId: fx.thread.id } }));

  it("outside a team run: the question is asked, answered, and routed back to the asker", async () => {
    const fx = await team(["前端", "后端"]);
    const origin = await say(fx, "@前端 做登录页");
    const fe = await wake(fx, origin.id, "前端");
    const asked = await ask(fx, fe, "后端", "登录接口的请求字段和返回字段是什么？");
    expect(asked).toMatchObject({ ok: true, asked: true, botId: fx.byName("后端").id });
    if (!("ok" in asked)) throw new Error("not asked");
    expect(enqueued()).toContain(asked.runId);
    expect((await texts(fx)).at(-1)).toBe("【提问】登录接口的请求字段和返回字段是什么？");
    // The asking turn ends waiting: no stage moves, no claim recheck.
    expect(await finish(fx, fe, "")).toEqual({ suppressClaimRecheck: true });

    const be = await nextRun(fx, "后端");
    expect(be.id).toBe(asked.runId);
    expect(be.sourceMessageId).toBe(asked.questionMessageId);
    expect(
      (await sys(() => prisma.task.findUniqueOrThrow({ where: { id: be.taskId } }))).prompt,
    ).toContain("[teammate question] 前端 asks you a question");
    // The answering turn can neither hand off nor ask in turn.
    expect(await handoff(fx, be, "前端")).toMatchObject({ reason: "answering_question" });
    expect(await ask(fx, be, "前端")).toMatchObject({ reason: "answering_question" });
    expect(await finish(fx, be, "请求：email, password；返回：token, user.id")).toEqual({
      suppressClaimRecheck: true,
    });

    const resumed = await nextRun(fx, "前端");
    expect(resumed.clientNonce).toBe(`group-answer:${asked.questionMessageId}`);
    expect(resumed.sourceMessageId).toBe(asked.questionMessageId);
    const prompt = (
      await sys(() => prisma.task.findUniqueOrThrow({ where: { id: resumed.taskId } }))
    ).prompt;
    expect(prompt).toContain("请求：email, password；返回：token, user.id");
    expect(prompt).toContain("Continue your own stage");
    expect(enqueued()).toContain(resumed.id);
    // Routing the same answer twice wakes the asker once.
    expect(
      await sys(() => wakeAsker(deps, asked.questionMessageId, { kind: "answer", answer: "x" })),
    ).toBeUndefined();
    expect(await followUps(fx, "前端")).toHaveLength(1);
    // The resumed asker may ask again (a new turn) and finishes normally.
    await finish(fx, resumed, "登录页完成，见 src/Login.tsx");
    expect(await followUps(fx, "后端")).toHaveLength(1);
  });

  it("inside a team run: the asker keeps its stage and the leader is not woken until it is done", async () => {
    const fx = await team(["主编", "前端", "后端"]);
    const origin = await say(fx, "@主编 做一个登录功能");
    const leader = await wake(fx, origin.id, "主编");
    await sys(() =>
      teamRunForRun(prisma, leader, thread(fx), bot(fx, leader.botId), { start: true }),
    );
    expect(await handoff(fx, leader, "前端", "做登录页")).toMatchObject({ ok: true });
    await finish(fx, leader, "");
    const fe = await nextRun(fx, "前端");
    const before = await teamRow(fx);
    const asked = await ask(fx, fe, "后端");
    if (!("ok" in asked)) throw new Error("not asked");
    await finish(fx, fe, "");
    const be = await nextRun(fx, "后端");
    await finish(fx, be, "字段：email, password");
    // Questions are not handoffs: no hop, no leader streak, no leader turn.
    expect(await teamRow(fx)).toMatchObject({
      status: "active",
      hops: before.hops,
      leaderTargetStreak: before.leaderTargetStreak,
    });
    expect(await followUps(fx, "主编")).toHaveLength(0);

    const resumed = await nextRun(fx, "前端");
    // The resumed asker still owns the stage it was handed: its chain source is that handoff.
    const stage = await sys(() =>
      stageSourceForHandoff(prisma, resumed, {
        id: asked.questionMessageId,
        botId: fe.botId,
        clientNonce: `group-question:${fe.id}`,
        blocks: [
          { kind: "handoff", fromBotId: fe.botId, toBotId: fx.byName("后端").id, text: "q" },
        ],
      }),
    );
    expect(stage).toEqual({ source: expect.objectContaining({ id: fe.sourceMessageId }) });
    expect(await finish(fx, resumed, "登录页完成，见 src/Login.tsx")).toEqual({
      suppressClaimRecheck: true,
    });
    // Done: the stage goes back to the leader, once.
    const back = await followUps(fx, "主编");
    expect(back).toHaveLength(1);
    expect((await texts(fx)).some((text) => text.includes("前端 已完成，交回 主编"))).toBe(true);
    expect((await teamRow(fx)).hops).toBe(before.hops + 1);
  });

  it("is bounded: one per turn, no self, per-request and per-pair caps", async () => {
    vi.stubEnv("RAKAZO_GROUP_QUESTION_MAX", "4");
    try {
      const fx = await team(["前端", "后端", "测试"]);
      const origin = await say(fx, "@前端 做登录页");
      let fe = await wake(fx, origin.id, "前端");
      expect(await ask(fx, fe, "前端")).toMatchObject({ reason: "self_target" });
      for (let round = 0; round < 3; round++) {
        const asked = await ask(fx, fe, "后端", `问题 ${round}`);
        expect(asked).toMatchObject({ ok: true });
        // A replay of the same call is the same question; a different one is refused.
        expect(await ask(fx, fe, "后端", `问题 ${round}`)).toMatchObject({ ok: true });
        expect(await ask(fx, fe, "测试", "另一个")).toMatchObject({
          reason: "one_question_per_turn",
        });
        await finish(fx, fe, "");
        const be = await nextRun(fx, "后端");
        await finish(fx, be, `答 ${round}`);
        fe = await nextRun(fx, "前端");
      }
      expect(await ask(fx, fe, "后端", "第四个")).toMatchObject({ reason: "pair_limit" });
      expect(await ask(fx, fe, "测试", "测什么？")).toMatchObject({ ok: true });
      await finish(fx, fe, "");
      const tester = await nextRun(fx, "测试");
      await finish(fx, tester, "测登录");
      fe = await nextRun(fx, "前端");
      expect(await ask(fx, fe, "测试", "还有吗？")).toMatchObject({ reason: "question_limit" });
      // A new human request starts a new budget.
      const next = await say(fx, "@前端 再做注册页");
      const fresh = await wake(fx, next.id, "前端");
      expect(await ask(fx, fresh, "后端", "注册字段？")).toMatchObject({ ok: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("wakes the asker with a visible notice when the answer fails or times out, once", async () => {
    const fx = await team(["前端", "后端"]);
    const origin = await say(fx, "@前端 做登录页");
    const fe = await wake(fx, origin.id, "前端");
    const asked = await ask(fx, fe, "后端");
    if (!("ok" in asked)) throw new Error("not asked");
    await finish(fx, fe, "");
    await sys(() => prisma.run.update({ where: { id: asked.runId }, data: { status: "failed" } }));
    await sys(() => reconcileTeammateQuestions(deps));
    await sys(() => reconcileTeammateQuestions(deps));
    const resumed = await followUps(fx, "前端");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.task.prompt).toContain("could not answer");
    expect((await texts(fx)).at(-1)).toBe("后端 没能回答 前端 的提问，前端 先继续自己的任务。");

    // Timeout: an answer still pending after the limit.
    const second = await say(fx, "@前端 做注册页");
    const fe2 = await wake(fx, second.id, "前端");
    const late = await ask(fx, fe2, "后端", "注册字段？");
    if (!("ok" in late)) throw new Error("not asked");
    await finish(fx, fe2, "");
    await sys(() => reconcileTeammateQuestions(deps));
    expect(await followUps(fx, "前端")).toHaveLength(1);
    const later = new Date(Date.now() + 11 * 60_000);
    await sys(() => reconcileTeammateQuestions(deps, later));
    const after = await followUps(fx, "前端");
    expect(after).toHaveLength(2);
    expect(after[1]!.task.prompt).toContain("did not answer in time");
    expect((await texts(fx)).at(-1)).toContain("超时未回答");
    // The answer that arrives after the timeout wakes nobody a second time.
    const be = await nextRun(fx, "后端");
    await finish(fx, be, "注册：email");
    expect(await followUps(fx, "前端")).toHaveLength(2);
  });

  it("routes an answer back across a user-role worker relay", async () => {
    const fx = await team(["前端", "后端"]);
    const origin = await say(fx, "@前端 做登录页");
    const fe = await wake(fx, origin.id, "前端");
    const asked = await ask(fx, fe, "后端");
    if (!("ok" in asked)) throw new Error("not asked");
    await finish(fx, fe, "");
    await sys(() =>
      prisma.$transaction((tx) =>
        createThreadMessageInTransaction(tx, {
          threadId: fx.thread.id,
          role: "user",
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "worker",
              fromBotName: "后台工作者",
              text: "结果已就绪",
              intent: "result",
            },
          ],
        }),
      ),
    );
    const be = await nextRun(fx, "后端");
    await finish(fx, be, "字段：email");
    const resumed = await followUps(fx, "前端");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.clientNonce).toBe(`group-answer:${asked.questionMessageId}`);
  });

  it("does not route an answer back after the user wrote again", async () => {
    const fx = await team(["前端", "后端"]);
    const origin = await say(fx, "@前端 做登录页");
    const fe = await wake(fx, origin.id, "前端");
    const asked = await ask(fx, fe, "后端");
    if (!("ok" in asked)) throw new Error("not asked");
    await finish(fx, fe, "");
    await say(fx, "先停一下");
    const be = await nextRun(fx, "后端");
    await finish(fx, be, "字段：email");
    expect(await followUps(fx, "前端")).toHaveLength(0);
  });

  it("holds a wake while its bot is busy and starts it when that turn ends", async () => {
    const fx = await team(["前端", "后端"]);
    const origin = await say(fx, "@前端 做登录页，@后端 写接口");
    const fe = await wake(fx, origin.id, "前端");
    const busy = await wake(fx, origin.id, "后端");
    const asked = await ask(fx, fe, "后端");
    if (!("ok" in asked)) throw new Error("not asked");
    const held = await sys(() => prisma.run.findUniqueOrThrow({ where: { id: asked.runId } }));
    expect(held.wakeAt?.getTime()).toBeGreaterThan(Date.now() + GROUP_HELD_RUN_MAX_MS - 60_000);
    expect(enqueued()).not.toContain(asked.runId);
    await finish(fx, busy, "接口写好了，见 api/login.ts");
    expect(enqueued()).toContain(asked.runId);
  });

  it("drops short pre-handoff narration once the teammate already replied", async () => {
    const fx = await team(["前端", "后端"]);
    const origin = await say(fx, "@前端 做登录页");
    const fe = await wake(fx, origin.id, "前端");
    expect(await handoff(fx, fe, "后端", "接口交给你")).toMatchObject({ ok: true });
    const narration: MessageBlock[] = [{ kind: "text", text: "我已把接口交给后端，等他回复。" }];
    const settle = () =>
      sys(() => settleHandoffNarration(prisma, fe, { handedOff: true, blocks: narration }));
    expect(await settle()).toEqual(narration);
    await say(fx, "接口好了：POST /login", "后端");
    expect(await settle()).toEqual([]);
    const long: MessageBlock[] = [{ kind: "text", text: "长".repeat(400) }];
    const kept = await sys(() =>
      settleHandoffNarration(prisma, fe, { handedOff: true, blocks: long }),
    );
    expect(kept[0]).toMatchObject({ kind: "text" });
    expect(
      (kept[0] as { text: string }).text.startsWith("（这段是交接前写的，后端 已在上方回复）"),
    ).toBe(true);
  });

  it("asks a member that only claimed to be done for its output, once", async () => {
    const fx = await team(["主编", "撰稿"]);
    const origin = await say(fx, "@主编 写推文");
    const leader = await wake(fx, origin.id, "主编");
    await sys(() =>
      teamRunForRun(prisma, leader, thread(fx), bot(fx, leader.botId), { start: true }),
    );
    await handoff(fx, leader, "撰稿");
    await finish(fx, leader, "");
    const writer = await nextRun(fx, "撰稿");
    expect(await finish(fx, writer, "初稿完成")).toEqual({ suppressClaimRecheck: true });
    expect(await followUps(fx, "主编")).toHaveLength(0);
    const again = await nextRun(fx, "撰稿");
    expect(again.clientNonce).toBe(`stage-output:${writer.sourceMessageId}`);
    expect(again.sourceMessageId).toBe(writer.sourceMessageId);
    // Still bare the second time: the stage returns to the leader as it is.
    await finish(fx, again, "已完成");
    expect(await followUps(fx, "主编")).toHaveLength(1);
    expect(await followUps(fx, "撰稿")).toHaveLength(2);
  });
});
