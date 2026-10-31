import { randomUUID } from "node:crypto";
import { runContinueJob } from "@rakazo/adapter-kit";
import { createDb, runAsSystem } from "@rakazo/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { requeueComputerRun, startNextWaitingRun } from "./run-lifecycle.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("computer release and requeue ordering (PostgreSQL)", () => {
  const { prisma, pool } = createDb(process.env.DATABASE_URL ?? "");
  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  it.each(["release first", "requeue first"] as const)("wakes the waiter: %s", (order) =>
    runAsSystem("test fixture", async () => {
      const id = `release-wakeup-${randomUUID()}`;
      await prisma.user.create({ data: { id, name: "Owner", email: `${id}@example.test` } });
      await prisma.organization.create({
        data: { id, name: "Test", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id, name: "Test", organizationId: id } });
      const scope = { spaceId: id, userId: id };
      const computer = await prisma.computer.create({
        data: { ...scope, scopeKey: id, homeKey: id, kind: "fake", scope: "team" },
      });
      const bot = await prisma.bot.create({
        data: { ...scope, name: "Leader", color: "ink", computerId: computer.id },
      });
      const thread = await prisma.thread.create({ data: { ...scope, botId: bot.id } });
      const task = await prisma.task.create({
        data: { ...scope, botId: bot.id, threadId: thread.id, prompt: "test", status: "queued" },
      });
      const waiter = await prisma.run.create({
        data: {
          ...scope,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "running",
          trigger: "follow_up",
          leaseOwner: "test-worker",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      // The waiter already observed this holder and chose to wait for its release.
      const lease = await prisma.computerExecutionLease.create({
        data: {
          computerId: computer.id,
          botId: bot.id,
          runId: "previous-run",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const enqueue = vi.fn(async () => undefined);
      const deps = { prisma, jobs: { enqueue } } as unknown as ExecutorDeps;
      const release = async () => {
        // Releases retain an expired tombstone to preserve the computer fence.
        await prisma.computerExecutionLease.update({
          where: { id: lease.id },
          data: { expiresAt: new Date(0) },
        });
        await startNextWaitingRun(deps, bot.id, "previous-run");
      };
      const requeue = () =>
        requeueComputerRun(deps, waiter.id, "test-worker", 1, null, false, true);

      if (order === "release first") await release();
      else await requeue();
      expect(enqueue).not.toHaveBeenCalled();

      if (order === "release first") await requeue();
      else await release();
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob(waiter.id));
      expect(await prisma.run.findUniqueOrThrow({ where: { id: waiter.id } })).toMatchObject({
        status: "queued",
        wakeAt: new Date(0),
        leaseOwner: null,
      });
    }),
  );
});
