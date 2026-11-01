import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { handoffToGroupBot } from "./group-handoff.js";
import { createGroupHandoffRun, humanStartedHandoffRun } from "./group-handoff-run.js";

const run = {
  id: "research-run",
  spaceId: "space",
  threadId: "thread",
  botId: "research",
  userId: "user",
};
const source = {
  id: "human-message",
  role: "user",
  botId: null,
  clientNonce: null,
  blocks: [{ kind: "text", text: "@调研经理 @运营 核对素材，然后交给运营。" }],
};

function harness(existingTarget = true) {
  let receipt: {
    id: string;
    blocks: MessageBlock[];
    sourceRuns: { id: string; botId: string }[];
  } | null = null;
  let recordedEvent: { seq: number; payload?: unknown } = { seq: 1 };
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "group" }]),
    chatGroup: {
      findFirst: vi.fn(async () => ({
        name: "测试团队",
        thread: { id: run.threadId },
        members: [
          { bot: { id: "research", name: "调研经理" } },
          { bot: { id: "ops", name: "运营" } },
          { bot: { id: "seo", name: "SEO" } },
        ],
      })),
      update: vi.fn(),
    },
    run: {
      findFirst: vi.fn(async (args: { where: { id?: string; sourceMessageId?: string } }) =>
        args.where.id === run.id
          ? { id: run.id, thread: { groupId: "group" }, sourceMessage: source }
          : args.where.sourceMessageId && existingTarget
            ? { id: "mentioned-run", botId: "ops" }
            : null,
      ),
      findUnique: vi.fn(async () => ({ status: "running" })),
      create: vi.fn(async () => {
        if (receipt) receipt.sourceRuns = [{ id: "handoff-run", botId: "ops" }];
        return { id: "handoff-run" };
      }),
    },
    message: {
      findUnique: vi.fn(async () => receipt),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async (): Promise<{ blocks: MessageBlock[] }[]> => []),
      create: vi.fn(async ({ data }: { data: { blocks: MessageBlock[] } }) => {
        receipt = { id: "handoff-message", blocks: data.blocks, sourceRuns: [] };
        return receipt;
      }),
    },
    task: { create: vi.fn(async () => ({ id: "target-task" })) },
    event: {
      create: vi.fn(async ({ data }: { data: { payload: unknown } }) => {
        recordedEvent = { seq: 1, payload: data.payload };
        return recordedEvent;
      }),
      findFirst: vi.fn(async () => recordedEvent),
    },
    thread: { update: vi.fn(async () => ({ nextMessageSeq: 1, nextEventSeq: 1 })) },
  };
  const deps = {
    prisma: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaClient,
    events: { notify: vi.fn(async () => undefined) },
    jobs: { enqueue: vi.fn(async () => undefined) },
  };
  return { tx, deps };
}

