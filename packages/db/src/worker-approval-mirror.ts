import type { MessageBlock, WorkerApprovalMirror } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";

/*
 * A hidden background worker that pauses on an approval card gets a copy of that card in its
 * main bot's chat (the background task's thread). The copy has no run of its own (runId null)
 * and carries workerApproval: answering it answers the worker's card through the same
 * transaction as answering there (see answerRunInput), and every answer of the worker's card
 * settles the copy. A worker that ends first closes the copy instead.
 */

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

export type WorkerApprovalSettle =
  | { status: "answered"; answer: string }
  | { closed: NonNullable<WorkerApprovalMirror["closed"]> };

export type MirrorEvent = { threadId: string; seq: number };

/*
 * Message blocks are sealed at rest; only "kind" and "status" stay queryable (see
 * content-encryption.ts). Candidates are found by kind and filtered on the opened blocks.
 */
const ASK_BLOCK = { array_contains: [{ kind: "ask" }] };

function askBlocks(blocks: unknown): MessageBlock[] {
  const parsed = MessageBlockSchema.array().safeParse(blocks);
  return parsed.success ? parsed.data : [];
}

function hasAsk(blocks: unknown, match: (block: AskBlock) => boolean) {
  return askBlocks(blocks).some((block) => block.kind === "ask" && match(block));
}

/** The background task whose worker run this is, which names the main chat. */
async function taskForWorkerRun(tx: Prisma.TransactionClient, runId: string) {
  return tx.backgroundTaskQueue.findFirst({
    where: { workerRunId: runId },
    select: { threadId: true, spaceId: true, botId: true, name: true, ref: true, id: true },
  });
}

/** "任务 #REF（name）": which task asks, shown on the copy. */
export function workerApprovalLabel(task: { id: string; name: string; ref: string | null }) {
  return `任务 #${task.ref ?? task.id}（${task.name}）`.slice(0, 400);
}

/**
 * Posts the copy of a worker's pending approval card into the main chat, once per approval.
 * Returns the event to notify, or null when the run carries no task or the copy exists.
 */
