import { randomUUID } from "node:crypto";
import type { TaskProgressBlock } from "@rakazo/contracts";
import { asSystem, createDb, createThreadEvents } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import {
  refreshAllTaskProgressCards,
  refreshTaskProgressCard,
  taskStuckFields,
} from "./background-task-progress.js";
import { backgroundWorkerSpawnKey } from "./background-tasks.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;
const STUCK = 10 * 60_000;

postgres("background task progress card (PostgreSQL)", () => {
  it("keeps one card per batch up to date in place and says each milestone once", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const system = asSystem(prisma);
    const events = createThreadEvents(system);
    const deps = { prisma: system, events };
    const id = `task-progress-${randomUUID()}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    const organizationId = `${id}-org`;
    const t0 = new Date();
    const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
    try {
      await system.user.create({ data: { id: userId, name: "Owner", email: `${id}@rakazo.test` } });
      await system.organization.create({
        data: { id: organizationId, name: "Progress", slug: id, createdAt: new Date() },
      });
      await system.space.create({ data: { id: spaceId, organizationId, name: "Progress" } });
      const main = await system.bot.create({
        data: { spaceId, userId, name: "main", color: "ink" },
      });
      const mainThread = await system.thread.create({ data: { spaceId, userId, botId: main.id } });
      const mainTask = await system.task.create({
        data: {
          spaceId,
          botId: main.id,
          threadId: mainThread.id,
          userId,
          prompt: "p",
          status: "done",
        },
      });
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
      const startWorker = async (slot: number) => {
        const worker = await system.bot.create({
          data: {
            spaceId,
            userId,
            name: `main · 后台${slot}`,
            color: "ink",
            parentBotId: main.id,
            spawnKey: backgroundWorkerSpawnKey(main.id, slot),
          },
        });
        const thread = await system.thread.create({
          data: { spaceId, userId, botId: worker.id, nextMessageSeq: 1 },
        });
        const task = await system.task.create({
          data: {
            spaceId,
            botId: worker.id,
            threadId: thread.id,
            userId,
            prompt: "p",
            status: "running",
          },
        });
        const run = await system.run.create({
          data: {
            spaceId,
            botId: worker.id,
            threadId: thread.id,
            taskId: task.id,
            userId,
            status: "running",
            trigger: "bot_message",
            startedAt: t0,
          },
        });
        return { worker, thread, run };
      };
      const queue = (ref: string, name: string, extra: Record<string, unknown>) =>
        system.backgroundTaskQueue.create({
          data: {
            spaceId,
            botId: main.id,
            userId,
            runId: mainRun.id,
            threadId: mainThread.id,
            name,
            task: "do it",
            args: {},
            ref,
            createdAt: t0,
            ...extra,
          },
        });
      const cards = () =>
        system.message.findMany({
          where: {
            threadId: mainThread.id,
            blocks: { array_contains: [{ kind: "task_progress" }] },
          },
          orderBy: { seq: "asc" },
        });
      const texts = async () =>
        (
          await system.message.findMany({
            where: { threadId: mainThread.id, blocks: { array_contains: [{ kind: "text" }] } },
            orderBy: { seq: "asc" },
          })
        ).map((message) => (message.blocks as Array<{ text: string }>)[0]!.text);
      const block = (message: { blocks: unknown }) => (message.blocks as TaskProgressBlock[])[0]!;

      const a = await startWorker(1);
      await queue("TPA00001", "竞品调研", {
        status: "started",
        workerBotId: a.worker.id,
        workerRunId: a.run.id,
        startedAt: t0,
      });
      await queue("TPB00002", "导出报表", { status: "queued", createdAt: at(1) });

      // First pass: one card, both tasks, not unread.
      expect(await refreshTaskProgressCard(deps, main.id, { now: at(5), stuckMs: STUCK })).toBe(
        true,
      );
      let [card] = await cards();
      expect(card).toMatchObject({ role: "bot", botId: main.id, runId: null });
      expect(block(card!).tasks.map((task) => [task.ref, task.state])).toEqual([
        ["TPA00001", "running"],
        ["TPB00002", "queued"],
      ]);
      expect((await system.thread.findUniqueOrThrow({ where: { id: mainThread.id } })).unread).toBe(
        false,
      );
      // Nothing changed: no write at all.
      const seqBefore = (await system.event.findFirst({
        where: { threadId: mainThread.id },
        orderBy: { seq: "desc" },
      }))!.seq;
      expect(await refreshTaskProgressCard(deps, main.id, { now: at(20), stuckMs: STUCK })).toBe(
        false,
      );
      expect(
        (await system.event.findFirst({
          where: { threadId: mainThread.id },
          orderBy: { seq: "desc" },
        }))!.seq,
      ).toBe(seqBefore);

      // The worker calls a tool: the same message is rewritten with the new step.
      const append = (type: string, payload: Record<string, unknown>) =>
        events.append({
          spaceId,
          threadId: a.thread.id,
          botId: a.worker.id,
          runId: a.run.id,
          type: type as never,
          payload,
        });
      await append("thread.progress", {
        text: "Searching the web: rakazo pricing",
        activity: true,
      });
      await append("agent.tool.called", { name: "web_search", executionId: "x1" });
      expect(await refreshTaskProgressCard(deps, main.id, { stuckMs: STUCK })).toBe(true);
      const updated = await cards();
      expect(updated).toHaveLength(1);
      expect(updated[0]!.id).toBe(card!.id);
      expect(block(updated[0]!).tasks[0]).toMatchObject({
        state: "running",
        step: "Searching the web: rakazo pricing",
      });
      const updateEvent = await system.event.findFirst({
        where: { threadId: mainThread.id, type: "thread.message.updated" },
        orderBy: { seq: "desc" },
      });
      expect(updateEvent?.payload).toMatchObject({ messageId: card!.id });

      expect((await system.thread.findUniqueOrThrow({ where: { id: mainThread.id } })).unread).toBe(
        false,
      );

      // Quiet past the threshold: stuck on the card and one plain message, said once.
      const later = new Date(Date.now() + STUCK + 60_000);
      expect(await refreshTaskProgressCard(deps, main.id, { now: later, stuckMs: STUCK })).toBe(
        true,
      );
      [card] = await cards();
      expect(block(card!).tasks[0]).toMatchObject({ state: "stuck", notified: ["stuck"] });
      expect(await texts()).toHaveLength(1);
      // A milestone is worth a badge.
      expect((await system.thread.findUniqueOrThrow({ where: { id: mainThread.id } })).unread).toBe(
        true,
      );
      expect((await texts())[0]).toContain("「竞品调研 #TPA00001」已经约 11 分钟没有新进展");
      expect(
        await taskStuckFields(
          system,
          { status: "started", workerRunId: a.run.id, startedAt: t0, createdAt: t0 },
          "running",
          later,
        ),
      ).toEqual({ stuck: true, quiet_for_min: 11 });
      expect(
        await refreshTaskProgressCard(deps, main.id, {
          now: new Date(later.getTime() + 60_000),
          stuckMs: STUCK,
        }),
      ).toBe(false);
      expect(await texts()).toHaveLength(1);

      // A finishes (its result went to the main bot); B failed silently.
      await system.run.update({
        where: { id: a.run.id },
        data: { status: "completed", completedAt: new Date(), botOutcomeReturnedAt: new Date() },
      });
      await system.backgroundTaskQueue.updateMany({
        where: { botId: main.id, ref: "TPA00001" },
        data: { status: "completed", finishedAt: new Date() },
      });
      await system.backgroundTaskQueue.updateMany({
        where: { botId: main.id, ref: "TPB00002" },
        data: {
          status: "failed",
          error: "worker hand-off did not complete",
          finishedAt: new Date(),
        },
      });
      await refreshAllTaskProgressCards(deps);
      [card] = await cards();
      expect(block(card!).closed).toBe(true);
      expect(block(card!).tasks.map((task) => task.state)).toEqual(["done", "failed"]);
      expect(await texts()).toHaveLength(2);
      expect((await texts())[1]).toContain(
        "「导出报表 #TPB00002」没能完成：worker hand-off did not complete",
      );
      // Closed: further passes leave it alone.
      expect(await refreshTaskProgressCard(deps, main.id)).toBe(false);

      // The next task opens a new card.
      const c = await startWorker(2);
      await queue("TPC00003", "写周报", {
        status: "started",
        workerBotId: c.worker.id,
        workerRunId: c.run.id,
        startedAt: new Date(),
        createdAt: new Date(),
      });
      expect(await refreshTaskProgressCard(deps, main.id)).toBe(true);
      const all = await cards();
      expect(all).toHaveLength(2);
      expect(block(all[1]!).tasks.map((task) => task.ref)).toEqual(["TPC00003"]);
      expect(block(all[1]!).closed).toBeUndefined();
    } finally {
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