describe("mention and handoff share the human's target run", () => {
  it("records the handoff once without starting or waking a second target turn, including replay", async () => {
    const h = harness();
    const call = { bot_id: "ops", message: "请核对素材来源。" };
    for (let replay = 0; replay < 2; replay++) {
      await expect(handoffToGroupBot(h.deps as never, run, "group", call)).resolves.toMatchObject({
        ok: true,
        delivered: true,
        runId: "mentioned-run",
        botId: "ops",
      });
    }
    expect(h.tx.message.create).toHaveBeenCalledOnce();
    expect(h.tx.event.create).toHaveBeenCalledOnce();
    expect(h.tx.run.create).not.toHaveBeenCalled();
    expect(h.tx.task.create).not.toHaveBeenCalled();
    expect(h.deps.jobs.enqueue).not.toHaveBeenCalled();
    expect(h.tx.message.create.mock.calls[0]?.[0].data.blocks).toEqual([
      expect.objectContaining({ kind: "handoff", toBotId: "ops", text: call.message }),
    ]);
    await expect(
      handoffToGroupBot(h.deps as never, run, "group", { bot_id: "seo", message: call.message }),
    ).resolves.toMatchObject({ reason: "one_handoff_per_turn" });
  });

  it("still starts the target when the human only started the handing-off bot", async () => {
    const h = harness(false);
    await expect(
      handoffToGroupBot(h.deps as never, run, "group", { bot_id: "ops", message: "核对来源" }),
    ).resolves.toMatchObject({ ok: true, runId: "handoff-run" });
    expect(h.tx.run.create).toHaveBeenCalledOnce();
    expect(h.tx.task.create).toHaveBeenCalledOnce();
    expect(h.deps.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("does not echo a saved reply in an automatic handoff, but delivers the full brief and replays it", async () => {
    const h = harness(false);
    const brief = "@运营 请核对来源。";
    h.tx.message.findMany.mockResolvedValue([{ blocks: [{ kind: "text", text: brief }] }]);
    for (let replay = 0; replay < 2; replay++) {
      await expect(
        handoffToGroupBot(
          h.deps as never,
          run,
          "group",
          { bot_id: "ops", message: brief },
          { allowFinishedSource: true },
        ),
      ).resolves.toMatchObject({ ok: true, runId: "handoff-run" });
    }
    expect(h.tx.message.create).toHaveBeenCalledOnce();
    expect(h.tx.message.create.mock.calls[0]?.[0].data.blocks).toEqual([
      expect.objectContaining({ kind: "handoff", text: "" }),
    ]);
    expect(h.tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({ text: "", brief }),
        }),
      }),
    );
    expect(h.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ prompt: brief }) }),
    );
    await expect(
      handoffToGroupBot(
        h.deps as never,
        run,
        "group",
        { bot_id: "ops", message: "different brief" },
        { allowFinishedSource: true },
      ),
    ).resolves.toMatchObject({ reason: "one_handoff_per_turn" });
    expect(h.tx.run.create).toHaveBeenCalledOnce();
  });

  it("shows an automatic handoff's brief when the turn has no saved reply", async () => {
    const h = harness(false);
    const brief = "请核对来源。";
    await handoffToGroupBot(
      h.deps as never,
      run,
      "group",
      { bot_id: "ops", message: brief },
      { allowFinishedSource: true },
    );
    expect(h.tx.message.create.mock.calls[0]?.[0].data.blocks).toEqual([
      expect.objectContaining({ kind: "handoff", text: brief }),
    ]);
  });

  it("uses the exact human source, owner and group; completed targets count too", async () => {
    const h = harness();
    await humanStartedHandoffRun(h.tx as never, run, source, "ops");
    expect(h.tx.run.findFirst).toHaveBeenCalledWith({
      where: {
        spaceId: run.spaceId,
        threadId: run.threadId,
        userId: run.userId,
        botId: "ops",
        sourceMessageId: source.id,
        trigger: "user",
        status: { notIn: ["cancelled", "failed"] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, botId: true },
    });
  });

  it("replays a recorded mention handoff even after the target failed or was cancelled", async () => {
    const h = harness();
    const call = { bot_id: "ops", message: "Review the sources" };
    await handoffToGroupBot(h.deps as never, run, "group", call);
    h.tx.run.findFirst.mockClear();
    await expect(handoffToGroupBot(h.deps as never, run, "group", call)).resolves.toMatchObject({
      ok: true,
      runId: "mentioned-run",
    });
    const lookup = h.tx.run.findFirst.mock.calls.find(([args]) => args.where.sourceMessageId);
    expect(lookup?.[0].where).toHaveProperty("id", "mentioned-run");
    expect(lookup?.[0].where).not.toHaveProperty("status");
    expect(h.tx.run.create).not.toHaveBeenCalled();
    expect(h.tx.message.create).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { ...source, role: "bot" },
    { ...source, botId: "worker" },
    { ...source, blocks: [{ kind: "bot_message_received", fromBotId: "worker" }] },
    {
      ...source,
      blocks: [{ kind: "handoff", fromBotId: "research", toBotId: "ops", text: "next" }],
    },
  ])("does not dedupe another stage or a bot relay as a human mention: %j", async (input) => {
    const h = harness();
    expect(await humanStartedHandoffRun(h.tx as never, run, input, "ops")).toBeNull();
    expect(h.tx.run.findFirst).not.toHaveBeenCalled();
  });

  it("does not merge a private-chat delivery into a human turn in the destination group", async () => {
    const h = harness();
    const next = await createGroupHandoffRun(h.tx as never, run, {
      threadId: "destination",
      botId: "ops",
      messageId: "handoff",
      text: "next",
      source,
      inGroup: false,
    });
    expect(next).toMatchObject({ id: "handoff-run", reused: false });
    expect(h.tx.run.findFirst).not.toHaveBeenCalled();
    expect(h.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "destination",
          trigger: "follow_up",
          sourceMessageId: "handoff",
        }),
      }),
    );
  });
});
