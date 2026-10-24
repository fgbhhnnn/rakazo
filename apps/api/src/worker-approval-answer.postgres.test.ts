import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  closeWorkerApprovalMirrors,
  createDb,
  createThreadEvents,
  postWorkerApprovalMirror,
  runAsSystem,
} from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  answerWorkerApprovalMirror,
  WORKER_APPROVAL_FORBIDDEN,
  WORKER_APPROVAL_GONE,
} from "./worker-approval-answer.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

const system = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

async function withFixture(
  run: (fx: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
): Promise<void> {
  const { prisma, pool } = createDb(process.env.DATABASE_URL!);
  const id = `wa-${randomUUID()}`;
  try {
    await run(await createFixture(prisma, id));
  } finally {
    await system(async () => {
      await prisma.backgroundTaskQueue.deleteMany({ where: { spaceId: `${id}-space` } });
      await prisma.actionApprovalRule.deleteMany({ where: { spaceId: `${id}-space` } });
      await prisma.bot.deleteMany({ where: { spaceId: `${id}-space` } });
      await prisma.thread.deleteMany({ where: { spaceId: `${id}-space` } });
      await prisma.space.deleteMany({ where: { id: `${id}-space` } });
      await prisma.organization.deleteMany({ where: { id: `${id}-org` } });
      await prisma.user.deleteMany({ where: { id: { in: [`${id}-user`, `${id}-other`] } } });
    }).catch(() => undefined);
    await pool.end();
  }
}

async function createFixture(prisma: ReturnType<typeof createDb>["prisma"], id: string) {
  const userId = `${id}-user`;
  const otherUserId = `${id}-other`;
  const spaceId = `${id}-space`;
  const organizationId = `${id}-org`;
  const ids = await system(async () => {
    for (const [uid, name] of [
      [userId, "Owner"],
      [otherUserId, "Other"],
    ]) {
      await prisma.user.create({ data: { id: uid, name, email: `${uid}@rakazo.test` } });
    }
    await prisma.organization.create({
      data: { id: organizationId, name: "WA", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "WA" } });
    const main = await prisma.bot.create({
      data: { spaceId, userId, name: "main", color: "ink" },
    });
    const worker = await prisma.bot.create({
      data: {
        spaceId,
        userId,
        name: "main · 后台1",
        color: "ink",
        parentBotId: main.id,
        spawnKey: `bg-worker:${main.id}:1`,
      },
    });
    const mainThread = await prisma.thread.create({ data: { spaceId, userId, botId: main.id } });
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
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: workerRun.id,
        kind: "web_fetch",
        idempotencyKey: `${id}-effect`,
        status: "intended",
        request: { url: "https://example.com/report" },
      },
    });
    const ask: AskBlock = {
      kind: "ask",
      approvalEffectId: effect.id,
      text: "Review before web_fetch → example.com",
      detail: "url: https://example.com/report",
      site: "example.com",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow example.com" },
        { id: "deny", label: "Deny" },
      ],
    };
    const workerMessage = await prisma.message.create({
      data: {
        threadId: workerThread.id,
        seq: 0,
        role: "bot",
        botId: worker.id,
        runId: workerRun.id,
        blocks: [ask],
      },
    });
    await prisma.backgroundTaskQueue.create({
      data: {
        spaceId,
        botId: main.id,
        userId,
        runId: mainRun.id,
        threadId: mainThread.id,
        name: "抓报表",
        task: "fetch the report",
        args: {},
        status: "started",
        workerBotId: worker.id,
        workerRunId: workerRun.id,
        ref: "A7",
        startedAt: new Date(),
      },
    });
    return { main, worker, mainThread, workerThread, mainRun, workerRun, effect, workerMessage };
  });
  const publish = vi.fn(async () => undefined);
  const events = createThreadEvents(prisma, { publish } as never);
  const jobs = { enqueue: vi.fn(async () => undefined) };
  const deps = { prisma, events, jobs } as never;
  const owner = { spaceId, userId };
  const other = { spaceId, userId: otherUserId };
  const mirror = await system(() =>
    postWorkerApprovalMirror(prisma, {
      workerRunId: ids.workerRun.id,
      workerThreadId: ids.workerThread.id,
      block: (ids.workerMessage.blocks as AskBlock[])[0]!,
    }),
  );
  const mirrorMessage = await system(() =>
    prisma.message.findFirstOrThrow({ where: { threadId: ids.mainThread.id } }),
  );
  const answer = (actor: typeof owner, answer: string, runId = ids.workerRun.id) =>
    system(() =>
      answerWorkerApprovalMirror(
        deps,
        actor,
        { threadId: ids.mainThread.id },
        {
          runId,
          messageId: mirrorMessage.id,
          answer,
        },
      ),
    );
  const state = () =>
    system(async () => ({
      effect: (await prisma.externalEffect.findUniqueOrThrow({ where: { id: ids.effect.id } }))
        .status,
      run: (await prisma.run.findUniqueOrThrow({ where: { id: ids.workerRun.id } })).status,
      worker: (
        (await prisma.message.findUniqueOrThrow({ where: { id: ids.workerMessage.id } }))
          .blocks as AskBlock[]
      )[0],
      mirror: (
        (await prisma.message.findUniqueOrThrow({ where: { id: mirrorMessage.id } }))
          .blocks as AskBlock[]
      )[0],
    }));
  return {
    ...ids,
    prisma,
    events,
    jobs,
    deps,
    publish,
    owner,
    other,
    mirror,
    mirrorMessage,
    answer,
    state,
  };
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ORPCError);
  return error as ORPCError<string, unknown>;
}

