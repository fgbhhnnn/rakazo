import type { MessageBlock } from "@rakazo/contracts";
import type { MessageAuthorship } from "@rakazo/core";
import { isHumanAuthoredMessage, TEAM_RUN_STOPPED_HEADER } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { endTeamRunAndCancel } from "./group-team-run-stop.js";
import { findHumanAuthoredMessage } from "./human-message-query.js";

const DECORATION = /[,.!?:;。、~…\p{Extended_Pictographic}\p{Emoji_Modifier}]+|\uFE0F|\u200D/gu;
const CHINESE_STOP =
  /^(?:(?:请|麻烦|劳烦|拜托)(?:你|大家|你们)?)?(?:大家|你们|所有人|全体)?(?:能不能|能否|可以)?(?:现在|赶紧|立即|马上)?先?(?:都|全部|统统)?(?:停(?:下来|下|一下|一停)?|停止(?:任务|工作)?|暂停(?:一下|任务|工作)?|(?:别|不用)(?:再)?(?:做|继续)(?:了)?|取消(?:任务|工作)?)(?:吧|了|啊|哈|呀|啦|哦|吗)*(?:谢谢(?:你|大家)?|感谢)?$/u;
const ENGLISH_STOP =
  /^(?:please\s+|(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:(?:everyone|all)\s+)?(?:stop(?:\s+(?:it|now|everything|the task))?|cancel(?:\s+(?:it|the task))?|abort(?:\s+the task)?|halt|hold on)(?:\s+(?:for now|please|thanks|thank you))?$/u;

/** A bounded command grammar: mentions/decorations are allowed, extra instructions are not. */
export function isStopIntent(text: string): boolean {
  if (text.length > 160) return false;
  const command = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/@[^\s@,.!?:;。、~…\p{Extended_Pictographic}]+/gu, " ")
    .replace(DECORATION, " ")
    .trim();
  if (!command || command.length > 80) return false;
  return (
    ENGLISH_STOP.test(command.replace(/\s+/gu, " ")) ||
    CHINESE_STOP.test(command.replace(/\s+/gu, ""))
  );
}

/**
 * Called after saving a group message, with the thread lock held, before answering/steering
 * or waking any bot. The cancelled receipt preserves send retries without a model turn.
 */
export async function consumeGroupTeamRunStop(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    groupId: string;
    message: MessageAuthorship & { id: string; threadId: string; seq: number; createdAt: Date };
    eventPayload?: Record<string, unknown>;
  },
) {
  const { message, spaceId, groupId } = input;
  if (!isHumanAuthoredMessage(message) || !Array.isArray(message.blocks)) return undefined;
  const text = (message.blocks as MessageBlock[])
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("\n");
  if (!isStopIntent(text)) return undefined;

  const active = await tx.groupTeamRun.findMany({
    where: {
      threadId: message.threadId,
      groupId,
      status: "active",
    },
    orderBy: { createdAt: "desc" },
  });
  let owner: { leaderBotId: string; userId: string } | undefined = active[0];
  if (!owner) {
    // Consecutive stops of an already consumed request stay silent. With no prior consumed
    // stop (or after a new human instruction), normal group routing remains unchanged.
    const previous = await findHumanAuthoredMessage(tx, {
      threadId: message.threadId,
      seq: { lt: message.seq },
    });
    if (!previous) return undefined;
    const receipt = await tx.run.findFirst({
      where: {
        threadId: message.threadId,
        sourceMessageId: previous.id,
        clientNonce: `team-stop:${previous.id}`,
        status: "cancelled",
      },
    });
    if (!receipt) return undefined;
    owner = { leaderBotId: receipt.botId, userId: receipt.userId };
  }
  for (const team of active) {
    await endTeamRunAndCancel(tx, team.id, "stopped", "leader_stopped");
  }
  const task = await tx.task.create({
    data: {
      spaceId,
      userId: owner.userId,
      threadId: message.threadId,
      botId: owner.leaderBotId,
      prompt: "",
      status: "cancelled",
    },
  });
  const receipt = await tx.run.create({
    data: {
      spaceId,
      userId: owner.userId,
      threadId: message.threadId,
      botId: owner.leaderBotId,
      taskId: task.id,
      sourceMessageId: message.id,
      trigger: "user",
      status: "cancelled",
      completedAt: new Date(),
      clientNonce: `team-stop:${message.id}`,
    },
  });
  await tx.message.update({ where: { id: message.id }, data: { runId: receipt.id } });
  let event = await appendEventInTransaction(tx, {
    spaceId,
    threadId: message.threadId,
    botId: owner.leaderBotId,
    type: "thread.message.created",
    payload: {
      ...input.eventPayload,
      messageId: message.id,
      seq: message.seq,
      role: "user",
      blocks: message.blocks,
      runIds: [receipt.id],
    },
  });
  if (active.length) {
    const blocks = [{ kind: "text" as const, text: TEAM_RUN_STOPPED_HEADER }];
    const notice = await createThreadMessageInTransaction(tx, {
      threadId: message.threadId,
      role: "bot",
      botId: owner.leaderBotId,
      blocks,
      clientNonce: `team-complete:${active[0]!.id}`,
    });
    event = await appendEventInTransaction(tx, {
      spaceId,
      threadId: message.threadId,
      botId: owner.leaderBotId,
      type: "thread.message.created",
      payload: { messageId: notice.id, role: "bot", blocks },
    });
  }
  await touchGroupUpdatedAt(tx, groupId);
  return { message, runs: [receipt], eventSeq: event.seq };
}
