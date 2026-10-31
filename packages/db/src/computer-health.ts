import type { ComputerRestartPrompt, MessageBlock } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { HIDDEN_BOT_SPAWN_PREFIX } from "./bot-visibility.js";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";

/*
 * Storage for computer health: disk/memory readings, a count of failed checks in a row, and the
 * owner's main-chat notices about them, among them the card asking whether to restart. The
 * readings live in computer_health so they never move `computers.updatedAt`, which lifecycle
 * claims compare against.
 */

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

export type ComputerChatEvent = { threadId: string; seq: number };

/** The chat a computer's owner talks to it in: a visible bot of theirs on it with a chat. */
export type ComputerMainChat = { botId: string; threadId: string; spaceId: string };

const ASK_BLOCK = { array_contains: [{ kind: "ask" }] };

function parseBlocks(blocks: unknown): MessageBlock[] {
  const parsed = MessageBlockSchema.array().safeParse(blocks);
  return parsed.success ? parsed.data : [];
}

function restartBlock(blocks: MessageBlock[]): AskBlock | undefined {
  const block = blocks.find((candidate) => candidate.kind === "ask" && candidate.computerRestart);
  return block?.kind === "ask" ? block : undefined;
}

/**
 * The owner's main chat for a computer: their visible, unarchived bot on it that has a chat,
 * the one they ran most recently (the oldest when none ran). A hidden worker on the computer
 * stands for the bot that started it. Null when the owner has no such chat.
 */
export async function findComputerMainChat(
  prisma: PrismaClient,
  computerId: string,
): Promise<ComputerMainChat | null> {
  const computer = await prisma.computer.findUnique({
    where: { id: computerId },
    select: { userId: true, spaceId: true },
  });
  if (!computer) return null;
  const onComputer = await prisma.bot.findMany({
    where: { computerId, archivedAt: null, userId: computer.userId },
    select: { id: true, spawnKey: true, parentBotId: true },
  });
  const ids = new Set<string>();
  for (const bot of onComputer) {
    if (!bot.spawnKey?.startsWith(HIDDEN_BOT_SPAWN_PREFIX)) ids.add(bot.id);
    else if (bot.parentBotId) ids.add(bot.parentBotId);
  }
  if (!ids.size) return null;
  const bots = await prisma.bot.findMany({
    where: {
      id: { in: [...ids] },
      archivedAt: null,
      userId: computer.userId,
      spaceId: computer.spaceId,
      thread: { isNot: null },
      OR: [{ spawnKey: null }, { NOT: { spawnKey: { startsWith: HIDDEN_BOT_SPAWN_PREFIX } } }],
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      thread: { select: { id: true } },
      runs: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
    },
  });
  let best: (typeof bots)[number] | undefined;
  for (const bot of bots) {
    const ranAt = bot.runs[0]?.createdAt.getTime() ?? -1;
    const bestAt = best?.runs[0]?.createdAt.getTime() ?? -1;
    if (!best || ranAt > bestAt) best = bot;
  }
  if (!best?.thread) return null;
  return { botId: best.id, threadId: best.thread.id, spaceId: computer.spaceId };
}

export async function readComputerHealth(prisma: PrismaClient, computerId: string) {
  return prisma.computerHealth.findUnique({ where: { computerId } });
}

/** Creates the computer's health row when missing and applies `data`. */
export async function updateComputerHealth(
  prisma: PrismaClient,
  input: { computerId: string; spaceId: string; data: Prisma.ComputerHealthUpdateInput },
) {
  return prisma.computerHealth.upsert({
    where: { computerId: input.computerId },
    create: {
      computerId: input.computerId,
      spaceId: input.spaceId,
      ...(input.data as Omit<Prisma.ComputerHealthUncheckedCreateInput, "computerId" | "spaceId">),
    },
    update: input.data,
  });
}

/** Adds one to the computer's failed checks in a row and returns the new count. */
export async function countComputerUnresponsive(
  prisma: PrismaClient,
  input: { computerId: string; spaceId: string },
): Promise<number> {
  const row = await prisma.computerHealth.upsert({
    where: { computerId: input.computerId },
    create: { computerId: input.computerId, spaceId: input.spaceId, unresponsiveCount: 1 },
    update: { unresponsiveCount: { increment: 1 } },
    select: { unresponsiveCount: true },
  });
  return row.unresponsiveCount;
}

/** A grey line in the chat with no model run (a role "system" meta block). */
export async function postComputerNotice(
  prisma: PrismaClient,
  chat: ComputerMainChat,
  text: string,
): Promise<ComputerChatEvent> {
  const blocks: MessageBlock[] = [{ kind: "meta", text }];
  return prisma.$transaction(async (tx) => {
    const message = await createThreadMessageInTransaction(tx, {
      threadId: chat.threadId,
      botId: chat.botId,
      role: "system",
      blocks,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: chat.spaceId,
      threadId: chat.threadId,
      botId: chat.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "system", blocks },
    });
    return { threadId: event.threadId, seq: event.seq };
  });
}

