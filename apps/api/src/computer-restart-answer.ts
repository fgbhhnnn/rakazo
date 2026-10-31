import { ORPCError } from "@orpc/server";
import { COMPUTER_KEEP_ACTION, COMPUTER_RESTART_ACTION } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  findComputerRestartPrompt,
  postComputerNotice,
  settleComputerRestartPrompt,
  updateComputerHealth,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/*
 * The card asking whether to restart an unresponsive computer (posted by the sleep job, see
 * packages/adapters computer-health.ts) is answered here. Only the computer's owner can answer;
 * "restart" runs the same Reset as the computer panel (back to the last save), "keep" changes
 * nothing. The card is answered once, before the reset starts, so a repeated or concurrent
 * answer never resets twice. No approval setting answers it on the owner's behalf.
 */

export const COMPUTER_RESTART_FORBIDDEN = "Only the computer's owner can restart it";
export const COMPUTER_RESTART_GONE = "This prompt is no longer awaiting an answer";

type Deps = { prisma: PrismaClient; events: Pick<ThreadEvents, "notify"> };

export const RESTART_DONE_TEXT = "电脑已重启，恢复到了上次保存的状态。";
export const RESTART_BUSY_TEXT =
  "电脑正被任务占用，这次没有重启。等任务结束后，可以在电脑面板里点「重置」再试。";
export const RESTART_FAILED_TEXT = "重启没有成功。可以稍后在电脑面板里点「重置」再试。";

function isBusy(error: unknown): boolean {
  return error instanceof ORPCError && error.code === "CONFLICT";
}

/**
 * Handles an answer to a restart card. false when the message is not one (the normal answer
 * path runs); throws when it is one this user cannot answer now. `restart` resets the computer
 * through the bot named on the card.
 */
export async function answerComputerRestartPrompt(
  deps: Deps,
  actor: { spaceId: string; userId: string },
  target: { threadId: string },
  input: { runId: string; messageId: string; answer: string; username?: string; dismiss?: true },
  restart: (botId: string) => Promise<unknown>,
): Promise<boolean> {
  const prompt = await findComputerRestartPrompt(deps.prisma, {
    spaceId: actor.spaceId,
    threadId: target.threadId,
    messageId: input.messageId,
  });
  if (!prompt) return false;
  if (!prompt.computer) throw new ORPCError("CONFLICT", { message: COMPUTER_RESTART_GONE });
  if (prompt.computer.userId !== actor.userId)
    throw new ORPCError("FORBIDDEN", { message: COMPUTER_RESTART_FORBIDDEN });
  if (!prompt.open || input.runId !== prompt.computerId || input.dismiss || input.username)
    throw new ORPCError("CONFLICT", { message: COMPUTER_RESTART_GONE });
  if (input.answer !== COMPUTER_RESTART_ACTION && input.answer !== COMPUTER_KEEP_ACTION)
    throw new ORPCError("BAD_REQUEST", { message: "Choose one of the card's buttons" });
  const answered = await settleComputerRestartPrompt(deps.prisma, {
    spaceId: actor.spaceId,
    threadId: target.threadId,
    messageId: input.messageId,
    settle: { status: "answered", answer: input.answer },
  });
  if (!answered) throw new ORPCError("CONFLICT", { message: COMPUTER_RESTART_GONE });
  await deps.events.notify(answered.threadId, answered.seq).catch(() => undefined);
  if (input.answer !== COMPUTER_RESTART_ACTION) return true;

  let text = RESTART_DONE_TEXT;
  let outcome: "restarted" | "failed" = "restarted";
  try {
    const bot = await deps.prisma.bot.findFirst({
      where: { id: prompt.botId, spaceId: actor.spaceId, computerId: prompt.computerId },
      select: { id: true },
    });
    // The bot moved to another computer meanwhile: resetting it would hit the wrong one.
    if (!bot) throw new ORPCError("CONFLICT", { message: COMPUTER_RESTART_GONE });
    await restart(bot.id);
    await updateComputerHealth(deps.prisma, {
      computerId: prompt.computerId,
      spaceId: prompt.computer.spaceId,
      data: { unresponsiveCount: 0, restartMessageId: null, restartThreadId: null },
    });
  } catch (error) {
    outcome = "failed";
    text = isBusy(error) ? RESTART_BUSY_TEXT : RESTART_FAILED_TEXT;
    getLogger().error("computer restart from card", error);
  }
  try {
    const settled = await settleComputerRestartPrompt(deps.prisma, {
      spaceId: actor.spaceId,
      threadId: target.threadId,
      messageId: input.messageId,
      settle: { outcome },
    });
    if (settled) await deps.events.notify(settled.threadId, settled.seq).catch(() => undefined);
    const event = await postComputerNotice(
      deps.prisma,
      { botId: prompt.botId, threadId: target.threadId, spaceId: actor.spaceId },
      text,
    );
    await deps.events.notify(event.threadId, event.seq).catch(() => undefined);
  } catch (error) {
    getLogger().error("computer restart notice", error);
  }
  return true;
}