postgres("worker approval answered in the main chat (PostgreSQL)", () => {
  it("mirrors the card once, in the main chat, with the same content and controls", async () => {
    await withFixture(async (fx) => {
      expect(fx.mirror).toEqual({
        threadId: fx.mainThread.id,
        seq: expect.any(Number),
        botId: fx.main.id,
      });
      expect(fx.mirrorMessage).toMatchObject({ role: "bot", botId: fx.main.id, runId: null });
      expect(fx.mirrorMessage.blocks).toEqual([
        {
          ...(fx.workerMessage.blocks as AskBlock[])[0],
          workerApproval: {
            runId: fx.workerRun.id,
            messageId: fx.workerMessage.id,
            label: "任务 #A7（抓报表）",
          },
        },
      ]);
      // Re-raising the same approval (a resumed turn) never posts a second copy.
      const again = await system(() =>
        postWorkerApprovalMirror(fx.prisma, {
          workerRunId: fx.workerRun.id,
          workerThreadId: fx.workerThread.id,
          block: (fx.workerMessage.blocks as AskBlock[])[0]!,
        }),
      );
      expect(again).toBeNull();
      expect(
        await system(() => fx.prisma.message.count({ where: { threadId: fx.mainThread.id } })),
      ).toBe(1);
      // A run without a background task (an ordinary bot) gets no copy.
      expect(
        await system(() =>
          postWorkerApprovalMirror(fx.prisma, {
            workerRunId: fx.mainRun.id,
            workerThreadId: fx.mainThread.id,
            block: (fx.workerMessage.blocks as AskBlock[])[0]!,
          }),
        ),
      ).toBeNull();
    });
  });

  it("answering the copy resolves the worker's approval once, only for the run's user", async () => {
    await withFixture(async (fx) => {
      const forbidden = await rejection(fx.answer(fx.other, "allow"));
      expect(forbidden.code).toBe("FORBIDDEN");
      expect(forbidden.message).toBe(WORKER_APPROVAL_FORBIDDEN);
      expect(await fx.state()).toMatchObject({
        effect: "intended",
        run: "waiting_input",
        worker: { status: "pending" },
        mirror: { status: "pending" },
      });

      // The run named must be the worker's own.
      expect((await rejection(fx.answer(fx.owner, "allow", fx.mainRun.id))).code).toBe("CONFLICT");

      expect(await fx.answer(fx.owner, "allow")).toBe(true);
      expect(await fx.state()).toEqual({
        effect: "approved",
        run: "queued",
        worker: expect.objectContaining({ status: "answered", answer: "allow" }),
        mirror: expect.objectContaining({ status: "answered", answer: "allow" }),
      });
      expect(fx.jobs.enqueue).toHaveBeenCalledWith(runContinueJob(fx.workerRun.id));
      // Both chats were told about their changed card.
      const topics = (fx.publish.mock.calls as unknown as [string, string][]).map(([t]) => t);
      expect(topics.some((t) => t.includes(fx.workerThread.id))).toBe(true);
      expect(topics.some((t) => t.includes(fx.mainThread.id))).toBe(true);

      // Answering twice, or again in the worker chat, never decides it a second time.
      const twice = await rejection(fx.answer(fx.owner, "deny"));
      expect([twice.code, twice.message]).toEqual(["CONFLICT", WORKER_APPROVAL_GONE]);
      expect(
        await system(() =>
          fx.events.answerRunInput({
            spaceId: fx.owner.spaceId,
            threadId: fx.workerThread.id,
            runId: fx.workerRun.id,
            messageId: fx.workerMessage.id,
            answeredByUserId: fx.owner.userId,
            answer: "deny",
          }),
        ),
      ).toBe(false);
      expect(await fx.state()).toMatchObject({
        effect: "approved",
        worker: { answer: "allow" },
        mirror: { answer: "allow" },
      });
      expect(fx.jobs.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  it("concurrent answers from the copy decide it exactly once", async () => {
    await withFixture(async (fx) => {
      const results = await Promise.allSettled([
        fx.answer(fx.owner, "allow"),
        fx.answer(fx.owner, "deny"),
        fx.answer(fx.owner, "allow"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const { effect, worker, mirror } = await fx.state();
      expect(["approved", "denied"]).toContain(effect);
      expect(mirror?.answer).toBe(worker?.answer);
      expect(fx.jobs.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  it("the always-allow option on the copy saves the rule for the run's user", async () => {
    await withFixture(async (fx) => {
      expect(await fx.answer(fx.owner, "always")).toBe(true);
      expect(await fx.state()).toMatchObject({
        effect: "approved",
        mirror: { status: "answered", answer: "always" },
      });
      const rules = await system(() =>
        fx.prisma.actionApprovalRule.findMany({ where: { spaceId: fx.owner.spaceId } }),
      );
      expect(rules).toEqual([
        expect.objectContaining({
          createdByUserId: fx.owner.userId,
          effect: "always_allow",
          matchKind: "site",
          matchValue: "example.com",
        }),
      ]);
    });
  });

  it("answering in the worker chat settles the copy too", async () => {
    await withFixture(async (fx) => {
      expect(
        await system(() =>
          fx.events.answerRunInput({
            spaceId: fx.owner.spaceId,
            threadId: fx.workerThread.id,
            runId: fx.workerRun.id,
            messageId: fx.workerMessage.id,
            answeredByUserId: fx.owner.userId,
            answer: "deny",
          }),
        ),
      ).toBe(true);
      expect(await fx.state()).toMatchObject({
        effect: "denied",
        mirror: { status: "answered", answer: "deny" },
      });
      expect((await rejection(fx.answer(fx.owner, "allow"))).code).toBe("CONFLICT");
      expect((await fx.state()).effect).toBe("denied");
    });
  });

  it("a cancelled worker closes the copy, which then cannot be answered", async () => {
    await withFixture(async (fx) => {
      // Still waiting: nothing to close.
      expect(await system(() => closeWorkerApprovalMirrors(fx.prisma, fx.workerRun.id))).toBeNull();
      await system(() =>
        fx.prisma.run.update({ where: { id: fx.workerRun.id }, data: { status: "cancelled" } }),
      );
      const closed = await system(() => closeWorkerApprovalMirrors(fx.prisma, fx.workerRun.id));
      expect(closed).toEqual({ threadId: fx.mainThread.id, seq: expect.any(Number) });
      expect((await fx.state()).mirror).toMatchObject({
        status: "pending",
        workerApproval: { closed: "cancelled" },
      });
      expect((await rejection(fx.answer(fx.owner, "allow"))).code).toBe("CONFLICT");
      expect((await fx.state()).effect).toBe("intended");
      // Already closed: a second close changes nothing.
      expect(await system(() => closeWorkerApprovalMirrors(fx.prisma, fx.workerRun.id))).toBeNull();
    });
  });

  it("a worker that ended any other way shows the copy as expired, even when answered late", async () => {
    await withFixture(async (fx) => {
      await system(() =>
        fx.prisma.run.update({ where: { id: fx.workerRun.id }, data: { status: "failed" } }),
      );
      // The answer finds the worker gone and closes the copy itself.
      expect((await rejection(fx.answer(fx.owner, "allow"))).code).toBe("CONFLICT");
      expect(await fx.state()).toMatchObject({
        effect: "intended",
        mirror: { status: "pending", workerApproval: { closed: "expired" } },
      });
    });
  });

  it("leaves every other message on the normal answer path", async () => {
    await withFixture(async (fx) => {
      expect(
        await system(() =>
          answerWorkerApprovalMirror(
            fx.deps,
            fx.owner,
            { threadId: fx.workerThread.id },
            {
              runId: fx.workerRun.id,
              messageId: fx.workerMessage.id,
              answer: "allow",
            },
          ),
        ),
      ).toBe(false);
      expect((await fx.state()).effect).toBe("intended");
    });
  });
});
