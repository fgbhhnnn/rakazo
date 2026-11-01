import { randomUUID } from "node:crypto";
import { createDb, runAsSystem } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { finalizeBackgroundTaskAfterReturn } from "./background-task-rows.js";
import { backgroundTaskStatus, backgroundWorkerSpawnKey } from "./background-tasks.js";
import { workerSettingsFromMain } from "./worker-main-settings.js";
import { mirrorWorkerApproval } from "./worker-needs-user.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("worker waiting on the user (PostgreSQL)", () => {
  it("reports needs_user, mirrors the approval card into the main chat, and closes it when the worker ends", async () => {
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
        const workerMessage = await prisma.message.create({
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
        return { main, worker, mainThread, workerThread, mainRun, workerRun, workerMessage };
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
      const ask = (fx.workerMessage.blocks as { kind: "ask" }[])[0] as never;
      const mirror = () =>
        system(() =>
          mirrorWorkerApproval({ prisma, events: { notify } } as never, {
            workerRunId: fx.workerRun.id,
            workerThreadId: fx.workerThread.id,
            block: ask,
          }),
        );
      // The push for the paused worker points at the main bot's chat.
      expect(await mirror()).toEqual({ botId: fx.main.id, threadId: fx.mainThread.id });
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
          runId: null,
          blocks: [
            {
              ...(ask as object),
              workerApproval: {
                runId: fx.workerRun.id,
                messageId: fx.workerMessage.id,
                label: "任务 #A7（推送代码）",
              },
            },
          ],
        },
      ]);
      expect(JSON.stringify(posted)).not.toContain("点开处理");
      expect(notify).toHaveBeenCalledTimes(1);

      // The same approval raised again, a run without a background task, or a block that is not
      // an approval posts nothing.
      expect(await mirror()).toBeNull();
      expect(
        await system(() =>
          mirrorWorkerApproval({ prisma, events: { notify } } as never, {
            workerRunId: fx.mainRun.id,
            workerThreadId: fx.mainThread.id,
            block: ask,
          }),
        ),
      ).toBeNull();
      expect(
        await system(() =>
          mirrorWorkerApproval({ prisma, events: { notify } } as never, {
            workerRunId: fx.workerRun.id,
            workerThreadId: fx.workerThread.id,
            block: { kind: "text", text: "hi" },
          }),
        ),
      ).toBeNull();
      expect(
        await system(() => prisma.message.count({ where: { threadId: fx.mainThread.id } })),
      ).toBe(1);
      expect(notify).toHaveBeenCalledTimes(1);

      // Once the worker's outcome is returned after a cancel, the copy shows it was cancelled.
      await system(() =>
        prisma.run.update({ where: { id: fx.workerRun.id }, data: { status: "cancelled" } }),
      );
      await system(() => finalizeBackgroundTaskAfterReturn(prisma, fx.workerRun.id, notify));
      const closed = await system(() =>
        prisma.message.findFirstOrThrow({ where: { threadId: fx.mainThread.id } }),
      );
      expect(closed.blocks).toEqual([
        expect.objectContaining({
          status: "pending",
          workerApproval: expect.objectContaining({ closed: "cancelled" }),
        }),
      ]);
      expect(notify).toHaveBeenCalledTimes(2);

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