/**
 * Posts the restart card for a computer into its main chat, unless one is still open there.
 * Records it on the health row. Null when an open card already exists.
 */
export async function postComputerRestartPrompt(
  prisma: PrismaClient,
  input: {
    chat: ComputerMainChat;
    computerId: string;
    text: string;
    detail: string;
    actions: AskBlock["actions"];
  },
): Promise<(ComputerChatEvent & { messageId: string }) | null> {
  const { chat } = input;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${chat.threadId} FOR UPDATE`;
    const open = (
      await tx.message.findMany({
        where: { threadId: chat.threadId, runId: null, role: "bot", blocks: ASK_BLOCK },
        select: { blocks: true },
      })
    ).some((message) => {
      const block = restartBlock(parseBlocks(message.blocks));
      return (
        block?.computerRestart?.computerId === input.computerId &&
        block.status !== "answered" &&
        !block.computerRestart.closed
      );
    });
    if (open) return null;
    const blocks: MessageBlock[] = [
      {
        kind: "ask",
        text: input.text,
        detail: input.detail,
        detailFormat: "text",
        actions: input.actions,
        status: "pending",
        computerRestart: { computerId: input.computerId, botId: chat.botId },
      },
    ];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: chat.threadId,
      role: "bot",
      blocks,
      botId: chat.botId,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: chat.spaceId,
      threadId: chat.threadId,
      botId: chat.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    await tx.computerHealth.upsert({
      where: { computerId: input.computerId },
      create: {
        computerId: input.computerId,
        spaceId: chat.spaceId,
        restartPromptedAt: new Date(),
        restartMessageId: message.id,
        restartThreadId: chat.threadId,
      },
      update: {
        restartPromptedAt: new Date(),
        restartMessageId: message.id,
        restartThreadId: chat.threadId,
      },
    });
    return { threadId: event.threadId, seq: event.seq, messageId: message.id };
  });
}

export type ComputerRestartTarget = {
  computerId: string;
  botId: string;
  open: boolean;
  /** The computer in this space, or null when it is gone. */
  computer: { userId: string; spaceId: string } | null;
};

/** The restart card a chat message is, or null for any other message. */
export async function findComputerRestartPrompt(
  prisma: PrismaClient,
  input: { spaceId: string; threadId: string; messageId: string },
): Promise<ComputerRestartTarget | null> {
  const message = await prisma.message.findFirst({
    where: { id: input.messageId, threadId: input.threadId, role: "bot", runId: null },
    select: { blocks: true },
  });
  if (!message) return null;
  const block = restartBlock(parseBlocks(message.blocks));
  if (!block?.computerRestart) return null;
  const { computerId, botId } = block.computerRestart;
  const computer = await prisma.computer.findFirst({
    where: { id: computerId, spaceId: input.spaceId },
    select: { userId: true, spaceId: true },
  });
  return {
    computerId,
    botId,
    open: block.status !== "answered" && !block.computerRestart.closed,
    computer,
  };
}

export type ComputerRestartSettle =
  | { status: "answered"; answer: string }
  | { closed: NonNullable<ComputerRestartPrompt["closed"]> }
  | { outcome: NonNullable<ComputerRestartPrompt["outcome"]> };

/**
 * Changes a restart card: answers it or closes it only while it is open (so one card resets a
 * computer at most once), or records what a "restart" answer did. Null when nothing changed.
 */
export async function settleComputerRestartPrompt(
  prisma: PrismaClient,
  input: { spaceId: string; threadId: string; messageId: string; settle: ComputerRestartSettle },
): Promise<ComputerChatEvent | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const message = await tx.message.findFirst({
      where: { id: input.messageId, threadId: input.threadId, role: "bot", runId: null },
      select: { id: true, blocks: true, botId: true },
    });
    if (!message) return null;
    const settle = input.settle;
    let changed = false;
    let botId = message.botId;
    const blocks = parseBlocks(message.blocks).map((block): MessageBlock => {
      if (block.kind !== "ask" || !block.computerRestart) return block;
      botId ??= block.computerRestart.botId;
      const open = block.status !== "answered" && !block.computerRestart.closed;
      if ("outcome" in settle) {
        if (block.status !== "answered" || block.computerRestart.outcome) return block;
        changed = true;
        return { ...block, computerRestart: { ...block.computerRestart, outcome: settle.outcome } };
      }
      if (!open) return block;
      changed = true;
      if ("closed" in settle)
        return { ...block, computerRestart: { ...block.computerRestart, closed: settle.closed } };
      return { ...block, status: "answered", answer: settle.answer };
    });
    if (!changed || !botId) return null;
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { threadId: event.threadId, seq: event.seq };
  });
}
