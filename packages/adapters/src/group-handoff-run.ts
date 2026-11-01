import { MessageBlock } from "@rakazo/contracts";
import { isHumanAuthoredMessage } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { holdWhileBusy } from "./group-held-runs.js";
import { isVisibleGroupReply, visibleGroupReplies } from "./group-visible-reply.js";

type SourceMessage = { id: string; role: string; botId: string | null; blocks: unknown };
type SourceRun = { spaceId: string; threadId: string; userId: string };

/** A handoff repeating this turn's visible text needs only its routing marker. */
export async function groupHandoffVisibleText(
  tx: Prisma.TransactionClient,
  run: SourceRun & { id: string; botId: string },
  text: string,
): Promise<string> {
  return isVisibleGroupReply(text, await visibleGroupReplies(tx, run)) ? "" : text;
}

/** Hidden display text still compares against the full brief saved in the handoff receipt. */
export function handoffReceiptBlocks(blocks: unknown, payload: unknown): unknown {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("brief" in payload) ||
    typeof payload.brief !== "string"
  )
    return blocks;
  const brief = payload.brief;
  const parsed = MessageBlock.array().safeParse(blocks);
  return parsed.success
    ? parsed.data.map((block) => (block.kind === "handoff" ? { ...block, text: brief } : block))
    : blocks;
}

/** Called under the group/thread locks: a human mention and a handoff share one target turn. */
export async function humanStartedHandoffRun(
  tx: Prisma.TransactionClient,
  run: SourceRun,
  source: SourceMessage | null,
  targetId: string | undefined,
  recordedRunId?: string,
): Promise<{ id: string; botId: string } | null> {
  if (!targetId || !source?.id || !isHumanAuthoredMessage(source)) return null;
  return tx.run.findFirst({
    where: {
      spaceId: run.spaceId,
      threadId: run.threadId,
      userId: run.userId,
      botId: targetId,
      sourceMessageId: source.id,
      trigger: "user",
      // Once recorded, a replay still refers to that run even if it subsequently stopped.
      ...(recordedRunId ? { id: recordedRunId } : { status: { notIn: ["cancelled", "failed"] } }),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, botId: true },
  });
}

/** The receipt pins the selected mention attempt; retries must not switch to an older one. */
export function handoffTargetRunId(payload: unknown): string | undefined {
  return payload &&
    typeof payload === "object" &&
    "targetRunId" in payload &&
    typeof payload.targetRunId === "string"
    ? payload.targetRunId
    : undefined;
}

export async function createGroupHandoffRun(
  tx: Prisma.TransactionClient,
  run: SourceRun,
  input: {
    threadId: string;
    botId: string;
    messageId: string;
    text: string;
    source: SourceMessage | null;
    inGroup: boolean;
    holdWhileTargetBusy?: boolean;
  },
): Promise<{ id: string; held: boolean; reused: boolean }> {
  const existing = input.inGroup
    ? await humanStartedHandoffRun(tx, run, input.source, input.botId)
    : null;
  if (existing) return { id: existing.id, held: false, reused: true };
  const task = await tx.task.create({
    data: {
      spaceId: run.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId: run.userId,
      prompt: input.text,
      status: "queued",
    },
  });
  const heldUntil = input.holdWhileTargetBusy
    ? await holdWhileBusy(tx, { threadId: input.threadId, botId: input.botId })
    : undefined;
  const next = await tx.run.create({
    data: {
      spaceId: run.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      taskId: task.id,
      userId: run.userId,
      status: "queued",
      trigger: "follow_up",
      sourceMessageId: input.messageId,
      ...(heldUntil ? { wakeAt: heldUntil } : {}),
    },
  });
  return { id: next.id, held: Boolean(heldUntil), reused: false };
}
