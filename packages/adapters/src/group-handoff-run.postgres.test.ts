import { randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import { createDb, createThreadMessageInTransaction, runAsSystem } from "@rakazo/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { handoffToGroupBot } from "./group-handoff.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("group handoff delivery deduplication (PostgreSQL)", () => {
  const { prisma, pool } = createDb(process.env.DATABASE_URL ?? "");
  const sys = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
  const deps = {
    prisma,
    events: { notify: vi.fn(async () => undefined) },
    jobs: { enqueue: vi.fn(async () => undefined) },
  };
  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  async function fixture<T>(test: (fx: Awaited<ReturnType<typeof setup>>) => Promise<T>) {
    const fx = await sys(setup);
    try {
      return await test(fx);
    } finally {
      await sys(async () => {
        await prisma.space.delete({ where: { id: fx.spaceId } });
        await prisma.organization.delete({ where: { id: fx.spaceId } });
        await prisma.user.delete({ where: { id: fx.userId } });
      });
    }
  }

  async function setup() {
    const spaceId = `handoff-dedupe-${randomUUID()}`;
    const userId = spaceId;
    await prisma.user.create({
      data: { id: userId, name: "Test", email: `${userId}@example.test` },
    });
    await prisma.organization.create({
      data: { id: spaceId, name: "Test", slug: spaceId, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, name: "Test", organizationId: spaceId } });
    const research = await prisma.bot.create({
      data: { spaceId, userId, name: "团队-调研", color: "ink" },
    });
    const ops = await prisma.bot.create({
      data: { spaceId, userId, name: "团队-运营", color: "ink" },
    });
    const group = await prisma.chatGroup.create({
      data: {
        spaceId,
        userId,
        name: "Test",
        members: { create: [{ botId: research.id }, { botId: ops.id }] },
      },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } });
    const source = await prisma.$transaction((tx) =>
      createThreadMessageInTransaction(tx, {
        threadId: thread.id,
        role: "user",
        blocks: [{ kind: "text", text: "@团队-调研 @团队-运营 核对素材，然后交给团队-运营。" }],
      }),
    );
    async function start(botId: string, status: string) {
      const task = await prisma.task.create({
        data: { spaceId, userId, botId, threadId: thread.id, prompt: "核对素材", status },
      });
      return prisma.run.create({
        data: {
          spaceId,
          userId,
          botId,
          threadId: thread.id,
          taskId: task.id,
          status,
          trigger: "user",
          sourceMessageId: source.id,
        },
      });
    }
    const researchRun = await start(research.id, "running");
    return { spaceId, userId, group, thread, researchRun, ops, start };
  }

  it.each(["queued", "running", "completed"])(
    "reuses a %s target's human turn under concurrent handoff calls",
    async (status) =>
      fixture(async (fx) => {
        const target = await sys(() => fx.start(fx.ops.id, status));
        const call = { bot_id: fx.ops.id, message: "请核对素材来源。" };
        const results = await Promise.all(
          [0, 1].map(() =>
            sys(() => handoffToGroupBot(deps as never, fx.researchRun, fx.group.id, call)),
          ),
        );
        for (const result of results) expect(result).toMatchObject({ ok: true, runId: target.id });
        const runs = await sys(() =>
          prisma.run.findMany({ where: { threadId: fx.thread.id, botId: fx.ops.id } }),
        );
        expect(runs.map((run) => run.id)).toEqual([target.id]);
        const messages = await sys(() =>
          prisma.message.findMany({ where: { threadId: fx.thread.id, role: "bot" } }),
        );
        expect(messages).toHaveLength(1);
        expect(messages[0]?.blocks).toEqual([
          expect.objectContaining({ kind: "handoff", text: call.message }),
        ]);
      }),
  );

  it.each(["failed", "cancelled"])("allows a handoff to recover a %s target", async (status) =>
    fixture(async (fx) => {
      const old = await sys(() => fx.start(fx.ops.id, status));
      const result = await sys(() =>
        handoffToGroupBot(deps as never, fx.researchRun, fx.group.id, {
          bot_id: fx.ops.id,
          message: "请重试核对。",
        }),
      );
      expect(result).toMatchObject({ ok: true });
      if (!("ok" in result)) throw new Error("handoff failed");
      expect(result.runId).not.toBe(old.id);
      expect(
        await sys(() => prisma.run.count({ where: { threadId: fx.thread.id, botId: fx.ops.id } })),
      ).toBe(2);
    }),
  );

  it.each(["failed", "cancelled"])(
    "does not retry a recorded mention handoff when its target later becomes %s",
    async (status) =>
      fixture(async (fx) => {
        const target = await sys(() => fx.start(fx.ops.id, "running"));
        const call = { bot_id: fx.ops.id, message: "Review the sources" };
        await sys(() => handoffToGroupBot(deps as never, fx.researchRun, fx.group.id, call));
        await sys(() => prisma.run.update({ where: { id: target.id }, data: { status } }));
        await expect(
          sys(() => handoffToGroupBot(deps as never, fx.researchRun, fx.group.id, call)),
        ).resolves.toMatchObject({ ok: true, runId: target.id });
        expect(
          await sys(() =>
            prisma.run.count({ where: { threadId: fx.thread.id, botId: fx.ops.id } }),
          ),
        ).toBe(1);
      }),
  );

  it("replays the selected mention attempt when an older attempt already failed", async () =>
    fixture(async (fx) => {
      await sys(() => fx.start(fx.ops.id, "failed"));
      const target = await sys(() => fx.start(fx.ops.id, "running"));
      const call = { bot_id: fx.ops.id, message: "Review the sources" };
      for (let replay = 0; replay < 2; replay++)
        await expect(
          sys(() => handoffToGroupBot(deps as never, fx.researchRun, fx.group.id, call)),
        ).resolves.toMatchObject({ ok: true, runId: target.id });
      expect(
        await sys(() => prisma.run.count({ where: { threadId: fx.thread.id, botId: fx.ops.id } })),
      ).toBe(2);
    }));

  it("keeps a saved reply visible once while an automatic handoff delivers its full brief", async () =>
    fixture(async (fx) => {
      const brief = "素材已核对。@团队-运营 请继续。";
      await sys(async () => {
        await prisma.$transaction((tx) =>
          createThreadMessageInTransaction(tx, {
            threadId: fx.thread.id,
            role: "bot",
            botId: fx.researchRun.botId,
            runId: fx.researchRun.id,
            blocks: [{ kind: "text", text: brief }],
          }),
        );
        await prisma.run.update({
          where: { id: fx.researchRun.id },
          data: { status: "completed" },
        });
      });
      for (let replay = 0; replay < 2; replay++)
        await sys(() =>
          handoffToGroupBot(
            deps as never,
            fx.researchRun,
            fx.group.id,
            { bot_id: fx.ops.id, message: brief },
            { allowFinishedSource: true },
          ),
        );
      const messages = await sys(() =>
        prisma.message.findMany({ where: { threadId: fx.thread.id, role: "bot" } }),
      );
      const visible = messages.flatMap((message) =>
        (message.blocks as MessageBlock[]).flatMap((block) =>
          block.kind === "text" || block.kind === "handoff" ? [block.text].filter(Boolean) : [],
        ),
      );
      expect(visible).toEqual([brief]);
      expect(
        await sys(() => prisma.run.count({ where: { threadId: fx.thread.id, botId: fx.ops.id } })),
      ).toBe(1);
      const task = await sys(() =>
        prisma.task.findFirstOrThrow({ where: { threadId: fx.thread.id, botId: fx.ops.id } }),
      );
      expect(task.prompt).toBe(brief);
    }));
});
