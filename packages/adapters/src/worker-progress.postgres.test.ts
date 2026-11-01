import { randomUUID } from "node:crypto";
import { asSystem, createDb, createThreadEvents } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { backgroundTaskStatus, backgroundWorkerSpawnKey } from "./background-tasks.js";
import { WORKER_ACTIVITY_NOTE } from "./worker-activity.js";
import { reportWorkerProgress, WORKER_PROGRESS_NOTICE } from "./worker-progress.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("worker progress and activity in background_task_status (PostgreSQL)", () => {
  it("shows a running worker's calls and its own note to the main bot only", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const system = asSystem(prisma);
    const events = createThreadEvents(system);
    const id = `worker-progress-${randomUUID()}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    const organizationId = `${id}-org`;
    try {
      await system.user.create({
        data: { id: userId, name: "Progress", email: `${id}@rakazo.test` },
      });
      await system.organization.create({
        data: { id: organizationId, name: "Progress", slug: id, createdAt: new Date() },
      });
      await system.space.create({ data: { id: spaceId, organizationId, name: "Progress" } });
      const main = await system.bot.create({
        data: { spaceId, userId, name: "main", color: "ink" },
      });
      const worker = await system.bot.create({
        data: {
          spaceId,
          userId,
          name: "main · 后台1",
          color: "ink",
          parentBotId: main.id,
          spawnKey: backgroundWorkerSpawnKey(main.id, 1),
        },
      });
      const mainThread = await system.thread.create({ data: { spaceId, userId, botId: main.id } });
      const workerThread = await system.thread.create({
        data: { spaceId, userId, botId: worker.id, nextMessageSeq: 1 },
      });
      const task = (botId: string, threadId: string, status: string) =>
        system.task.create({ data: { spaceId, botId, threadId, userId, prompt: "p", status } });
      const mainTask = await task(main.id, mainThread.id, "done");
      const workerTask = await task(worker.id, workerThread.id, "running");
      const mainRun = await system.run.create({
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
      const workerRun = await system.run.create({
        data: {
          spaceId,
          botId: worker.id,
          threadId: workerThread.id,
          taskId: workerTask.id,
          userId,
          status: "running",
          trigger: "bot_message",
        },
      });
      await system.backgroundTaskQueue.create({
        data: {
          spaceId,
          botId: main.id,
          userId,
          runId: mainRun.id,
          threadId: mainThread.id,
          name: "打包 APK",
          task: "build and install the app",
          args: {},
          status: "started",
          workerBotId: worker.id,
          workerRunId: workerRun.id,
          ref: "P1",
          startedAt: new Date(),
        },
      });

      // What the executor writes while the worker runs: an activity line, then the call.
      const identity = {
        spaceId,
        threadId: workerThread.id,
        botId: worker.id,
        runId: workerRun.id,
      };
      const append = (type: string, payload: Record<string, unknown>) =>
        events.append({ ...identity, type: type as never, payload });
      await append("thread.progress", { text: "Running: ./gradlew assembleDebug", activity: true });
      await append("agent.tool.called", { name: "shell", executionId: "x1" });
      await append("agent.tool.completed", {
        name: "shell",
        executionId: "x1",
        durationMs: 42_000,
        outcome: "completed",
      });
      await append("thread.progress", { text: "Running: emulator -avd test", activity: true });
      await append("agent.tool.called", { name: "shell", executionId: "x2" });

      const runRef = { id: workerRun.id, spaceId };
      const saved = await reportWorkerProgress(
        { prisma: system, events },
        {
          run: runRef,
          threadId: workerThread.id,
          bot: worker,
          args: { text: "APK built (42s); booting emulator for ops@example.com" },
        },
      );
      expect(saved).toMatchObject({ ok: true });
      const early = await reportWorkerProgress(
        { prisma: system, events },
        { run: runRef, threadId: workerThread.id, bot: worker, args: { text: "again" } },
      );
      expect(early).toMatchObject({ ok: false, too_soon: true });
      expect(early).not.toHaveProperty("error");
      // The main bot cannot leave a note.
      expect(
        await reportWorkerProgress(
          { prisma: system, events },
          {
            run: { id: mainRun.id, spaceId },
            threadId: mainThread.id,
            bot: main,
            args: { text: "x" },
          },
        ),
      ).toEqual({ error: "report_progress is only for background workers." });

      // Stored sealed except the queryable notice tag; one note only; nothing in the main chat.
      const raw = await system.$queryRaw<{ notice: string; body: string }[]>`
        SELECT payload->>'notice' AS notice, payload::text AS body FROM events
        WHERE "runId" = ${workerRun.id} AND payload->>'notice' = ${WORKER_PROGRESS_NOTICE}`;
      expect(raw).toHaveLength(1);
      expect(raw[0]?.body).toContain("$sealed");
      expect(raw[0]?.body).not.toContain("APK built");
      expect(await system.event.count({ where: { threadId: mainThread.id } })).toBe(0);
      expect(await system.message.count({ where: { threadId: mainThread.id } })).toBe(0);

      const status = await backgroundTaskStatus(
        { prisma: system } as never,
        { id: mainRun.id, spaceId, threadId: mainThread.id, botId: main.id, userId } as never,
        { id: main.id } as never,
        {},
      );
      expect("tasks" in status && status.tasks).toEqual([
        expect.objectContaining({
          task_id: "P1",
          state: "running",
          last_progress: "APK built (42s); booting emulator for [Redacted]",
          last_progress_at: expect.any(String),
          current_call: {
            tool: "shell",
            summary: "Running: emulator -avd test",
            started_at: expect.any(String),
            running_for_s: expect.any(Number),
          },
          recent_activity: [
            {
              tool: "shell",
              summary: "Running: ./gradlew assembleDebug",
              outcome: "completed",
              duration_s: 42,
              at: expect.any(String),
            },
            {
              tool: "shell",
              summary: "Running: emulator -avd test",
              outcome: "running",
              at: expect.any(String),
            },
          ],
          last_event_at: expect.any(String),
        }),
      ]);
      expect("note" in status && status.note).toContain(WORKER_ACTIVITY_NOTE);
    } finally {
      await system.backgroundTaskQueue.deleteMany({ where: { spaceId } }).catch(() => undefined);
      await system.bot.deleteMany({ where: { spaceId } }).catch(() => undefined);
      await system.thread.deleteMany({ where: { spaceId } }).catch(() => undefined);
      await system.space.deleteMany({ where: { id: spaceId } }).catch(() => undefined);
      await system.organization
        .deleteMany({ where: { id: organizationId } })
        .catch(() => undefined);
      await system.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
      await pool.end();
    }
  });
});
