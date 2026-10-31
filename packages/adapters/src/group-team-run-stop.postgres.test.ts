import { randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import { TEAM_RUN_STOPPED_HEADER } from "@rakazo/core";
import { createDb, createThreadMessageInTransaction, runAsSystem } from "@rakazo/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { announceQueuedTaskStart } from "./background-task-cards.js";
import { refreshTaskProgressCard } from "./background-task-progress.js";
import { launchBackgroundTask, startQueuedBackgroundTasks } from "./background-tasks.js";
import { messageBot } from "./bot-messages.js";
import { createRunExecutor } from "./executor.js";
import { handoffToGroupBot } from "./group-handoff.js";
import { completeTeamRun, teamRunForRun } from "./group-team-run.js";
import { supersedeEarlierTeamRuns } from "./group-team-run-close.js";
import { endTeamRun } from "./group-team-run-gate.js";
import { refuseStoppedTeamRunWork, teamRunOwningWork } from "./group-team-run-stop.js";
import { afterGroupTurn } from "./group-turn-end.js";
import { watchRunCancellation } from "./run-cancel-watch.js";
import { publishMessage } from "./run-messages.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("stopping team work (PostgreSQL)", () => {
  const { prisma, pool } = createDb(process.env.DATABASE_URL ?? "");
  const sys = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
  const deps = {
    prisma,
    events: { notify: vi.fn(async () => undefined) },
    jobs: { enqueue: vi.fn(async () => undefined) },
  };
  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  async function setup() {
    const id = `team-stop-${randomUUID()}`;
    await prisma.user.create({ data: { id, name: "Owner", email: `${id}@rakazo.test` } });
    await prisma.organization.create({
      data: { id, name: "Org", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "S" } });
    const scope = { spaceId: id, userId: id };
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: { id, ...scope, organizationId: id, role: "owner", createdAt: new Date() },
    });
    const leader = await prisma.bot.create({ data: { ...scope, name: "团队-策划", color: "ink" } });
    const writer = await prisma.bot.create({ data: { ...scope, name: "团队-撰稿", color: "ink" } });
    const other = await prisma.bot.create({ data: { ...scope, name: "Other", color: "ink" } });
    const privateThread = await prisma.thread.create({ data: { ...scope, botId: writer.id } });
    await prisma.thread.create({ data: { ...scope, botId: leader.id } });
    const group = await prisma.chatGroup.create({ data: { ...scope, name: "Team" } });
    await prisma.chatGroupMember.createMany({
      data: [leader, writer, other].map((bot, index) => ({
        groupId: group.id,
        botId: bot.id,
        createdAt: new Date(index),
      })),
    });
    const thread = await prisma.thread.create({ data: { ...scope, groupId: group.id } });
    const human = (text: string) =>
      prisma.$transaction((tx) =>
        createThreadMessageInTransaction(tx, {
          threadId: thread.id,
          role: "user",
          blocks: [{ kind: "text", text }],
        }),
      );
    const wake = async (
      botId: string,
      sourceMessageId?: string,
      threadId = thread.id,
      status = "running",
    ) => {
      const task = await prisma.task.create({
        data: { ...scope, botId, threadId, prompt: "p", status },
      });
      return prisma.run.create({
        data: {
          ...scope,
          botId,
          threadId,
          taskId: task.id,
          trigger: "user",
          status,
          sourceMessageId,
        },
      });
    };
    const origin = await human("@团队-策划 请安排写一篇短文");
    const leaderRun = await wake(leader.id, origin.id);
    const view = await teamRunForRun(prisma, leaderRun, thread, leader, { start: true });
    expect(view?.role).toBe("leader");
    const handoff = await handoffToGroupBot(
      deps as never,
      leaderRun,
      group.id,
      { bot_id: writer.id, message: "写一篇短文初稿" },
      { holdWhileTargetBusy: true },
    );
    expect(handoff).toMatchObject({ ok: true });
    const writerRun = await prisma.run.findUniqueOrThrow({
      where: { id: "ok" in handoff ? handoff.runId : "missing" },
    });
    const team = await prisma.groupTeamRun.findUniqueOrThrow({
      where: { originMessageId: origin.id },
    });
    const row = (runId: string) => prisma.run.findUniqueOrThrow({ where: { id: runId } });
    const launch = (run = writerRun) =>
      launchBackgroundTask(
        deps as never,
        run,
        writer,
        { name: "短文初稿", task: "完成短文初稿" },
        { builtinToolNames: [], deliveryKey: `draft:${run.id}` },
      );
    const stop = async (explicitOutcome = true) => {
      const writerBeforeStop = await row(writerRun.id);
      const message = await human("先停一下");
      await supersedeEarlierTeamRuns(prisma, thread.id, message);
      const stopRun = await wake(leader.id, message.id);
      await teamRunForRun(prisma, stopRun, thread, leader, { start: true });
      expect(await row(writerRun.id)).toMatchObject({ status: writerBeforeStop.status });
      const args = {
        ...(explicitOutcome ? { outcome: "stopped" } : {}),
        summary: "已停止本次短文任务。",
      };
      const closes = await Promise.all(
        [1, 2].map(() => completeTeamRun(deps as never, stopRun, thread, leader, args)),
      );
      expect(closes.filter((result) => "ok" in result)).toHaveLength(1);
      expect(await prisma.groupTeamRun.findUniqueOrThrow({ where: { id: team.id } })).toMatchObject(
        {
          status: "stopped",
          endReason: "leader_stopped",
        },
      );
      expect(await completeTeamRun(deps as never, stopRun, thread, leader, args)).toHaveProperty(
        "error",
      );
      return stopRun;
    };
    return {
      scope,
      leader,
      writer,
      other,
      group,
      thread,
      privateThread,
      human,
      wake,
      origin,
      leaderRun,
      writerRun,
      team,
      row,
      launch,
      stop,
    };
  }

  async function noDraft(fx: Awaited<ReturnType<typeof setup>>) {
    await expect(
      publishMessage(deps as never, fx.writerRun, "bot", [
        { kind: "text", text: "迟到的完整初稿" },
      ]),
    ).rejects.toThrow();
    expect(
      await handoffToGroupBot(
        deps as never,
        fx.writerRun,
        fx.group.id,
        { bot_id: fx.leader.id, message: "初稿完成" },
        { allowFinishedSource: true },
      ),
    ).toHaveProperty("error");
    expect(
      await afterGroupTurn(deps as never, fx.writerRun, {
        thread: fx.thread,
        bot: fx.writer,
        blocks: [{ kind: "text", text: "初稿完成" }],
        handoffTargets: [],
        continued: false,
      }),
    ).toEqual({ suppressClaimRecheck: true });
    const messages = await prisma.message.findMany({ where: { threadId: fx.thread.id } });
    const texts = messages.flatMap((m) =>
      (m.blocks as MessageBlock[]).flatMap((b) => (b.kind === "text" ? [b.text] : [])),
    );
    expect(texts.filter((text) => text.startsWith(TEAM_RUN_STOPPED_HEADER))).toHaveLength(1);
    expect(texts).not.toContain("迟到的完整初稿");
    expect(
      await prisma.run.count({
        where: { threadId: fx.thread.id, botId: fx.leader.id, trigger: "follow_up" },
      }),
    ).toBe(0);
  }

  it("cancels the queued handoff before it can launch work, with one stopped notice", () =>
    sys(async () => {
      const fx = await setup();
      await prisma.run.update({
        where: { id: fx.writerRun.id },
        data: { wakeAt: new Date(Date.now() + 600_000) },
      });
      await fx.stop();
      expect(await fx.row(fx.writerRun.id)).toMatchObject({ status: "cancelled" });
      expect(
        await prisma.task.findUniqueOrThrow({ where: { id: fx.writerRun.taskId } }),
      ).toMatchObject({ status: "cancelled" });
      const runtime = { run: vi.fn() };
      await createRunExecutor({ ...deps, runtime } as never).continueRun(
        fx.writerRun.id,
        "fixture-worker",
      );
      expect(runtime.run).not.toHaveBeenCalled();
      expect(await fx.launch()).toHaveProperty("error");
      expect(await prisma.backgroundTaskQueue.count({ where: { runId: fx.writerRun.id } })).toBe(0);
      await noDraft(fx);
    }));

  it("preserves a queued member and background task when a non-stop follow-up supersedes its team", () =>
    sys(async () => {
      const fx = await setup();
      const background = await prisma.backgroundTaskQueue.create({
        data: {
          ...fx.scope,
          botId: fx.writer.id,
          threadId: fx.thread.id,
          runId: fx.writerRun.id,
          name: "短文初稿",
          task: "完成短文初稿",
          args: { agent: "general" },
        },
      });
      const message = await fx.human("顺便把错误码也加上");
      await supersedeEarlierTeamRuns(prisma, fx.thread.id, message);
      const followUp = await fx.wake(fx.leader.id, message.id);
      await teamRunForRun(prisma, followUp, fx.thread, fx.leader, { start: true });
      expect(await fx.row(fx.writerRun.id)).toMatchObject({ status: "queued" });
      expect(await refuseStoppedTeamRunWork(prisma, fx.writerRun.id)).toBe(false);
      expect(
        await prisma.backgroundTaskQueue.findUniqueOrThrow({ where: { id: background.id } }),
      ).toMatchObject({ status: "queued", workerRunId: null });
      expect(
        await prisma.groupTeamRun.findUniqueOrThrow({ where: { id: fx.team.id } }),
      ).toMatchObject({
        status: "superseded",
      });
      expect(
        await completeTeamRun(deps as never, followUp, fx.thread, fx.leader, {
          outcome: "completed",
          summary: "已补充要求。",
        }),
      ).toMatchObject({ ok: true });
      expect(await fx.row(fx.writerRun.id)).toMatchObject({ status: "queued" });
      await prisma.run.update({ where: { id: fx.writerRun.id }, data: { status: "running" } });
      await startQueuedBackgroundTasks(deps as never, fx.writer.id);
      expect(
        await prisma.backgroundTaskQueue.findUniqueOrThrow({ where: { id: background.id } }),
      ).toMatchObject({ status: "started" });
    }));

  it("preserves an in-flight member and its worker across a superseding follow-up", () =>
    sys(async () => {
      const fx = await setup();
      await prisma.run.update({ where: { id: fx.writerRun.id }, data: { status: "running" } });
      expect(await fx.launch()).toMatchObject({ ok: true, status: "started" });
      const background = await prisma.backgroundTaskQueue.findFirstOrThrow({
        where: { runId: fx.writerRun.id },
      });
      const workerBefore = await fx.row(background.workerRunId!);
      const message = await fx.human("顺便把错误码也加上");
      await supersedeEarlierTeamRuns(prisma, fx.thread.id, message);
      expect(await refuseStoppedTeamRunWork(prisma, fx.writerRun.id)).toBe(false);
      expect(await fx.row(fx.writerRun.id)).toMatchObject({ status: "running" });
      expect(await fx.row(workerBefore.id)).toMatchObject({ status: workerBefore.status });
      expect(
        await prisma.backgroundTaskQueue.findUniqueOrThrow({ where: { id: background.id } }),
      ).toMatchObject({ status: "started" });
    }));

  it("also cancels the interrupted request when the leader implicitly closes the stop request", () =>
    sys(async () => {
      const fx = await setup();
      await fx.stop(false);
      expect(await fx.row(fx.writerRun.id)).toMatchObject({ status: "cancelled" });
      expect(await fx.launch()).toHaveProperty("error");
      await noDraft(fx);
    }));

  it("skips provenance with one indexed probe for a group with no relevant stop, and no probe for a private turn", () =>
    sys(async () => {
      const fx = await setup();
      const probe = vi.fn((...args: Parameters<typeof prisma.$queryRaw>) =>
        prisma.$queryRaw(...args),
      );
      const provenance = vi.fn();
      const checkedDb = { $queryRaw: probe, run: { findUnique: provenance } };
      expect(
        await refuseStoppedTeamRunWork(checkedDb as never, fx.writerRun.id, {
          ...fx.writerRun,
          groupId: fx.group.id,
        }),
      ).toBe(false);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(provenance).not.toHaveBeenCalled();

      await fx.stop();
      const message = await fx.human("请开始一个新任务");
      const fresh = await fx.wake(fx.leader.id, message.id);
      probe.mockClear();
      expect(
        await refuseStoppedTeamRunWork(checkedDb as never, fresh.id, {
          ...fresh,
          groupId: fx.group.id,
        }),
      ).toBe(false);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(provenance).not.toHaveBeenCalled();

      await teamRunForRun(prisma, fresh, fx.thread, fx.leader, { start: true });
      const handoff = await handoffToGroupBot(deps as never, fresh, fx.group.id, {
        bot_id: fx.writer.id,
        message: "继续新的任务",
      });
      expect(handoff).toMatchObject({ ok: true });
      const newMember = await fx.row("ok" in handoff ? handoff.runId : "missing");
      probe.mockClear();
      expect(
        await refuseStoppedTeamRunWork(checkedDb as never, newMember.id, {
          ...newMember,
          groupId: fx.group.id,
        }),
      ).toBe(false);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(provenance).not.toHaveBeenCalled();

      probe.mockClear();
      const privateRun = await fx.wake(fx.writer.id, undefined, fx.privateThread.id);
      expect(
        await refuseStoppedTeamRunWork(checkedDb as never, privateRun.id, {
          ...privateRun,
          groupId: null,
        }),
      ).toBe(false);
      expect(probe).not.toHaveBeenCalled();
      expect(provenance).not.toHaveBeenCalled();
    }));

  it("aborts an in-flight member, cancels its worker, and rejects a background launch after stop", () =>
    sys(async () => {
      const fx = await setup();
      await prisma.run.update({
        where: { id: fx.writerRun.id },
        data: { status: "running", leaseOwner: "fixture-worker", leaseFence: 1 },
      });
      expect(await fx.launch()).toMatchObject({ ok: true, status: "started" });
      const background = await prisma.backgroundTaskQueue.findFirstOrThrow({
        where: { runId: fx.writerRun.id },
      });
      const workerRun = await fx.row(background.workerRunId!);
      const worker = await prisma.bot.findUniqueOrThrow({ where: { id: workerRun.botId } });
      const onCancelled = vi.fn();
      const unwatch = watchRunCancellation(
        prisma,
        fx.writerRun.id,
        { done: () => false, onCancelled },
        5,
      );
      try {
        await fx.stop();
        await vi.waitFor(() => expect(onCancelled).toHaveBeenCalled());
      } finally {
        unwatch();
      }
      expect(await fx.row(workerRun.id)).toMatchObject({ status: "cancelled" });
      expect(
        await prisma.backgroundTaskQueue.findUniqueOrThrow({ where: { id: background.id } }),
      ).toMatchObject({ status: "cancelled" });
      expect(await fx.launch()).toHaveProperty("error");
      expect(
        await messageBot(
          deps as never,
          workerRun,
          worker,
          {
            bot_id: fx.writer.id,
            message: "迟到的完整初稿",
            intent: "result",
            deliveryKey: `result:${workerRun.id}`,
          },
          { allowTerminalSource: true },
        ),
      ).toMatchObject({ ok: false });
      await noDraft(fx);
    }));

  it("refuses late descendants and drains a background task inserted after stop without starting it", () =>
    sys(async () => {
      const fx = await setup();
      await fx.stop();
      const late = await fx.wake(
        fx.writer.id,
        fx.writerRun.sourceMessageId!,
        fx.thread.id,
        "queued",
      );
      expect(
        await refuseStoppedTeamRunWork(prisma, late.id, { ...late, groupId: fx.group.id }),
      ).toBe(true);
      expect(await fx.row(late.id)).toMatchObject({ status: "cancelled" });
      const task = await prisma.backgroundTaskQueue.create({
        data: {
          ...fx.scope,
          botId: fx.writer.id,
          threadId: fx.thread.id,
          runId: fx.writerRun.id,
          name: "Late",
          task: "Late draft",
          args: {},
        },
      });
      await startQueuedBackgroundTasks(deps as never, fx.writer.id);
      expect(
        await prisma.backgroundTaskQueue.findUniqueOrThrow({ where: { id: task.id } }),
      ).toMatchObject({ status: "cancelled", workerRunId: null });
      await noDraft(fx);
    }));

  it("cancels a completed member's worker and its pending retry, held follow-up, and nudge", () =>
    sys(async () => {
      const fx = await setup();
      await prisma.run.update({ where: { id: fx.writerRun.id }, data: { status: "running" } });
      expect(await fx.launch()).toMatchObject({ ok: true, status: "started" });
      const background = await prisma.backgroundTaskQueue.findFirstOrThrow({
        where: { runId: fx.writerRun.id },
      });
      await prisma.run.update({ where: { id: fx.writerRun.id }, data: { status: "completed" } });
      const retry = await fx.wake(fx.writer.id, undefined, fx.thread.id, "queued");
      await prisma.run.update({ where: { id: retry.id }, data: { retryOfRunId: fx.writerRun.id } });
      const held = await fx.wake(
        fx.writer.id,
        fx.writerRun.sourceMessageId!,
        fx.thread.id,
        "queued",
      );
      await prisma.run.update({
        where: { id: held.id },
        data: {
          trigger: "follow_up",
          wakeAt: new Date(Date.now() + 600_000),
          clientNonce: `stage-output:${fx.writerRun.sourceMessageId}`,
        },
      });
      const nudge = await fx.wake(fx.leader.id, undefined, fx.thread.id, "queued");
      await prisma.run.update({
        where: { id: nudge.id },
        data: { trigger: "follow_up", clientNonce: `team-nudge:${fx.team.id}:${fx.leaderRun.id}` },
      });
      expect(
        await completeTeamRun(deps as never, fx.leaderRun, fx.thread, fx.leader, {
          outcome: "stopped",
          summary: "已停止。",
        }),
      ).toMatchObject({ ok: true });
      expect(await fx.row(fx.writerRun.id)).toMatchObject({ status: "completed" });
      for (const runId of [background.workerRunId!, retry.id, held.id, nudge.id])
        expect(await fx.row(runId)).toMatchObject({ status: "cancelled" });
      expect(
        await prisma.backgroundTaskQueue.findUniqueOrThrow({ where: { id: background.id } }),
      ).toMatchObject({ status: "cancelled" });
      expect(
        await handoffToGroupBot(
          deps as never,
          fx.writerRun,
          fx.group.id,
          { bot_id: fx.leader.id, message: "迟到的阶段回传" },
          { allowFinishedSource: true },
        ),
      ).toMatchObject({ reason: "team_interrupted" });
    }));

  it("suppresses queued-task notices and a progress snapshot captured before stop", () =>
    sys(async () => {
      const fx = await setup();
      await prisma.run.update({ where: { id: fx.writerRun.id }, data: { status: "running" } });
      expect(await fx.launch()).toMatchObject({ ok: true, status: "started" });
      const background = await prisma.backgroundTaskQueue.findFirstOrThrow({
        where: { runId: fx.writerRun.id },
      });
      let entered!: () => void;
      let release!: () => void;
      const writing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const racingDb = new Proxy(prisma, {
        get(target, key, receiver) {
          if (key !== "$transaction") return Reflect.get(target, key, receiver);
          return async (callback: Parameters<typeof prisma.$transaction>[0]) => {
            entered();
            await released;
            return target.$transaction(callback);
          };
        },
      });
      const refreshing = refreshTaskProgressCard(
        { ...deps, prisma: racingDb } as never,
        fx.writer.id,
      );
      try {
        await writing;
        await fx.stop();
      } finally {
        release();
      }
      expect(await refreshing).toBe(false);
      await announceQueuedTaskStart(deps as never, fx.writerRun, {
        workerId: background.workerBotId!,
        name: background.name,
        ref: background.ref!,
      });
      const messages = await prisma.message.findMany({ where: { threadId: fx.thread.id } });
      expect(
        messages
          .flatMap((m) => m.blocks as MessageBlock[])
          .filter((b) => b.kind === "child_bot" || b.kind === "task_progress"),
      ).toEqual([]);
      await noDraft(fx);
    }));

  it("cancels a worker whose delivery committed just before stop but has not yet bound to its task", () =>
    sys(async () => {
      const fx = await setup();
      await prisma.run.update({ where: { id: fx.writerRun.id }, data: { status: "running" } });
      let entered!: () => void;
      let release!: () => void;
      const binding = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const racingDb = new Proxy(prisma, {
        get(target, key, receiver) {
          if (key !== "backgroundTaskQueue") return Reflect.get(target, key, receiver);
          return new Proxy(target.backgroundTaskQueue, {
            get(queue, method, queueReceiver) {
              if (method !== "updateMany") return Reflect.get(queue, method, queueReceiver);
              return async (args: Parameters<typeof queue.updateMany>[0]) => {
                if (args?.data.status === "started") {
                  entered();
                  await released;
                }
                return queue.updateMany(args);
              };
            },
          });
        },
      });
      const launching = launchBackgroundTask(
        { ...deps, prisma: racingDb } as never,
        fx.writerRun,
        fx.writer,
        { name: "短文初稿", task: "完成短文初稿" },
        { builtinToolNames: [], deliveryKey: "racing-draft" },
      );
      try {
        await binding;
        await fx.stop();
      } finally {
        release();
      }
      expect(await launching).toHaveProperty("error");
      const background = await prisma.backgroundTaskQueue.findFirstOrThrow({
        where: { runId: fx.writerRun.id },
      });
      expect(background).toMatchObject({ status: "cancelled", workerRunId: null });
      const workerRun = await prisma.run.findFirstOrThrow({
        where: {
          sourceMessage: { clientNonce: { startsWith: `bot-message:bgtask:${background.id}:` } },
        },
      });
      expect(workerRun.status).toBe("cancelled");
      await noDraft(fx);
    }));

  it("only cancels owned work: preserves other groups, private chats, unlinked members, and another team run", () =>
    sys(async () => {
      const fx = await setup();
      const otherGroup = await prisma.chatGroup.create({
        data: { ...fx.scope, name: "Other group" },
      });
      const otherThread = await prisma.thread.create({
        data: { ...fx.scope, groupId: otherGroup.id },
      });
      const otherGroupRun = await fx.wake(fx.writer.id, undefined, otherThread.id);
      const privateRun = await fx.wake(fx.writer.id, undefined, fx.privateThread.id);
      const unlinked = await fx.wake(fx.other.id);
      const unlinkedMember = await fx.wake(fx.writer.id);
      const nextOrigin = await fx.human("另一个任务");
      const nextTeam = await prisma.groupTeamRun.create({
        data: {
          ...fx.scope,
          groupId: fx.group.id,
          threadId: fx.thread.id,
          leaderBotId: fx.leader.id,
          originMessageId: nextOrigin.id,
        },
      });
      const otherTeamRun = await fx.wake(fx.writer.id, nextOrigin.id);
      const privateTask = await prisma.backgroundTaskQueue.create({
        data: {
          ...fx.scope,
          botId: fx.writer.id,
          threadId: fx.privateThread.id,
          runId: privateRun.id,
          name: "Private",
          task: "Unrelated private work",
          args: {},
        },
      });
      const otherTask = await prisma.backgroundTaskQueue.create({
        data: {
          ...fx.scope,
          botId: fx.writer.id,
          threadId: otherThread.id,
          runId: otherGroupRun.id,
          name: "Other",
          task: "Unrelated group work",
          args: {},
        },
      });
      await endTeamRun(prisma, fx.team.id, "stopped", "leader_stopped");
      expect(await fx.row(fx.writerRun.id)).toMatchObject({ status: "cancelled" });
      for (const run of [otherGroupRun, privateRun, unlinked, unlinkedMember, otherTeamRun])
        expect(await fx.row(run.id)).toMatchObject({ status: "running" });
      expect(await teamRunOwningWork(prisma, otherTeamRun.id)).toMatchObject({
        id: nextTeam.id,
        status: "active",
      });
      for (const task of [privateTask, otherTask])
        expect(
          await prisma.backgroundTaskQueue.findUniqueOrThrow({ where: { id: task.id } }),
        ).toMatchObject({ status: "queued" });
    }));
});
