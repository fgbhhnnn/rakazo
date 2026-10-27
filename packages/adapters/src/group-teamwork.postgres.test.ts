import { randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import { createDb, runAsSystem } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { backgroundWorkerSpawnKey } from "./background-tasks.js";
import { messageBot } from "./bot-messages.js";
import { handoffToGroupBot } from "./group-handoff.js";
import { noticeUndeliveredWorkerResult } from "./group-return-thread.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("group teamwork (PostgreSQL)", () => {
  it("hands off once per turn and returns a group task's worker result to the group", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const id = `group-team-${randomUUID()}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    const organizationId = `${id}-org`;
    const system = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
    try {
      const fx = await system(async () => {
        await prisma.user.create({
          data: { id: userId, name: "Team", email: `${id}@rakazo.test` },
        });
        await prisma.organization.create({
          data: { id: organizationId, name: "Team", slug: id, createdAt: new Date() },
        });
        await prisma.space.create({ data: { id: spaceId, organizationId, name: "Team" } });
        const bot = (name: string, extra: Record<string, unknown> = {}) =>
          prisma.bot.create({ data: { spaceId, userId, name, color: "ink", ...extra } });
        const lead = await bot("团队-后端");
        const front = await bot("团队-前端");
        const worker = await bot("团队-后端 · 后台1", {
          parentBotId: lead.id,
          spawnKey: backgroundWorkerSpawnKey(lead.id, 1),
        });
        for (const b of [lead, front, worker])
          await prisma.thread.create({ data: { spaceId, userId, botId: b.id } });
        const group = await prisma.chatGroup.create({
          data: {
            spaceId,
            userId,
            name: "Agent团队测试",
            members: { create: [{ botId: lead.id }, { botId: front.id }] },
          },
        });
        const groupThread = await prisma.thread.create({
          data: { spaceId, userId, groupId: group.id },
        });
        const leadDm = await prisma.thread.findFirstOrThrow({ where: { botId: lead.id } });
        const workerThread = await prisma.thread.findFirstOrThrow({ where: { botId: worker.id } });
        const run = async (botId: string, threadId: string, status: string, trigger: string) => {
          const task = await prisma.task.create({
            data: { spaceId, botId, threadId, userId, prompt: "p", status: "running" },
          });
          return prisma.run.create({
            data: { spaceId, botId, threadId, taskId: task.id, userId, status, trigger },
          });
        };
        const leadRun = await run(lead.id, groupThread.id, "running", "user");
        const workerRun = await run(worker.id, workerThread.id, "completed", "bot_message");
        await prisma.backgroundTaskQueue.create({
          data: {
            spaceId,
            botId: lead.id,
            userId,
            runId: leadRun.id,
            threadId: groupThread.id,
            name: "接口重构",
            task: "refactor the API",
            args: {},
            status: "started",
            workerBotId: worker.id,
            workerRunId: workerRun.id,
            ref: "B7",
            startedAt: new Date(),
          },
        });
        return { lead, front, worker, group, groupThread, leadDm, leadRun, workerRun };
      });
      const notify = vi.fn(async () => undefined);
      const enqueue = vi.fn(async () => undefined);
      const deps = { prisma, events: { notify }, jobs: { enqueue } } as never;
      const leadRun = {
        id: fx.leadRun.id,
        spaceId,
        threadId: fx.groupThread.id,
        botId: fx.lead.id,
        userId,
      };

      // One handoff per turn: the first is delivered, a different second one is refused, and
      // the identical call replays instead of posting twice.
      const first = await system(() =>
        handoffToGroupBot(deps, leadRun, fx.group.id, {
          bot_id: fx.front.id,
          message: "做登录页",
        }),
      );
      expect(first).toMatchObject({ ok: true, delivered: true, botId: fx.front.id });
      const second = await system(() =>
        handoffToGroupBot(deps, leadRun, fx.group.id, {
          bot_id: fx.front.id,
          message: "再做注册页",
        }),
      );
      expect(second).toMatchObject({ reason: "one_handoff_per_turn" });
      const replay = await system(() =>
        handoffToGroupBot(deps, leadRun, fx.group.id, {
          bot_id: fx.front.id,
          message: "做登录页",
        }),
      );
      expect(replay).toMatchObject({ ok: true, botId: fx.front.id });
      const frontRuns = await system(() =>
        prisma.run.count({ where: { botId: fx.front.id, threadId: fx.groupThread.id } }),
      );
      expect(frontRuns).toBe(1);

      // The worker's result for the task started in the group wakes the lead in the group.
      const sent = await system(() =>
        messageBot(
          deps,
          {
            id: fx.workerRun.id,
            spaceId,
            threadId: fx.workerRun.threadId,
            botId: fx.worker.id,
            userId,
            sourceMessageId: null,
          },
          { id: fx.worker.id, name: fx.worker.name },
          { bot_id: fx.lead.id, message: "接口已完成", intent: "result" },
          { allowTerminalSource: true },
        ),
      );
      expect(sent).toMatchObject({ ok: true });
      const relay = await system(() =>
        prisma.run.findUniqueOrThrow({
          where: { id: (sent as { runId: string }).runId },
          select: { threadId: true, botId: true, trigger: true },
        }),
      );
      expect(relay).toEqual({
        threadId: fx.groupThread.id,
        botId: fx.lead.id,
        trigger: "bot_message",
      });
      const inDm = await system(() => prisma.message.count({ where: { threadId: fx.leadDm.id } }));
      expect(inDm).toBe(0);

      // A result that never got through is posted visibly in the group, once.
      const row = await system(() =>
        prisma.backgroundTaskQueue.findFirstOrThrow({ where: { workerRunId: fx.workerRun.id } }),
      );
      await system(() => noticeUndeliveredWorkerResult(deps, row));
      await system(() => noticeUndeliveredWorkerResult(deps, row));
      const notices = await system(() =>
        prisma.message.findMany({
          where: { threadId: fx.groupThread.id, clientNonce: { startsWith: "group-notice:" } },
          select: { blocks: true, botId: true },
        }),
      );
      expect(notices).toHaveLength(1);
      expect((notices[0]?.blocks as MessageBlock[])[0]).toMatchObject({
        kind: "text",
        text: expect.stringContaining("「接口重构」已结束"),
      });
    } finally {
      await system(async () => {
        await prisma.space.deleteMany({ where: { id: spaceId } });
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }).catch(() => undefined);
      await prisma.$disconnect();
      await pool.end();
    }
  });
});
