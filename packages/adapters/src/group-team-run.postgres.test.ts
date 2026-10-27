import { randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import {
  systemHandoffMarker,
  TEAM_RUN_BUDGET_NOTICE,
  TEAM_RUN_LOOP_NOTICE,
  TEAM_RUN_PAUSED_NOTICE,
} from "@rakazo/core";
import { createDb, createThreadMessageInTransaction, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handoffToGroupBot } from "./group-handoff.js";
import { handoffRequestedByHuman } from "./group-requested-handoff.js";
import {
  completeTeamRun,
  continueTeamRun,
  teamRunForRun,
  teamRunPromptContext,
} from "./group-team-run.js";
import { afterGroupTurn } from "./group-turn-end.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

type Member = { name: string; description?: string; title?: string };

postgres("group team runs (PostgreSQL)", () => {
  const { prisma, pool } = createDb(process.env.DATABASE_URL ?? "");
  const sys = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
  const notify = vi.fn(async () => undefined);
  const enqueue = vi.fn(async () => undefined);
  const deps = { prisma, events: { notify }, jobs: { enqueue } } as never;

  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.$disconnect();
    await pool.end();
  });
  beforeAll(() => {
    vi.stubEnv("RAKAZO_GROUP_TEAM_RUN_MAX_HOPS", "");
    vi.stubEnv("RAKAZO_GROUP_TEAM_RUN_MAX_MINUTES", "");
  });

  /** A group whose members join in roster order: the first is the leader. */
  async function team(members: Member[]) {
    const id = `team-run-${randomUUID()}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    return sys(async () => {
      await prisma.user.create({ data: { id: userId, name: "Owner", email: `${id}@rakazo.test` } });
      await prisma.organization.create({
        data: { id: `${id}-org`, name: "Org", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId: `${id}-org`, name: "S" } });
      const bots: Awaited<ReturnType<typeof prisma.bot.create>>[] = [];
      for (const member of members) {
        bots.push(
          await prisma.bot.create({
            data: {
              spaceId,
              userId,
              name: member.name,
              color: "ink",
              description: member.description ?? "",
              title: member.title ?? "",
            },
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

  async function human(fx: Team, text: string) {
    return sys(() =>
      prisma.$transaction((tx) =>
        createThreadMessageInTransaction(tx, {
          threadId: fx.thread.id,
          role: "user",
          blocks: [{ kind: "text", text }],
        }),
      ),
    );
  }

  /** The human message woke these bots, like thread-target does. */
  async function wake(fx: Team, messageId: string, ...names: string[]) {
    const runs = [];
    for (const name of names) {
      const botId = fx.byName(name).id;
      runs.push(
        await sys(async () => {
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
        }),
      );
    }
    return runs;
  }

  type RunRow = Awaited<ReturnType<typeof wake>>[number];

  const bot = (fx: Team, id: string) => {
    const row = fx.bots.find((entry) => entry.id === id);
    if (!row) throw new Error(id);
    return row;
  };
  const thread = (fx: Team) => ({ groupId: fx.group.id });
  const start = (fx: Team, run: RunRow) =>
    sys(() => teamRunForRun(prisma, run, thread(fx), bot(fx, run.botId), { start: true }));
  const handoff = (fx: Team, run: RunRow, to: string, message = `请做：${to}`) =>
    sys(() => handoffToGroupBot(deps, run, fx.group.id, { bot_id: fx.byName(to).id, message }));
  /** The run's turn completed with this reply; then the system's after-turn steps. */
  async function finish(fx: Team, run: RunRow, reply: string, blocks?: MessageBlock[]) {
    await sys(() => prisma.run.update({ where: { id: run.id }, data: { status: "completed" } }));
    await sys(() =>
      afterGroupTurn(deps, run, {
        thread: thread(fx),
        bot: bot(fx, run.botId),
        blocks: blocks ?? [{ kind: "text", text: reply }],
        handoffTargets: [],
        continued: false,
      }),
    );
  }
  /** The run the last handoff (or nudge) queued for this bot. */
  async function nextRun(fx: Team, name: string): Promise<RunRow> {
    const row = await sys(() =>
      prisma.run.findFirstOrThrow({
        where: { threadId: fx.thread.id, botId: fx.byName(name).id, trigger: "follow_up" },
        orderBy: { createdAt: "desc" },
      }),
    );
    await sys(() => prisma.run.update({ where: { id: row.id }, data: { status: "running" } }));
    return row;
  }
  const teamRow = (fx: Team) =>
    sys(() => prisma.groupTeamRun.findFirstOrThrow({ where: { threadId: fx.thread.id } }));
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

  /** Leader → each stage → back to the leader → … → complete_team_run. */
  async function fullRun(members: Member[], request: string, stages: string[]) {
    const fx = await team(members);
    const leaderName = members[0]!.name;
    const origin = await human(fx, request);
    const [leaderRun] = await wake(fx, origin.id, leaderName);
    const view = await start(fx, leaderRun!);
    expect(view).toMatchObject({ role: "leader", interrupted: false });
    let leader = leaderRun!;
    for (const [index, stage] of stages.entries()) {
      expect(await handoff(fx, leader, stage)).toMatchObject({ ok: true });
      await finish(fx, leader, `已交给 ${stage}`);
      const member = await nextRun(fx, stage);
      const memberView = await sys(() =>
        teamRunForRun(prisma, member, thread(fx), bot(fx, member.botId)),
      );
      expect(memberView?.role).toBe("member");
      await finish(fx, member, `${stage} 的产出 #${index}`);
      leader = await nextRun(fx, leaderName);
      expect((await teamRow(fx)).hops).toBe((index + 1) * 2);
    }
    const closed = await sys(() =>
      completeTeamRun(deps, leader, thread(fx), bot(fx, leader.botId), {
        summary: "全部完成",
        deliverables: ["https://x.test/result"],
        open_issues: [],
      }),
    );
    expect(closed).toMatchObject({ ok: true });
    await finish(fx, leader, "");
    const row = await teamRow(fx);
    expect(row).toMatchObject({ status: "completed", endReason: "leader_completed" });
    const all = await texts(fx);
    for (const [index, stage] of stages.entries()) {
      expect(all).toContainEqual(
        `${stage} 已完成，交回 ${leaderName}。\n\n${stage} 的结果：\n${stage} 的产出 #${index}`,
      );
    }
    expect(all.at(-1)).toBe("✅ 团队任务完成\n全部完成\n交付物：\n- https://x.test/result");
    // A closed run takes no more automatic steps.
    expect(
      await sys(() =>
        completeTeamRun(deps, leader, thread(fx), bot(fx, leader.botId), { summary: "x" }),
      ),
    ).toMatchObject({ error: expect.any(String) });
    return fx;
  }

  it("runs a dev team end to end: leader → backend → back → frontend → back → tester → back → done", async () => {
    await fullRun(
      [
        { name: "团队-产品", description: "需求和验收标准" },
        { name: "团队-后端", description: "接口和数据" },
        { name: "团队-前端", description: "页面" },
        { name: "团队-测试", description: "按验收标准验证" },
      ],
      "@团队-产品 给待办清单加截止日期",
      ["团队-后端", "团队-前端", "团队-测试"],
    );
  });

  it("runs a writing team the same way, with no dev roles anywhere", async () => {
    const fx = await fullRun(
      [
        { name: "策划", description: "选题和大纲" },
        { name: "撰稿", description: "写正文" },
        { name: "审校", description: "检查事实和错别字" },
      ],
      "@策划 写一篇新品推文",
      ["撰稿", "审校"],
    );
    expect(fx.bots.map((entry) => entry.name)).toEqual(["策划", "撰稿", "审校"]);
  });

  it("tells each role about the run, with the roster from descriptions or bare names", async () => {
    const fx = await team([
      { name: "外贸-主管" },
      { name: "外贸-跟单", title: "订单跟进" },
      { name: "外贸-单证", description: "报关和单据" },
    ]);
    const origin = await human(fx, "@外贸-主管 给德国客户做一份报价");
    const [leaderRun] = await wake(fx, origin.id, "外贸-主管");
    const view = await start(fx, leaderRun!);
    const prompt = await sys(() => teamRunPromptContext(prisma, view));
    expect(prompt).toContain(
      "You lead this group's team task. The user's request: @外贸-主管 给德国客户做一份报价",
    );
    expect(prompt).toMatch(/^- 外贸-主管$/m);
    expect(prompt).toContain("- 外贸-跟单: 订单跟进");
    expect(prompt).toContain("- 外贸-单证: 报关和单据");
    expect(await handoff(fx, leaderRun!, "外贸-单证")).toMatchObject({ ok: true });
    const member = await nextRun(fx, "外贸-单证");
    const memberView = await sys(() =>
      teamRunForRun(prisma, member, thread(fx), bot(fx, member.botId)),
    );
    const memberPrompt = await sys(() => teamRunPromptContext(prisma, memberView));
    expect(memberPrompt).toContain("led by 外贸-主管");
    expect(memberPrompt).not.toContain("complete_team_run");
  });

  it("does not start a run for a non-leader, a message that woke two members, or plain chat", async () => {
    const fx = await team([{ name: "策划" }, { name: "撰稿" }, { name: "审校" }]);
    const toMember = await human(fx, "@撰稿 改一下标题");
    const [memberRun] = await wake(fx, toMember.id, "撰稿");
    expect(await start(fx, memberRun!)).toBeUndefined();
    const toTwo = await human(fx, "@策划 @撰稿 一起看看");
    const [a] = await wake(fx, toTwo.id, "策划", "撰稿");
    expect(await start(fx, a!)).toBeUndefined();
    // The leader just answers: the run ends quietly, with nothing posted.
    const chat = await human(fx, "@策划 你好");
    const [hello] = await wake(fx, chat.id, "策划");
    expect(await start(fx, hello!)).toBeDefined();
    const before = (await texts(fx)).length;
    await finish(fx, hello!, "你好！");
    expect(
      await sys(() => prisma.groupTeamRun.findMany({ where: { threadId: fx.thread.id } })),
    ).toEqual([expect.objectContaining({ status: "answered", originMessageId: chat.id })]);
    expect((await texts(fx)).length).toBe(before);
    expect(await sys(() => prisma.groupTeamRun.count({ where: { threadId: fx.thread.id } }))).toBe(
      1,
    );
  });

  it("nudges a leader that stopped once, then pauses with a visible line", async () => {
    const fx = await team([{ name: "策划" }, { name: "撰稿" }]);
    const origin = await human(fx, "@策划 写推文");
    const [leaderRun] = await wake(fx, origin.id, "策划");
    await start(fx, leaderRun!);
    await handoff(fx, leaderRun!, "撰稿");
    await finish(fx, leaderRun!, "");
    const writer = await nextRun(fx, "撰稿");
    await finish(fx, writer, "正文好了");
    const back = await nextRun(fx, "策划");
    await finish(fx, back, "看起来不错。");
    expect(await teamRow(fx)).toMatchObject({ status: "active", nudges: 1 });
    const nudge = await nextRun(fx, "策划");
    expect((await texts(fx)).at(-1)).toContain("系统提醒 策划");
    // Running the nudge twice (a retried job) cannot post a second one.
    await finish(fx, back, "看起来不错。");
    expect(
      await sys(() =>
        prisma.run.count({
          where: { threadId: fx.thread.id, botId: fx.byName("策划").id, trigger: "follow_up" },
        }),
      ),
    ).toBe(2);
    await finish(fx, nudge, "好的。");
    expect(await teamRow(fx)).toMatchObject({ status: "paused", endReason: "leader_stalled" });
    expect((await texts(fx)).at(-1)).toBe(TEAM_RUN_PAUSED_NOTICE);
  });

  it("does not nudge a leader that asked the user something; it pauses quietly", async () => {
    const fx = await team([{ name: "策划" }, { name: "撰稿" }]);
    const origin = await human(fx, "@策划 写推文");
    const [leaderRun] = await wake(fx, origin.id, "策划");
    await start(fx, leaderRun!);
    await handoff(fx, leaderRun!, "撰稿");
    const writer = await nextRun(fx, "撰稿");
    // A member that asks the user keeps the stage; nothing goes back to the leader.
    await finish(fx, writer, "目标读者是谁？");
    expect(
      await sys(() =>
        prisma.run.count({ where: { threadId: fx.thread.id, botId: fx.byName("策划").id } }),
      ),
    ).toBe(1);
    expect(await teamRow(fx)).toMatchObject({ status: "active", hops: 1 });
  });

  it("stops at the hop budget with a visible notice", async () => {
    vi.stubEnv("RAKAZO_GROUP_TEAM_RUN_MAX_HOPS", "2");
    try {
      const fx = await team([{ name: "策划" }, { name: "撰稿" }, { name: "审校" }]);
      const origin = await human(fx, "@策划 写推文");
      const [leaderRun] = await wake(fx, origin.id, "策划");
      await start(fx, leaderRun!);
      await handoff(fx, leaderRun!, "撰稿");
      const writer = await nextRun(fx, "撰稿");
      await finish(fx, writer, "初稿");
      const back = await nextRun(fx, "策划");
      expect(await handoff(fx, back, "审校")).toMatchObject({ reason: "team_budget" });
      expect(await teamRow(fx)).toMatchObject({ status: "stopped", endReason: "budget", hops: 2 });
      await finish(fx, back, "");
      expect((await texts(fx)).filter((text) => text === TEAM_RUN_BUDGET_NOTICE)).toHaveLength(0);
      // The ended run takes no further automatic step.
      expect(
        await sys(() =>
          prisma.run.count({ where: { threadId: fx.thread.id, botId: fx.byName("审校").id } }),
        ),
      ).toBe(0);
    } finally {
      vi.stubEnv("RAKAZO_GROUP_TEAM_RUN_MAX_HOPS", "");
    }
  });

  it("posts the budget notice when a member's automatic return hits it", async () => {
    vi.stubEnv("RAKAZO_GROUP_TEAM_RUN_MAX_HOPS", "1");
    try {
      const fx = await team([{ name: "策划" }, { name: "撰稿" }]);
      const origin = await human(fx, "@策划 写推文");
      const [leaderRun] = await wake(fx, origin.id, "策划");
      await start(fx, leaderRun!);
      await handoff(fx, leaderRun!, "撰稿");
      const writer = await nextRun(fx, "撰稿");
      await finish(fx, writer, "初稿");
      expect(await teamRow(fx)).toMatchObject({ status: "stopped" });
      expect((await texts(fx)).at(-1)).toBe(TEAM_RUN_BUDGET_NOTICE);
    } finally {
      vi.stubEnv("RAKAZO_GROUP_TEAM_RUN_MAX_HOPS", "");
    }
  });

  it("stops at the time budget", async () => {
    const fx = await team([{ name: "策划" }, { name: "撰稿" }]);
    const origin = await human(fx, "@策划 写推文");
    const [leaderRun] = await wake(fx, origin.id, "策划");
    const view = await start(fx, leaderRun!);
    await sys(() =>
      prisma.groupTeamRun.update({
        where: { id: view!.row.id },
        data: { createdAt: new Date(Date.now() - 61 * 60_000) },
      }),
    );
    expect(await handoff(fx, leaderRun!, "撰稿")).toMatchObject({ reason: "team_budget" });
  });

  it("stops a leader that keeps sending the same stage back", async () => {
    const fx = await team([{ name: "策划" }, { name: "撰稿" }]);
    const origin = await human(fx, "@策划 写推文");
    const [leaderRun] = await wake(fx, origin.id, "策划");
    await start(fx, leaderRun!);
    let leader = leaderRun!;
    for (let round = 0; round < 3; round++) {
      expect(await handoff(fx, leader, "撰稿", `第 ${round} 版`)).toMatchObject({ ok: true });
      const writer = await nextRun(fx, "撰稿");
      await finish(fx, writer, `稿 ${round}`);
      leader = await nextRun(fx, "策划");
    }
    expect(await handoff(fx, leader, "撰稿", "再改")).toMatchObject({ reason: "team_loop" });
    expect(await teamRow(fx)).toMatchObject({ status: "paused", endReason: "loop" });
    await finish(fx, leader, "");
    expect(await texts(fx)).not.toContain(TEAM_RUN_PAUSED_NOTICE);
    expect(TEAM_RUN_LOOP_NOTICE).toContain("反复往返");
  });

  it("still refuses two members bouncing a stage between themselves", async () => {
    const fx = await team([{ name: "策划" }, { name: "撰稿" }, { name: "审校" }]);
    const origin = await human(fx, "@策划 写推文");
    const [leaderRun] = await wake(fx, origin.id, "策划");
    await start(fx, leaderRun!);
    await handoff(fx, leaderRun!, "撰稿");
    const writer = await nextRun(fx, "撰稿");
    expect(await handoff(fx, writer, "审校")).toMatchObject({ ok: true });
    const editor = await nextRun(fx, "审校");
    expect(await handoff(fx, editor, "撰稿")).toMatchObject({ reason: "hand_back" });
    // Back to the leader is always allowed inside the run.
    expect(await handoff(fx, editor, "策划")).toMatchObject({ ok: true });
  });

  it("lets a newer human message win: the run stops and nobody is woken automatically", async () => {
    const fx = await team([{ name: "策划" }, { name: "撰稿" }]);
    const origin = await human(fx, "@策划 写推文");
    const [leaderRun] = await wake(fx, origin.id, "策划");
    await start(fx, leaderRun!);
    await handoff(fx, leaderRun!, "撰稿");
    const writer = await nextRun(fx, "撰稿");
    await human(fx, "等等，换个主题");
    expect(await handoff(fx, writer, "策划")).toMatchObject({ reason: "team_interrupted" });
    await finish(fx, writer, "初稿");
    expect(await teamRow(fx)).toMatchObject({ status: "superseded" });
    expect(
      await sys(() =>
        prisma.run.count({ where: { threadId: fx.thread.id, botId: fx.byName("策划").id } }),
      ),
    ).toBe(1);
  });

  it("does not nudge a leader after a newer human message; the run just stops", async () => {
    const fx = await team([{ name: "策划" }, { name: "撰稿" }]);
    const origin = await human(fx, "@策划 写推文");
    const [leaderRun] = await wake(fx, origin.id, "策划");
    await start(fx, leaderRun!);
    await handoff(fx, leaderRun!, "撰稿");
    const writer = await nextRun(fx, "撰稿");
    await finish(fx, writer, "初稿");
    const back = await nextRun(fx, "策划");
    await human(fx, "先停一下");
    await finish(fx, back, "收到初稿。");
    expect(await teamRow(fx)).toMatchObject({ status: "superseded", nudges: 0 });
    expect((await texts(fx)).some((text) => text.includes("系统提醒"))).toBe(false);
  });

  it("waits for a member's background task instead of returning the stage early", async () => {
    const fx = await team([{ name: "策划" }, { name: "撰稿" }]);
    const origin = await human(fx, "@策划 写推文");
    const [leaderRun] = await wake(fx, origin.id, "策划");
    await start(fx, leaderRun!);
    await handoff(fx, leaderRun!, "撰稿");
    const writer = await nextRun(fx, "撰稿");
    await sys(() =>
      prisma.backgroundTaskQueue.create({
        data: {
          spaceId: fx.spaceId,
          botId: writer.botId,
          userId: fx.userId,
          runId: writer.id,
          threadId: fx.thread.id,
          name: "资料",
          task: "collect sources",
          args: {},
          status: "started",
          ref: "W1",
          startedAt: new Date(),
        },
      }),
    );
    await finish(fx, writer, "我先去查资料");
    expect(
      await sys(() =>
        prisma.run.count({ where: { threadId: fx.thread.id, botId: fx.byName("策划").id } }),
      ),
    ).toBe(1);
    expect(await teamRow(fx)).toMatchObject({ status: "active", hops: 1 });
  });

  it("refuses complete_team_run from a member", async () => {
    const fx = await team([{ name: "策划" }, { name: "撰稿" }]);
    const origin = await human(fx, "@策划 写推文");
    const [leaderRun] = await wake(fx, origin.id, "策划");
    await start(fx, leaderRun!);
    await handoff(fx, leaderRun!, "撰稿");
    const writer = await nextRun(fx, "撰稿");
    expect(
      await sys(() =>
        completeTeamRun(deps, writer, thread(fx), bot(fx, writer.botId), { summary: "完成" }),
      ),
    ).toMatchObject({ error: expect.stringContaining("no active team task that you lead") });
    expect(
      await sys(() => completeTeamRun(deps, leaderRun!, thread(fx), bot(fx, leaderRun!.botId), {})),
    ).toEqual({ error: "summary is required" });
    expect(await teamRow(fx)).toMatchObject({ status: "active" });
  });

  describe("the handoff a human asked for", () => {
    const members = [{ name: "策划" }, { name: "撰稿" }, { name: "审校" }];

    it("is made by the system when the bot finished without it, marked as such", async () => {
      const fx = await team(members);
      const msg = await human(fx, "@撰稿 写正文，然后交给审校");
      const [writer] = await wake(fx, msg.id, "撰稿");
      await finish(fx, writer!, "正文写好了：https://x.test/doc");
      const editor = await nextRun(fx, "审校");
      const handoffMessage = await sys(() =>
        prisma.message.findUniqueOrThrow({ where: { id: editor.sourceMessageId! } }),
      );
      const block = (handoffMessage.blocks as MessageBlock[]).find(
        (entry) => entry.kind === "handoff",
      );
      expect(block).toMatchObject({
        kind: "handoff",
        fromBotId: writer!.botId,
        toBotId: fx.byName("审校").id,
      });
      const text = block?.kind === "handoff" ? block.text : "";
      expect(text).toContain(systemHandoffMarker("审校"));
      expect(text).toContain("撰稿 的结果：\n正文写好了：https://x.test/doc");
      expect(text).toContain("https://x.test/doc");
    });

    it("is not made twice when the bot already handed off", async () => {
      const fx = await team(members);
      const msg = await human(fx, "@撰稿 写正文，然后交给审校");
      const [writer] = await wake(fx, msg.id, "撰稿");
      await handoff(fx, writer!, "审校", "请审");
      await finish(fx, writer!, "已交给审校");
      expect(
        await sys(() =>
          prisma.run.count({ where: { threadId: fx.thread.id, botId: fx.byName("审校").id } }),
        ),
      ).toBe(1);
      expect(await texts(fx)).not.toContain(expect.stringContaining("未能"));
    });

    for (const [label, request, reply] of [
      ["the request is negated", "@撰稿 写正文，先别交给审校", "正文写好了"],
      ["the bot asks the user", "@撰稿 写正文，然后交给审校", "要写多长？"],
      ["the bot refuses", "@撰稿 写正文，然后交给审校", "这个我无法交给审校，缺少素材。"],
      ["it is only a question", "@撰稿 要不要交给审校？", "可以交。"],
    ] as const) {
      it(`is not made when ${label}`, async () => {
        const fx = await team(members);
        const msg = await human(fx, request);
        const [writer] = await wake(fx, msg.id, "撰稿");
        await finish(fx, writer!, reply);
        expect(
          await sys(() =>
            prisma.run.count({ where: { threadId: fx.thread.id, botId: fx.byName("审校").id } }),
          ),
        ).toBe(0);
      });
    }

    it("is not made for a failed turn, a steered turn, or a bot-authored request", async () => {
      const fx = await team(members);
      const msg = await human(fx, "@撰稿 写正文，然后交给审校");
      const [writer] = await wake(fx, msg.id, "撰稿");
      const input = {
        groupId: fx.group.id,
        bot: bot(fx, writer!.botId),
        replyText: "好了",
        waitsOnUser: false,
        handoffTargets: [],
      };
      await sys(() => handoffRequestedByHuman(deps, writer!, { ...input, continued: true }));
      await sys(() =>
        handoffRequestedByHuman(
          deps,
          { ...writer!, trigger: "follow_up" },
          { ...input, continued: false },
        ),
      );
      const botMsg = await sys(() =>
        prisma.$transaction((tx) =>
          createThreadMessageInTransaction(tx, {
            threadId: fx.thread.id,
            role: "bot",
            botId: fx.byName("策划").id,
            blocks: [{ kind: "text", text: "@撰稿 写完交给审校" }],
          }),
        ),
      );
      // A bot's message that woke this bot is never a human's request.
      const [woken] = await wake(fx, botMsg.id, "撰稿");
      await sys(() => handoffRequestedByHuman(deps, woken!, { ...input, continued: false }));
      expect(
        await sys(() =>
          prisma.run.count({ where: { threadId: fx.thread.id, botId: fx.byName("审校").id } }),
        ),
      ).toBe(0);
    });

    it("works inside a team run and counts against its budget", async () => {
      const fx = await team(members);
      const msg = await human(fx, "@策划 列大纲，然后交给撰稿");
      const [leader] = await wake(fx, msg.id, "策划");
      await start(fx, leader!);
      await finish(fx, leader!, "大纲：1. 开头 2. 卖点");
      const writer = await nextRun(fx, "撰稿");
      expect(writer.botId).toBe(fx.byName("撰稿").id);
      expect(await teamRow(fx)).toMatchObject({ status: "active", hops: 1 });
      await finish(fx, writer, "正文");
      expect(await nextRun(fx, "策划")).toBeDefined();
      expect(await teamRow(fx)).toMatchObject({ hops: 2 });
    });
  });
});
