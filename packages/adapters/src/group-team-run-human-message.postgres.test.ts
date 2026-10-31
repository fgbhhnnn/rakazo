import { randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import { createDb, createThreadMessageInTransaction, runAsSystem } from "@rakazo/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { launchBackgroundTask } from "./background-tasks.js";
import { messageBot } from "./bot-messages.js";
import { handoffToGroupBot } from "./group-handoff.js";
import { completeTeamRun, teamRunForRun } from "./group-team-run.js";
import { afterGroupTurn } from "./group-turn-end.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("human authorship during a group team run (PostgreSQL)", () => {
  const { prisma, pool } = createDb(process.env.DATABASE_URL ?? "");
  const sys = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
  const deps = {
    prisma,
    events: { notify: vi.fn(async () => undefined) },
    jobs: { enqueue: vi.fn(async () => undefined) },
  } as never;

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  async function setup() {
    const id = `human-message-${randomUUID()}`;
    const user = await prisma.user.create({
      data: { id, name: "Owner", email: `${id}@rakazo.test` },
    });
    const org = await prisma.organization.create({
      data: { id, name: "Org", slug: id, createdAt: new Date() },
    });
    const space = await prisma.space.create({ data: { id, organizationId: org.id, name: "S" } });
    const scope = { spaceId: space.id, userId: user.id };
    await prisma.member.create({
      data: { id, organizationId: org.id, userId: user.id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: { id, ...scope, organizationId: org.id, role: "owner", createdAt: new Date() },
    });
    const leader = await prisma.bot.create({ data: { ...scope, name: "团队-产品", color: "ink" } });
    const frontend = await prisma.bot.create({
      data: { ...scope, name: "团队-前端", color: "ink" },
    });
    // message_bot requires the member's private chat even when its result routes to the group.
    for (const bot of [leader, frontend])
      await prisma.thread.create({ data: { ...scope, botId: bot.id } });
    const group = await prisma.chatGroup.create({ data: { ...scope, name: "团队" } });
    await prisma.chatGroupMember.createMany({
      data: [leader, frontend].map((bot, index) => ({
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
    const origin = await human("@团队-产品 制作前端页面");
    const wake = async (messageId: string) => {
      const task = await prisma.task.create({
        data: { ...scope, botId: leader.id, threadId: thread.id, prompt: "p", status: "running" },
      });
      return prisma.run.create({
        data: {
          ...scope,
          botId: leader.id,
          threadId: thread.id,
          taskId: task.id,
          status: "running",
          trigger: "user",
          sourceMessageId: messageId,
        },
      });
    };
    const leaderRun = await wake(origin.id);
    const view = await teamRunForRun(prisma, leaderRun, thread, leader, { start: true });
    expect(view).toMatchObject({ role: "leader", interrupted: false });
    const row = () =>
      prisma.groupTeamRun.findUniqueOrThrow({ where: { originMessageId: origin.id } });
    const handoff = await handoffToGroupBot(deps, leaderRun, group.id, {
      bot_id: frontend.id,
      message: "实现页面并交回验收",
    });
    expect(handoff).toMatchObject({ ok: true });
    const frontendRun = await prisma.run.findFirstOrThrow({
      where: { threadId: thread.id, botId: frontend.id, trigger: "follow_up" },
    });
    await prisma.run.update({ where: { id: frontendRun.id }, data: { status: "running" } });
    const task = await launchBackgroundTask(
      deps,
      frontendRun,
      frontend,
      { name: "前端页面", task: "完成页面并报告交付文件" },
      { builtinToolNames: [], deliveryKey: `background:${frontendRun.id}` },
    );
    expect(task).toMatchObject({ ok: true, status: "started" });
    const background = await prisma.backgroundTaskQueue.findFirstOrThrow({
      where: { runId: frontendRun.id },
    });
    const workerRun = await prisma.run.findUniqueOrThrow({
      where: { id: background.workerRunId! },
    });
    const worker = await prisma.bot.findUniqueOrThrow({ where: { id: workerRun.botId } });
    await prisma.run.update({ where: { id: frontendRun.id }, data: { status: "completed" } });
    // While the background task is pending, the member waits instead of returning the stage.
    await afterGroupTurn(deps, frontendRun, {
      thread,
      bot: frontend,
      blocks: [{ kind: "text", text: "正在制作页面" }],
      handoffTargets: [],
      continued: false,
    });
    expect(await row()).toMatchObject({ status: "active", hops: 1 });
    await prisma.run.update({ where: { id: workerRun.id }, data: { status: "completed" } });
    const file: MessageBlock = {
      kind: "file",
      artifactId: "test-result-file",
      name: "page.html",
      mimeType: "text/html",
      size: 10,
    };
    // The real bot delivery path chooses the group via the background task's origin thread.
    const delivered = await messageBot(
      deps,
      workerRun,
      worker,
      {
        bot_id: frontend.id,
        message: "前端页面已完成，交付文件见附件。",
        intent: "result",
        attachments: [file],
        deliveryKey: `result:${workerRun.id}`,
      },
      { allowTerminalSource: true },
    );
    expect(delivered).toMatchObject({ ok: true });
    const relayRun = await prisma.run.findUniqueOrThrow({
      where: { id: delivered.ok ? delivered.runId : "missing" },
    });
    const relay = await prisma.message.findUniqueOrThrow({
      where: { id: relayRun.sourceMessageId! },
    });
    expect(relay).toMatchObject({
      threadId: thread.id,
      role: "user",
      botId: null,
      blocks: [
        expect.objectContaining({ kind: "bot_message_received", fromBotId: worker.id }),
        file,
      ],
    });
    await prisma.backgroundTaskQueue.update({
      where: { id: background.id },
      data: { status: "completed", finishedAt: new Date() },
    });
    await prisma.run.update({ where: { id: relayRun.id }, data: { status: "running" } });
    return { thread, group, leader, frontend, leaderRun, relayRun, origin, row, human, wake, file };
  }

  it("keeps the worker relay in the run and lets the leader post exactly one completion summary", () =>
    sys(async () => {
      const fx = await setup();
      const view = await teamRunForRun(prisma, fx.relayRun, fx.thread, fx.frontend, {
        start: true,
      });
      expect(view).toMatchObject({
        role: "member",
        interrupted: false,
        row: { originMessageId: fx.origin.id, status: "active" },
      });
      await prisma.run.update({ where: { id: fx.relayRun.id }, data: { status: "completed" } });
      await afterGroupTurn(deps, fx.relayRun, {
        thread: fx.thread,
        bot: fx.frontend,
        blocks: [{ kind: "text", text: "页面交付完成，见附件 page.html。" }, fx.file],
        handoffTargets: [],
        continued: false,
      });
      expect(await fx.row()).toMatchObject({ status: "active", hops: 2 });
      const leaderRun = await prisma.run.findFirstOrThrow({
        where: { threadId: fx.thread.id, botId: fx.leader.id, trigger: "follow_up" },
      });
      await prisma.run.update({ where: { id: leaderRun.id }, data: { status: "running" } });
      const args = { summary: "前端页面已交付并验收。", deliverables: ["page.html"] };
      expect(await completeTeamRun(deps, leaderRun, fx.thread, fx.leader, args)).toMatchObject({
        ok: true,
      });
      expect(await completeTeamRun(deps, leaderRun, fx.thread, fx.leader, args)).toHaveProperty(
        "error",
      );
      expect(await fx.row()).toMatchObject({ status: "completed", endReason: "leader_completed" });
      const messages = await prisma.message.findMany({ where: { threadId: fx.thread.id } });
      const summaries = messages.filter((message) =>
        (message.blocks as MessageBlock[]).some(
          (block) => block.kind === "text" && block.text.startsWith("✅ 团队任务完成"),
        ),
      );
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ botId: fx.leader.id });
    }));

  it("still supersedes for a real human after a relay and remembers the interrupted goal", () =>
    sys(async () => {
      const fx = await setup();
      const stop = await fx.human("先停一下");
      expect(
        await completeTeamRun(deps, fx.leaderRun, fx.thread, fx.leader, { summary: "迟到的总结" }),
      ).toHaveProperty("error");
      expect(await fx.row()).toMatchObject({ status: "superseded", endReason: "human_message" });
      const stopRun = await fx.wake(stop.id);
      const view = await teamRunForRun(prisma, stopRun, fx.thread, fx.leader, { start: true });
      expect(view).toMatchObject({ interruptedGoal: "@团队-产品 制作前端页面" });
      expect(
        await prisma.message.count({
          where: { threadId: fx.thread.id, clientNonce: { startsWith: "team-complete:" } },
        }),
      ).toBe(0);
    }));
});
