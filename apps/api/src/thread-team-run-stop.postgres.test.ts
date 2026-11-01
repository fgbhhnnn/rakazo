import { randomUUID } from "node:crypto";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { TEAM_RUN_STOPPED_HEADER } from "@rakazo/core";
import { createDb, createThreadMessageInTransaction, runAsSystem } from "@rakazo/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  launchBackgroundTask,
  startQueuedBackgroundTasks,
} from "../../../packages/adapters/src/background-tasks.js";
import { createRunExecutor } from "../../../packages/adapters/src/executor.js";
import { handoffToGroupBot } from "../../../packages/adapters/src/group-handoff.js";
import { teamRunForRun } from "../../../packages/adapters/src/group-team-run.js";
import { publishMessage } from "../../../packages/adapters/src/run-messages.js";
import type { ThreadTarget } from "./thread-target.js";
import { sendThreadMessage } from "./thread-target.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("human stop admission for a group team run (PostgreSQL)", () => {
  const { prisma, pool } = createDb(process.env.DATABASE_URL ?? "");
  const sys = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  async function setup() {
    const id = `stop-intent-${randomUUID()}`;
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
    const actor = scope as Actor;
    const leader = await prisma.bot.create({ data: { ...scope, name: "产品", color: "ink" } });
    const writer = await prisma.bot.create({ data: { ...scope, name: "撰稿", color: "ink" } });
    for (const bot of [leader, writer])
      await prisma.thread.create({ data: { ...scope, botId: bot.id } });
    const group = await prisma.chatGroup.create({ data: { ...scope, name: "Team" } });
    await prisma.chatGroupMember.createMany({
      data: [leader, writer].map((bot, i) => ({
        groupId: group.id,
        botId: bot.id,
        createdAt: new Date(i),
      })),
    });
    const thread = await prisma.thread.create({ data: { ...scope, groupId: group.id } });
    const origin = await prisma.$transaction((tx) =>
      createThreadMessageInTransaction(tx, {
        threadId: thread.id,
        role: "user",
        blocks: [{ kind: "text", text: "@产品 写一篇短文，团队分工完成后汇总给我。" }],
      }),
    );
    const task = await prisma.task.create({
      data: { ...scope, threadId: thread.id, botId: leader.id, prompt: "p", status: "running" },
    });
    const leaderRun = await prisma.run.create({
      data: {
        ...scope,
        threadId: thread.id,
        botId: leader.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
        sourceMessageId: origin.id,
      },
    });
    const deps = {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    };
    expect(await teamRunForRun(prisma, leaderRun, thread, leader, { start: true })).toMatchObject({
      role: "leader",
    });
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
    await prisma.run.update({ where: { id: leaderRun.id }, data: { status: "completed" } });
    deps.jobs.enqueue.mockClear();
    const target = {
      kind: "group",
      groupId: group.id,
      threadId: thread.id,
      groupName: "Team",
      memberBotIds: [leader.id, writer.id],
      members: [],
    } satisfies ThreadTarget;
    const row = () =>
      prisma.groupTeamRun.findUniqueOrThrow({ where: { originMessageId: origin.id } });
    const send = (text: string, clientNonce = randomUUID()) =>
      sendThreadMessage(deps as never, actor, target, { text, clientNonce });
    const background = () =>
      prisma.backgroundTaskQueue.create({
        data: {
          ...scope,
          threadId: thread.id,
          botId: writer.id,
          runId: writerRun.id,
          name: "初稿",
          task: "完成短文",
          args: {},
        },
      });
    const launch = () =>
      launchBackgroundTask(
        deps as never,
        writerRun,
        writer,
        { name: "初稿", task: "完成短文" },
        { builtinToolNames: [], deliveryKey: `draft:${writerRun.id}` },
      );
    const texts = async () =>
      (
        await prisma.message.findMany({ where: { threadId: thread.id }, orderBy: { seq: "asc" } })
      ).flatMap((m) =>
        (m.blocks as MessageBlock[]).flatMap((b) => (b.kind === "text" ? [b.text] : [])),
      );
    return {
      actor,
      scope,
      deps,
      leader,
      writer,
      thread,
      group,
      origin,
      leaderRun,
      writerRun,
      row,
      send,
      background,
      launch,
      texts,
    };
  }

  it("replays 先停一下: stops the run, cancels the queued 撰稿 handoff/task, posts one notice, and never wakes a bot", () =>
    sys(async () => {
      const fx = await setup();
      const background = await fx.background();
      // A leader still finishing its earlier turn must also lose write permission.
      await prisma.run.update({ where: { id: fx.leaderRun.id }, data: { status: "running" } });
      const nonce = randomUUID();
      const result = await fx.send("先停一下", nonce);
      expect(await fx.row()).toMatchObject({ status: "stopped", endReason: "leader_stopped" });
      for (const runId of [fx.leaderRun.id, fx.writerRun.id, result.runId]) {
        const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
        expect(run.status).toBe("cancelled");
        expect(await prisma.task.findUniqueOrThrow({ where: { id: run.taskId } })).toMatchObject({
          status: "cancelled",
        });
        const runtime = { run: vi.fn() };
        await createRunExecutor({ ...fx.deps, runtime } as never).continueRun(
          runId,
          "fixture-worker",
        );
        expect(runtime.run).not.toHaveBeenCalled();
        await expect(
          publishMessage(fx.deps as never, run, "bot", [{ kind: "text", text: "已停" }]),
        ).rejects.toThrow();
      }
      expect(
        await prisma.backgroundTaskQueue.findUniqueOrThrow({ where: { id: background.id } }),
      ).toMatchObject({ status: "cancelled", workerRunId: null });
      await startQueuedBackgroundTasks(fx.deps as never, fx.writer.id);
      expect(await fx.launch()).toHaveProperty("error");
      expect(fx.deps.jobs.enqueue).not.toHaveBeenCalled();
      expect(await fx.texts()).toEqual([
        "@产品 写一篇短文，团队分工完成后汇总给我。",
        "先停一下",
        TEAM_RUN_STOPPED_HEADER,
      ]);
      const stopRun = await prisma.run.findUniqueOrThrow({ where: { id: result.runId } });
      const humanEvent = await prisma.event.findFirstOrThrow({
        where: {
          threadId: fx.thread.id,
          type: "thread.message.created",
          payload: { path: ["messageId"], equals: stopRun.sourceMessageId! },
        },
      });
      expect(humanEvent.payload).toMatchObject({ runIds: [result.runId] });
      expect(await fx.send("先停一下", nonce)).toEqual(result);
      const again = await fx.send("请都停下吧");
      expect(await prisma.run.findUniqueOrThrow({ where: { id: again.runId } })).toMatchObject({
        status: "cancelled",
      });
      expect((await fx.texts()).filter((text) => text === TEAM_RUN_STOPPED_HEADER)).toHaveLength(1);
      expect(fx.deps.jobs.enqueue).not.toHaveBeenCalled();
    }));

  it("serializes concurrent human stops to one notice", () =>
    sys(async () => {
      const fx = await setup();
      const results = await Promise.all([fx.send("先停一下"), fx.send("@产品 @撰稿 全部停止！")]);
      for (const result of results)
        expect(await prisma.run.findUniqueOrThrow({ where: { id: result.runId } })).toMatchObject({
          status: "cancelled",
        });
      expect((await fx.texts()).filter((text) => text === TEAM_RUN_STOPPED_HEADER)).toHaveLength(1);
      expect(fx.deps.jobs.enqueue).not.toHaveBeenCalled();
    }));

  it("cancels an already running member and its worker", () =>
    sys(async () => {
      const fx = await setup();
      await prisma.run.update({ where: { id: fx.writerRun.id }, data: { status: "running" } });
      expect(await fx.launch()).toMatchObject({ ok: true, status: "started" });
      const background = await prisma.backgroundTaskQueue.findFirstOrThrow({
        where: { runId: fx.writerRun.id },
      });
      await fx.send("please stop");
      expect(await fx.row()).toMatchObject({ status: "stopped" });
      for (const id of [fx.writerRun.id, background.workerRunId!])
        expect(await prisma.run.findUniqueOrThrow({ where: { id } })).toMatchObject({
          status: "cancelled",
        });
      expect(
        await prisma.backgroundTaskQueue.findUniqueOrThrow({ where: { id: background.id } }),
      ).toMatchObject({ status: "cancelled" });
    }));

  it.each(["停止条件怎么写", "暂停功能的设计方案", "the bus stop is near", "顺便把错误码也加上"])(
    "keeps supersession and member work for %j",
    (text) =>
      sys(async () => {
        const fx = await setup();
        const background = await fx.background();
        const sent = await fx.send(text);
        const run = await prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
        expect(run.status).toBe("queued");
        await teamRunForRun(prisma, run, fx.thread, fx.leader, { start: true });
        expect(await fx.row()).toMatchObject({ status: "superseded", endReason: "human_message" });
        expect(
          await prisma.run.findUniqueOrThrow({ where: { id: fx.writerRun.id } }),
        ).toMatchObject({ status: "queued" });
        expect(
          await prisma.backgroundTaskQueue.findUniqueOrThrow({ where: { id: background.id } }),
        ).toMatchObject({ status: "queued" });
        expect(await fx.texts()).not.toContain(TEAM_RUN_STOPPED_HEADER);
      }),
  );

  it("keeps ordinary routing without an active team, including after a new instruction", () =>
    sys(async () => {
      const fx = await setup();
      await prisma.groupTeamRun.update({
        where: { id: (await fx.row()).id },
        data: { status: "answered" },
      });
      const first = await fx.send("先停一下");
      expect(await prisma.run.findUniqueOrThrow({ where: { id: first.runId } })).toMatchObject({
        status: "queued",
      });
      expect(await fx.texts()).not.toContain(TEAM_RUN_STOPPED_HEADER);
      // A consumed stop does not swallow a later independent stop after a new human request.
      const active = await setup();
      await active.send("先停一下");
      await active.send("新的普通消息");
      const later = await active.send("stop");
      expect(await prisma.run.findUniqueOrThrow({ where: { id: later.runId } })).toMatchObject({
        status: "queued",
      });
    }));
});
