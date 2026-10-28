import { randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import { TEAM_RUN_STOPPED_HEADER } from "@rakazo/core";
import { createDb, createThreadMessageInTransaction, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CLAIM_RECHECK_MARKER, queueClaimRecheck } from "./dispatcher-reply-guard.js";
import { handoffToGroupBot } from "./group-handoff.js";
import { completeTeamRun, teamRunForRun, teamRunPromptContext } from "./group-team-run.js";
import { afterGroupTurn } from "./group-turn-end.js";

/**
 * Team run polish: an interrupted run always closes (retries date from their first attempt, and
 * a newer human message ends older runs at once), nothing posts after a run ended (queued nudges
 * and claim rechecks are cancelled, and no recheck is queued behind the run's own next turn), and
 * a run the user stopped reads and records as stopped.
 */

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

type Member = { name: string; description?: string; title?: string };

postgres("group team run polish (PostgreSQL)", () => {
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

  const members: Member[] = [{ name: "主编" }, { name: "撰稿" }, { name: "审校" }];
  const rows = (fx: Team) =>
    sys(() =>
      prisma.groupTeamRun.findMany({
        where: { threadId: fx.thread.id },
        orderBy: { createdAt: "asc" },
      }),
    );
  const runStatus = (id: string) =>
    sys(() => prisma.run.findUniqueOrThrow({ where: { id }, include: { task: true } }));
  /** A later attempt of `run` (a dispatcher restart after a timeout), created now. */
  async function retryOf(run: RunRow): Promise<RunRow> {
    return sys(async () => {
      const task = await prisma.task.create({
        data: {
          spaceId: run.spaceId,
          botId: run.botId,
          threadId: run.threadId,
          userId: run.userId,
          prompt: "p",
          status: "running",
        },
      });
      return prisma.run.create({
        data: {
          spaceId: run.spaceId,
          botId: run.botId,
          threadId: run.threadId,
          taskId: task.id,
          userId: run.userId,
          status: "running",
          trigger: run.trigger,
          sourceMessageId: run.sourceMessageId,
          retryOfRunId: run.id,
        },
      });
    });
  }
  /** Leader started a run and handed the first stage to 撰稿, whose turn is running. */
  async function underway() {
    const fx = await team(members);
    const origin = await human(fx, "写一篇关于秋天的文章");
    const [leader] = await wake(fx, origin.id, "主编");
    expect(await start(fx, leader!)).toMatchObject({ role: "leader" });
    expect(await handoff(fx, leader!, "撰稿")).toMatchObject({ ok: true });
    await finish(fx, leader!, "已交给撰稿");
    const writer = await nextRun(fx, "撰稿");
    return { fx, origin, leader: leader!, writer };
  }

  describe("an interrupted run closes", () => {
    it("dates a retried attempt from its first attempt, so the stop ends the run", async () => {
      const { fx, writer } = await underway();
      await human(fx, "先停一下");
      // The writer's turn timed out and was retried after the human's stop.
      const retry = await retryOf(writer);
      const view = await sys(() => teamRunForRun(prisma, retry, thread(fx), bot(fx, retry.botId)));
      expect(view).toMatchObject({ role: "member", interrupted: true });
      await finish(fx, retry, "草稿写好了");
      expect(await teamRow(fx)).toMatchObject({ status: "superseded", endReason: "human_message" });
      // Nothing was handed back to the leader for the stopped run.
      expect(
        (await texts(fx)).some((text) => text.includes("草稿写好了") && text.includes("主编")),
      ).toBe(false);
    });

    it("follows a retry chain of several attempts", async () => {
      const { fx, writer } = await underway();
      const first = await retryOf(writer);
      await human(fx, "换个题目");
      const second = await retryOf(first);
      const view = await sys(() =>
        teamRunForRun(prisma, second, thread(fx), bot(fx, second.botId)),
      );
      expect(view?.interrupted).toBe(true);
    });

    it("ends the earlier run as soon as the stop message's turn starts", async () => {
      const { fx } = await underway();
      const stop = await human(fx, "先停一下");
      const [leaderStop] = await wake(fx, stop.id, "主编");
      const view = await start(fx, leaderStop!);
      const [first, second] = await rows(fx);
      expect(first).toMatchObject({ status: "superseded", endReason: "human_message" });
      expect(first?.endedAt).toBeInstanceOf(Date);
      expect(second).toMatchObject({ status: "active", originMessageId: stop.id });
      expect(view).toMatchObject({ role: "leader", interruptedGoal: "写一篇关于秋天的文章" });
      const prompt = await sys(() => teamRunPromptContext(prisma, view));
      expect(prompt).toContain("写一篇关于秋天的文章");
      expect(prompt).toContain('outcome "stopped"');
    });

    it("says nothing about an earlier run when there was none", async () => {
      const fx = await team(members);
      const origin = await human(fx, "写一篇文章");
      const [leader] = await wake(fx, origin.id, "主编");
      const view = await start(fx, leader!);
      expect(view?.interruptedGoal).toBeUndefined();
      expect(await sys(() => teamRunPromptContext(prisma, view))).not.toContain(
        "earlier team task",
      );
    });
  });

  describe("a stopped run reads and records as stopped", () => {
    it("closes the stop request's run as stopped when nothing was handed out", async () => {
      const { fx } = await underway();
      const stop = await human(fx, "先停一下");
      const [leaderStop] = await wake(fx, stop.id, "主编");
      await start(fx, leaderStop!);
      const result = await sys(() =>
        completeTeamRun(deps, leaderStop!, thread(fx), bot(fx, leaderStop!.botId), {
          summary: "已按你的要求停止，撰稿未交稿。",
        }),
      );
      expect(result).toMatchObject({ ok: true });
      const [, closed] = await rows(fx);
      expect(closed).toMatchObject({ status: "stopped", endReason: "leader_stopped" });
      const last = (await texts(fx)).at(-1) ?? "";
      expect(last.startsWith(TEAM_RUN_STOPPED_HEADER)).toBe(true);
      expect(last).not.toContain("团队任务完成");
    });

    it("honours an explicit outcome: stopped on a run that handed work out", async () => {
      const { fx, leader } = await underway();
      const result = await sys(() =>
        completeTeamRun(deps, leader, thread(fx), bot(fx, leader.botId), {
          summary: "用户要求停止",
          outcome: "stopped",
          open_issues: ["正文未完成"],
        }),
      );
      expect(result).toMatchObject({ ok: true });
      expect(await teamRow(fx)).toMatchObject({ status: "stopped", endReason: "leader_stopped" });
      const last = (await texts(fx)).at(-1) ?? "";
      expect(last).toContain(TEAM_RUN_STOPPED_HEADER);
      expect(last).toContain("正文未完成");
    });

    it("keeps an explicit completed outcome after an interruption", async () => {
      const { fx } = await underway();
      const redo = await human(fx, "不用了，直接给我一句话总结");
      const [leaderRedo] = await wake(fx, redo.id, "主编");
      await start(fx, leaderRedo!);
      await sys(() =>
        completeTeamRun(deps, leaderRedo!, thread(fx), bot(fx, leaderRedo!.botId), {
          summary: "一句话总结已给出",
          outcome: "completed",
        }),
      );
      const [, closed] = await rows(fx);
      expect(closed).toMatchObject({ status: "completed", endReason: "leader_completed" });
      expect((await texts(fx)).at(-1)).toContain("✅ 团队任务完成");
    });
  });

  describe("nothing posts after a run ended", () => {
    /** The writer handed the stage back; the leader's turn ended without handing on. */
    async function leaderStalled() {
      const { fx, origin, writer } = await underway();
      await finish(fx, writer, "初稿完成");
      const leader = await nextRun(fx, "主编");
      const stalled = await finish(fx, leader, "收到，我来汇总。");
      return { fx, origin, leader, stalled };
    }
    const nudgeRun = (fx: Team) =>
      sys(() =>
        prisma.run.findFirstOrThrow({
          where: {
            threadId: fx.thread.id,
            sourceMessage: { clientNonce: { startsWith: "team-nudge:" } },
          },
        }),
      );

    it("queues no claim recheck behind the run's own next turn", async () => {
      const { fx, writer } = await underway();
      // A member that finished hands the stage back to the leader: that turn follows.
      expect(await finish(fx, writer, "初稿完成")).toEqual({ suppressClaimRecheck: true });
      const leader = await nextRun(fx, "主编");
      // The leader stopped without handing on: the nudge follows.
      expect(await finish(fx, leader, "收到")).toEqual({ suppressClaimRecheck: true });
      expect((await nudgeRun(fx)).status).toBe("queued");
    });

    it("keeps the claim recheck when the leader simply answered", async () => {
      const fx = await team(members);
      const origin = await human(fx, "你们好");
      const [leader] = await wake(fx, origin.id, "主编");
      await start(fx, leader!);
      expect(await finish(fx, leader!, "你好！")).toEqual({ suppressClaimRecheck: false });
      expect(await teamRow(fx)).toMatchObject({ status: "answered" });
    });

    it("suppresses the recheck of a turn whose run already closed", async () => {
      const { fx, writer } = await underway();
      await finish(fx, writer, "初稿完成");
      const back = await nextRun(fx, "主编");
      await sys(() =>
        completeTeamRun(deps, back, thread(fx), bot(fx, back.botId), { summary: "文章完成" }),
      );
      expect(await finish(fx, back, "已完成")).toEqual({ suppressClaimRecheck: true });
    });

    it("cancels the queued nudge and claim recheck when the run is closed", async () => {
      const { fx, leader } = await leaderStalled();
      const nudge = await nudgeRun(fx);
      expect(nudge.status).toBe("queued");
      // The guard flagged the stalled turn's claim before this fix suppressed it.
      expect(
        await sys(() =>
          queueClaimRecheck(deps, { ...leader, taskId: leader.taskId }, "已安排后台汇总"),
        ),
      ).toBe(true);
      const recheck = await sys(() =>
        prisma.run.findFirstOrThrow({ where: { retryOfRunId: leader.id } }),
      );
      // The leader closes the run from another turn (the nudge already ran in production).
      await sys(() =>
        completeTeamRun(deps, leader, thread(fx), bot(fx, leader.botId), { summary: "文章完成" }),
      );
      expect(await teamRow(fx)).toMatchObject({ status: "completed" });
      for (const id of [nudge.id, recheck.id]) {
        const row = await runStatus(id);
        expect(row.status).toBe("cancelled");
        expect(row.completedAt).toBeInstanceOf(Date);
        expect(row.task.status).toBe("cancelled");
      }
      const summaries = (await texts(fx)).filter((text) => text.includes("团队任务完成"));
      expect(summaries).toHaveLength(1);
    });

    it("never touches a follow-up that already started", async () => {
      const { fx, leader } = await leaderStalled();
      const nudge = await nudgeRun(fx);
      await sys(() =>
        prisma.run.update({
          where: { id: nudge.id },
          data: { status: "leased", leaseOwner: "worker-1" },
        }),
      );
      await sys(() =>
        completeTeamRun(deps, leader, thread(fx), bot(fx, leader.botId), { summary: "文章完成" }),
      );
      expect((await runStatus(nudge.id)).status).toBe("leased");
    });

    it("cancels the nudge when a newer human message ends the run", async () => {
      const { fx } = await leaderStalled();
      const nudge = await nudgeRun(fx);
      const next = await human(fx, "先停一下");
      const [leaderStop] = await wake(fx, next.id, "主编");
      await start(fx, leaderStop!);
      expect((await rows(fx))[0]).toMatchObject({ status: "superseded" });
      expect((await runStatus(nudge.id)).status).toBe("cancelled");
    });

    it("leaves a claim recheck of a later request alone", async () => {
      const { fx, leader } = await leaderStalled();
      const other = await human(fx, "另外，帮我查下天气");
      const [solo] = await wake(fx, other.id, "撰稿", "审校");
      await sys(() => queueClaimRecheck(deps, { ...solo!, taskId: solo!.taskId }, "已安排"));
      const later = await sys(() =>
        prisma.run.findFirstOrThrow({ where: { retryOfRunId: solo!.id } }),
      );
      const task = await sys(() => prisma.task.findUniqueOrThrow({ where: { id: later.taskId } }));
      expect(task.prompt).toContain(CLAIM_RECHECK_MARKER);
      // The leader's late close finds its run interrupted: only that run's follow-ups go.
      await sys(() =>
        completeTeamRun(deps, leader, thread(fx), bot(fx, leader.botId), { summary: "完成" }),
      );
      expect((await runStatus(later.id)).status).toBe("queued");
    });
  });
});
