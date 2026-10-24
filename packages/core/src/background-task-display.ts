import { isBackgroundTaskCardBlock } from "./background-task-card.js";

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
 * Drops task cards from a transcript. A message left with no blocks goes too, so no empty bubble
 * or gap stays behind; text beside a card (and its #REF mentions) is kept. Returns the input when
 * nothing changes so memoized views stay stable.
 */
export function withoutBackgroundTaskCards<M extends { blocks: readonly unknown[] }>(
  messages: readonly M[],
): readonly M[] {
  if (!messages.some((message) => message.blocks.some(isBackgroundTaskStartCard))) return messages;
  return messages.flatMap((message) => {
    if (!message.blocks.some(isBackgroundTaskStartCard)) return [message];
    const blocks = message.blocks.filter((block) => !isBackgroundTaskStartCard(block));
    return blocks.length ? [{ ...message, blocks } as M] : [];
  });
}

/** Whether a bot has background work in flight: any running or queued task, never a count. */
export function backgroundTasksActive(tasks?: { running: number; queued: number } | null): boolean {
  return !!tasks && tasks.running + tasks.queued > 0;
}
