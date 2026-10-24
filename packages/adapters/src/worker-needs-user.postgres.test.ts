import { randomUUID } from "node:crypto";
import { createDb, runAsSystem } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { backgroundTaskStatus, backgroundWorkerSpawnKey } from "./background-tasks.js";
import { workerSettingsFromMain } from "./worker-main-settings.js";
import { announceWorkerNeedsUser } from "./worker-needs-user.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("worker waiting on the user (PostgreSQL)", () => {
  it("reports needs_user, posts a card in the main chat, and carries the main bot's settings", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const id = `needs-user-${randomUUID()}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    const organizationId = `${id}-org`;
    const system = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
    try {
      const fx = await system(async () => {
        await prisma.user.create({
          data: { id: userId, name: "Needs user", email: `${id}@rakazo.test` },
        });
        await prisma.organization.create({
          data: { id: organizationId, name: "Needs user", slug: id, createdAt: new Date() },
        });
        await prisma.space.create({ data: { id: spaceId, organizationId, name: "Needs user" } });
        const main = await prisma.bot.create({
          data: {
            spaceId,
            userId,
            name: "main",
            color: "ink",
            instructions: "回复都用中文，结论放第一行。",
            disabledBuiltinTools: ["web_search"],
          },
        });
        const worker = await prisma.bot.create({
          data: {
            spaceId,
            userId,
            name: "main · 后台1",
            color: "ink",
            parentBotId: main.id,
            spawnKey: backgroundWorkerSpawnKey(main.id, 1),
          },
        });
        const mainThread = await prisma.thread.create({
          data: { spaceId, userId, botId: main.id },
        });
        const workerThread = await prisma.thread.create({
          data: { spaceId, userId, botId: worker.id, nextMessageSeq: 1 },
        });
        const mainTask = await prisma.task.create({
          data: {
            spaceId,
            botId: main.id,
            threadId: mainThread.id,
            userId,
            prompt: "p",
            status: "done",
          },
        });
        const workerTask = await prisma.task.create({
          data: {
            spaceId,
            botId: worker.id,
            threadId: workerThread.id,
            userId,
            prompt: "p",
            status: "running",
          },
        });
        const mainRun = await prisma.run.create({
          data: {
            spaceId,
            botId: main.id,
            threadId: mainThread.id,
            taskId: mainTask.id,
            userId,
            status: "completed",
            trigger: "user",
            completedAt: new Date(),
          },
        });
        const workerRun = await prisma.run.create({
          data: {
            spaceId,
            botId: worker.id,
            threadId: workerThread.id,
            taskId: workerTask.id,
            userId,
            status: "waiting_input",
            trigger: "bot",
          },
        });
        await prisma.message.create({
          data: {
            threadId: workerThread.id,
            seq: 0,
            role: "bot",
            botId: worker.id,
            runId: workerRun.id,
            blocks: [
              {
                kind: "ask",
                approvalEffectId: `effect${randomUUID().replaceAll("-", "")}`.slice(0, 25),
                text: "Allow git push to origin?",
                status: "pending",
                actions: [
                  { id: "allow", label: "Allow once" },
                  { id: "deny", label: "Deny" },
                ],
              },
            ],
          },
        });
        await prisma.backgroundTaskQueue.create({
          data: {
            spaceId,
            botId: main.id,
            userId,
            runId: mainRun.id,
            threadId: mainThread.id,
            name: "推送代码",
            task: "push the branch",
            args: {},
            status: "started",
            workerBotId: worker.id,
            workerRunId: workerRun.id,
            ref: "A7",
            startedAt: new Date(),
          },
        });
        return { main, worker, mainThread, mainRun, workerRun };
      });
      const run = {
        id: fx.mainRun.id,
        spaceId,
        threadId: fx.mainThread.id,
        botId: fx.main.id,
        userId,
      };

      const status = await system(() =>
        backgroundTaskStatus({ prisma } as never, run as never, { id: fx.main.id } as never, {}),
      );
      expect("tasks" in status && status.tasks).toEqual([
        expect.objectContaining({
          task_id: "A7",
          state: "needs_user",
          pending: { kind: "approval", text: "Allow git push to origin?" },
        }),
      ]);
      expect("note" in status && status.note).toContain('state "needs_user"');

      const notify = vi.fn(async () => undefined);
      await system(() =>
        announceWorkerNeedsUser({ prisma, events: { notify } } as never, {
          workerRunId: fx.workerRun.id,
          pending: { kind: "approval", text: "Allow git push to origin?" },
        }),
      );
      const posted = await system(() =>
        prisma.message.findMany({
          where: { threadId: fx.mainThread.id },
          select: { role: true, botId: true, runId: true, blocks: true },
        }),
      );
      expect(posted).toEqual([
        {
          role: "bot",
          botId: fx.main.id,
          runId: fx.mainRun.id,
          blocks: [
            { kind: "text", text: "任务 #A7（推送代码）需要你批准：Allow git push to origin?" },
            {
              kind: "child_bot",
              botId: fx.worker.id,
              name: "后台任务：推送代码 #A7",
              title: "任务 #A7 · 需要你批准，点开处理",
              status: "created",
            },
          ],
        },
      ]);
      expect(notify).toHaveBeenCalledTimes(1);

      // A run that carries no background task (an ordinary bot's run) posts nothing.
      await system(() =>
        announceWorkerNeedsUser({ prisma, events: { notify } } as never, {
          workerRunId: fx.mainRun.id,
          pending: { kind: "approval", text: "x" },
        }),
      );
      expect(
        await system(() => prisma.message.count({ where: { threadId: fx.mainThread.id } })),
      ).toBe(1);

      // D: the worker carries the main bot's instructions and disabled tools.
      const settings = await system(() =>
        workerSettingsFromMain(prisma, fx.main.id, "WORKER RULES", ["ask_user", "web_search"]),
      );
      expect(settings.instructions.startsWith("WORKER RULES\n\n")).toBe(true);
      expect(settings.instructions.endsWith("回复都用中文，结论放第一行。")).toBe(true);
      expect(settings.disabledBuiltinTools).toEqual(["ask_user", "web_search"]);
    } finally {
      await system(async () => {
        await prisma.backgroundTaskQueue.deleteMany({ where: { spaceId } });
        await prisma.bot.deleteMany({ where: { spaceId } });
        await prisma.thread.deleteMany({ where: { spaceId } });
        await prisma.space.deleteMany({ where: { id: spaceId } });
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }).catch(() => undefined);
      await pool.end();
    }
  });
});
