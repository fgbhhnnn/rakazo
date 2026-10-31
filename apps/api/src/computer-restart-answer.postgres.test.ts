import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { MessageBlock } from "@rakazo/contracts";
import {
  createDb,
  createThreadEvents,
  postComputerRestartPrompt,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  answerComputerRestartPrompt,
  COMPUTER_RESTART_FORBIDDEN,
  COMPUTER_RESTART_GONE,
  RESTART_BUSY_TEXT,
  RESTART_DONE_TEXT,
  RESTART_FAILED_TEXT,
} from "./computer-restart-answer.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;
const system = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);

async function withFixture(run: (fx: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const { prisma, pool } = createDb(process.env.DATABASE_URL!);
  const id = `cr-${randomUUID()}`;
  try {
    await run(await fixture(prisma, id));
  } finally {
    await system(async () => {
      await prisma.bot.deleteMany({ where: { spaceId: `${id}-space` } });
      await prisma.thread.deleteMany({ where: { spaceId: `${id}-space` } });
      await prisma.computer.deleteMany({ where: { spaceId: `${id}-space` } });
      await prisma.actionAutoReviewPreference.deleteMany({ where: { spaceId: `${id}-space` } });
      await prisma.space.deleteMany({ where: { id: `${id}-space` } });
      await prisma.organization.deleteMany({ where: { id: `${id}-org` } });
      await prisma.user.deleteMany({ where: { id: { in: [`${id}-user`, `${id}-other`] } } });
    }).catch(() => undefined);
    await pool.end();
  }
}

async function fixture(prisma: ReturnType<typeof createDb>["prisma"], id: string) {
  const userId = `${id}-user`;
  const otherUserId = `${id}-other`;
  const spaceId = `${id}-space`;
  const rows = await system(async () => {
    for (const uid of [userId, otherUserId])
      await prisma.user.create({ data: { id: uid, name: uid, email: `${uid}@rakazo.test` } });
    await prisma.organization.create({
      data: { id: `${id}-org`, name: "CR", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId: `${id}-org`, name: "CR" } });
    await prisma.actionAutoReviewPreference.create({
      data: { spaceId, userId, enabled: true, skipApprovals: true },
    });
    const computer = await prisma.computer.create({
      data: {
        spaceId,
        userId,
        scope: "dedicated",
        scopeKey: `${id}-scope`,
        homeKey: `${id}-home`,
        kind: "e2b",
        providerRef: "sbx-1",
        state: "running",
      },
    });
    const main = await prisma.bot.create({
      data: { spaceId, userId, name: "main", color: "ink", computerId: computer.id },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId: main.id } });
    await prisma.computerHealth.create({
      data: { computerId: computer.id, spaceId, unresponsiveCount: 3 },
    });
    return { computer, main, thread };
  });
  const events = createThreadEvents(prisma, { publish: vi.fn(async () => undefined) } as never);
  const deps = { prisma, events };
  const owner = { spaceId, userId };
  const other = { spaceId, userId: otherUserId };
  const post = () =>
    system(() =>
      postComputerRestartPrompt(prisma, {
        chat: { botId: rows.main.id, threadId: rows.thread.id, spaceId },
        computerId: rows.computer.id,
        text: "电脑连续 3 次没有响应，要重启吗？",
        detail: "这之后的改动可能会丢失",
        actions: [
          { id: "restart", label: "重启电脑" },
          { id: "keep", label: "先不重启" },
        ],
      }),
    );
  const restart = vi.fn(async (_botId: string) => undefined);
  const answer = (
    actor: typeof owner,
    messageId: string,
    value: string,
    runId: string = rows.computer.id,
  ) =>
    runAsTenant(actor, () =>
      answerComputerRestartPrompt(
        deps,
        actor,
        { threadId: rows.thread.id },
        { runId, messageId, answer: value },
        restart,
      ),
    );
  const card = (messageId: string) =>
    system(async () => {
      const message = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
      return (message.blocks as AskBlock[])[0]!;
    });
  const notices = () =>
    system(async () =>
      (
        await prisma.message.findMany({
          where: { threadId: rows.thread.id, role: "system" },
          orderBy: { seq: "asc" },
        })
      ).map((row) => (row.blocks as { text: string }[])[0]?.text),
    );
  const health = () =>
    system(() =>
      prisma.computerHealth.findUniqueOrThrow({ where: { computerId: rows.computer.id } }),
    );
  return { ...rows, prisma, owner, other, post, restart, answer, card, notices, health };
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ORPCError);
  return error as ORPCError<string, unknown>;
}

