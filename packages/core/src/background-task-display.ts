import { isBackgroundTaskCardBlock } from "./background-task-card.js";
import { isBackgroundWorkerName } from "./worker-names.js";

/**
 * Client-side presentation of background tasks. The backend still posts each task's card
 * ("后台任务：<title> #<REF>") so history keeps it; chats hide it and show one neutral
 * "coordinating" line instead of a count. Revert by dropping the two call sites.
 */
const TASK_CARD_NAME = /^后台任务：.* #[A-Za-z0-9]+$/u;

/** A started background task's card. create_bot cards share the child_bot kind and stay visible. */
export function isBackgroundTaskStartCard(block: unknown): boolean {
  if (!isBackgroundTaskCardBlock(block)) return false;
  const name = (block as { name?: unknown }).name;
  return typeof name === "string" && TASK_CARD_NAME.test(name);
}

/**
 * A "Messaged <worker>" / "Message from <worker>" receipt for a hidden background worker. The
 * main chat shows no such attribution line: workers are never opened from it, and the task's
 * progress card already says what runs.
 */
export function isBackgroundWorkerReceipt(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const { kind, toBotName, fromBotName } = block as {
    kind?: unknown;
    toBotName?: unknown;
    fromBotName?: unknown;
  };
  const peer =
    kind === "bot_message_sent" ? toBotName : kind === "bot_message_received" ? fromBotName : null;
  return typeof peer === "string" && isBackgroundWorkerName(peer);
}

function isHiddenTaskBlock(block: unknown): boolean {
  return isBackgroundTaskStartCard(block) || isBackgroundWorkerReceipt(block);
}

/**
 * Drops task cards and hidden workers' receipts from a transcript. A message left with no blocks
 * goes too, so no empty bubble or gap stays behind; text beside a card (and its #REF mentions) is
 * kept. A worker relay's files stay, shown as the bot's: the relay is the bot handing them over.
 * Returns the input when nothing changes so memoized views stay stable.
 */
export function withoutBackgroundTaskCards<M extends { blocks: readonly unknown[]; role?: string }>(
  messages: readonly M[],
): readonly M[] {
  if (!messages.some((message) => message.blocks.some(isHiddenTaskBlock))) return messages;
  return messages.flatMap((message) => {
    if (!message.blocks.some(isHiddenTaskBlock)) return [message];
    const blocks = message.blocks.filter((block) => !isHiddenTaskBlock(block));
    if (!blocks.length) return [];
    const relayed = message.blocks.some(
      (block) =>
        isBackgroundWorkerReceipt(block) &&
        (block as { kind: string }).kind === "bot_message_received",
    );
    return [(relayed ? { ...message, role: "bot", blocks } : { ...message, blocks }) as M];
  });
}

/** Whether a bot has background work in flight: any running or queued task, never a count. */
export function backgroundTasksActive(tasks?: { running: number; queued: number } | null): boolean {
  return !!tasks && tasks.running + tasks.queued > 0;
}