export async function postWorkerApprovalMirror(
  prisma: PrismaClient,
  input: { workerRunId: string; workerThreadId: string; block: AskBlock },
): Promise<(MirrorEvent & { botId: string }) | null> {
  const effectId = input.block.approvalEffectId;
  if (!effectId) return null;
  return prisma.$transaction(async (tx) => {
    const task = await taskForWorkerRun(tx, input.workerRunId);
    if (!task) return null;
    const original = (
      await tx.message.findMany({
        where: {
          threadId: input.workerThreadId,
          runId: input.workerRunId,
          role: "bot",
          blocks: ASK_BLOCK,
        },
        orderBy: { seq: "desc" },
        select: { id: true, blocks: true },
      })
    ).find((message) => hasAsk(message.blocks, (block) => block.approvalEffectId === effectId));
    if (!original) return null;
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${task.threadId} FOR UPDATE`;
    const existing = (
      await tx.message.findMany({
        where: { threadId: task.threadId, runId: null, role: "bot", blocks: ASK_BLOCK },
        select: { blocks: true },
      })
    ).some((message) =>
      hasAsk(
        message.blocks,
        (block) =>
          block.workerApproval?.runId === input.workerRunId && block.approvalEffectId === effectId,
      ),
    );
    if (existing) return null;
    const blocks: MessageBlock[] = [
      {
        ...input.block,
        status: "pending",
        workerApproval: {
          runId: input.workerRunId,
          messageId: original.id,
          label: workerApprovalLabel(task),
        },
      },
    ];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: task.threadId,
      role: "bot",
      blocks,
      botId: task.botId,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: task.spaceId,
      threadId: task.threadId,
      botId: task.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { threadId: event.threadId, seq: event.seq, botId: task.botId };
  });
}

/**
 * Settles every still-open copy of a worker run's approval (one effect, or all of the run's when
 * approvalEffectId is omitted). Runs inside the caller's transaction so the copy and the
 * worker's card change together. Returns the main chat's last event to notify.
 */
export async function settleWorkerApprovalMirrorsInTransaction(
  tx: Prisma.TransactionClient,
  input: { runId: string; approvalEffectId?: string; settle: WorkerApprovalSettle },
): Promise<MirrorEvent | null> {
  const task = await taskForWorkerRun(tx, input.runId);
  if (!task) return null;
  const messages = (
    await tx.message.findMany({
      where: { threadId: task.threadId, runId: null, role: "bot", blocks: ASK_BLOCK },
      select: { id: true, blocks: true, botId: true },
    })
  ).filter((message) =>
    hasAsk(message.blocks, (block) => block.workerApproval?.runId === input.runId),
  );
  if (!messages.length) return null;
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${task.threadId} FOR UPDATE`;
  let last: MirrorEvent | null = null;
  for (const message of messages) {
    let changed = false;
    const blocks = askBlocks(message.blocks).map((block) => {
      if (
        block.kind !== "ask" ||
        block.workerApproval?.runId !== input.runId ||
        (input.approvalEffectId && block.approvalEffectId !== input.approvalEffectId) ||
        block.status === "answered" ||
        block.workerApproval.closed
      )
        return block;
      changed = true;
      return "closed" in input.settle
        ? { ...block, workerApproval: { ...block.workerApproval, closed: input.settle.closed } }
        : { ...block, status: "answered" as const, answer: input.settle.answer };
    });
    if (!changed) continue;
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    const event = await appendEventInTransaction(tx, {
      spaceId: task.spaceId,
      threadId: task.threadId,
      botId: message.botId ?? task.botId,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    last = { threadId: event.threadId, seq: event.seq };
  }
  return last;
}

/**
 * Closes the open copies of a worker run's approvals once that run is no longer waiting on the
 * user: "cancelled" when it was cancelled, "expired" otherwise. No-op while it still waits.
 */
export async function closeWorkerApprovalMirrors(
  prisma: PrismaClient,
  runId: string,
): Promise<MirrorEvent | null> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.run.findUnique({ where: { id: runId }, select: { threadId: true } });
    if (!run) return null;
    // The worker's thread first, the same lock order as answering its card.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    const current = await tx.run.findUnique({ where: { id: runId }, select: { status: true } });
    if (!current || current.status === "waiting_input") return null;
    return settleWorkerApprovalMirrorsInTransaction(tx, {
      runId,
      settle: { closed: current.status === "cancelled" ? "cancelled" : "expired" },
    });
  });
}

export type WorkerApprovalMirrorTarget = {
  workerRunId: string;
  workerMessageId: string;
  approvalEffectId?: string;
  /** Not yet answered or closed. */
  open: boolean;
  /** The worker run, when it still belongs to this chat's task in this space. */
  run: { userId: string; threadId: string; status: string } | null;
};

/** The worker approval a main-chat message mirrors, or null for any other message. */
export async function findWorkerApprovalMirror(
  prisma: PrismaClient,
  input: { spaceId: string; threadId: string; messageId: string },
): Promise<WorkerApprovalMirrorTarget | null> {
  const message = await prisma.message.findFirst({
    where: { id: input.messageId, threadId: input.threadId, role: "bot", runId: null },
    select: { blocks: true },
  });
  const parsed = MessageBlockSchema.array().safeParse(message?.blocks);
  if (!message || !parsed.success) return null;
  const block = parsed.data.find(
    (candidate) => candidate.kind === "ask" && candidate.workerApproval,
  );
  if (block?.kind !== "ask" || !block.workerApproval) return null;
  const workerRunId = block.workerApproval.runId;
  const task = await prisma.backgroundTaskQueue.findFirst({
    where: { workerRunId, threadId: input.threadId, spaceId: input.spaceId },
    select: { id: true },
  });
  const run = task
    ? await prisma.run.findFirst({
        where: { id: workerRunId, spaceId: input.spaceId },
        select: { userId: true, threadId: true, status: true },
      })
    : null;
  return {
    workerRunId,
    workerMessageId: block.workerApproval.messageId,
    approvalEffectId: block.approvalEffectId,
    open: block.status !== "answered" && !block.workerApproval.closed,
    run,
  };
}