postgres("answering a computer restart card (PostgreSQL)", () => {
  it("restarts only on the owner's explicit yes, once", async () => {
    await withFixture(async (fx) => {
      const posted = await fx.post();
      expect(posted).not.toBeNull();
      // A second card is not posted while one is open.
      expect(await fx.post()).toBeNull();
      const messageId = posted!.messageId;

      const forbidden = await rejection(fx.answer(fx.other, messageId, "restart"));
      expect(forbidden.code).toBe("FORBIDDEN");
      expect(forbidden.message).toBe(COMPUTER_RESTART_FORBIDDEN);
      const wrongRun = await rejection(fx.answer(fx.owner, messageId, "restart", "run-x"));
      expect(wrongRun.code).toBe("CONFLICT");
      const unknown = await rejection(fx.answer(fx.owner, messageId, "yes please"));
      expect(unknown.code).toBe("BAD_REQUEST");
      expect(fx.restart).not.toHaveBeenCalled();
      expect((await fx.card(messageId)).status).toBe("pending");

      // Two answers at once reset at most once.
      const results = await Promise.allSettled([
        fx.answer(fx.owner, messageId, "restart"),
        fx.answer(fx.owner, messageId, "restart"),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect((lost.reason as ORPCError<string, unknown>).message).toBe(COMPUTER_RESTART_GONE);
      expect(fx.restart).toHaveBeenCalledTimes(1);
      expect(fx.restart).toHaveBeenCalledWith(fx.main.id);
      expect(await fx.card(messageId)).toMatchObject({
        status: "answered",
        answer: "restart",
        computerRestart: { outcome: "restarted" },
      });
      expect(await fx.notices()).toEqual([RESTART_DONE_TEXT]);
      expect((await fx.health()).unresponsiveCount).toBe(0);

      const again = await rejection(fx.answer(fx.owner, messageId, "restart"));
      expect(again.code).toBe("CONFLICT");
      expect(fx.restart).toHaveBeenCalledTimes(1);
    });
  });

  it("leaves the computer alone on 'keep'", async () => {
    await withFixture(async (fx) => {
      const posted = await fx.post();
      await expect(fx.answer(fx.owner, posted!.messageId, "keep")).resolves.toBe(true);
      expect(fx.restart).not.toHaveBeenCalled();
      expect(await fx.card(posted!.messageId)).toMatchObject({
        status: "answered",
        answer: "keep",
      });
      expect(await fx.notices()).toEqual([]);
      const late = await rejection(fx.answer(fx.owner, posted!.messageId, "restart"));
      expect(late.code).toBe("CONFLICT");
      expect(fx.restart).not.toHaveBeenCalled();
    });
  });

  it("says when the restart could not run", async () => {
    await withFixture(async (fx) => {
      const busy = await fx.post();
      fx.restart.mockRejectedValueOnce(new ORPCError("CONFLICT", { message: "Computer is busy" }));
      await expect(fx.answer(fx.owner, busy!.messageId, "restart")).resolves.toBe(true);
      expect((await fx.card(busy!.messageId)).computerRestart?.outcome).toBe("failed");

      const broken = await fx.post();
      fx.restart.mockRejectedValueOnce(new Error("provider down"));
      await expect(fx.answer(fx.owner, broken!.messageId, "restart")).resolves.toBe(true);
      expect(await fx.notices()).toEqual([RESTART_BUSY_TEXT, RESTART_FAILED_TEXT]);
      expect((await fx.health()).unresponsiveCount).toBe(3);
    });
  });

  it("is not a restart card for any other message", async () => {
    await withFixture(async (fx) => {
      const other = await system(() =>
        fx.prisma.message.create({
          data: {
            threadId: fx.thread.id,
            seq: 99,
            role: "bot",
            botId: fx.main.id,
            blocks: [{ kind: "text", text: "hi" }],
          },
        }),
      );
      await expect(fx.answer(fx.owner, other.id, "restart")).resolves.toBe(false);
      expect(fx.restart).not.toHaveBeenCalled();
    });
  });
});
