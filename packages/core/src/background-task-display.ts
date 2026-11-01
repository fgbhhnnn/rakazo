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
export function withoutBackgroundTaskCards<
  M extends {
    blocks: readonly unknown[];
    role?: string;
    id?: string;
    replyToMessageId?: string | null;
    replyQuote?: string | null;
    replyPreview?: { text?: string } | null;
  },
>(messages: readonly M[]): readonly M[] {
  const hiddenIds = new Set(
    messages.flatMap((message) =>
      // Only messages that disappear: a relay keeps its files, so replies to it still land.
      message.id && message.blocks.length && message.blocks.every(isHiddenTaskBlock)
        ? [message.id]
        : [],
    ),
  );
  const quotesHidden = (message: M) =>
    !!(
      (message.replyToMessageId && hiddenIds.has(message.replyToMessageId)) ||
      isBackgroundHandoffText(message.replyQuote) ||
      isBackgroundHandoffText(message.replyPreview?.text)
    );
  if (
    !messages.some((message) => message.blocks.some(isHiddenTaskBlock) || quotesHidden(message))
  ) {
    return messages;
  }
  return messages.flatMap((message) => {
    const hidden = message.blocks.some(isHiddenTaskBlock);
    const blocks = hidden
      ? message.blocks.filter((block) => !isHiddenTaskBlock(block))
      : message.blocks;
    if (!blocks.length) return [];
    const relayed = message.blocks.some(
      (block) =>
        isBackgroundWorkerReceipt(block) &&
        (block as { kind: string }).kind === "bot_message_received",
    );
    // A relay answers the bot's handoff to its worker, and a quote of a hidden handoff or
    // worker message ("↩ Bot: 【后台任务】…") points at nothing the chat shows: drop the quote.
    const dropQuote = relayed || quotesHidden(message);
    if (!hidden && !dropQuote) return [message];
    return [
      {
        ...message,
        ...(relayed ? { role: "bot" } : {}),
        blocks,
        ...(dropQuote
          ? { replyToMessageId: undefined, replyQuote: undefined, replyPreview: undefined }
          : {}),
      } as M,
    ];
  });
}

/** The text a bot hands a background worker opens with this (see background-tasks.ts). */
const BACKGROUND_HANDOFF_PREFIX = "【后台任务】";

function isBackgroundHandoffText(text: string | null | undefined): boolean {
  return !!text && text.trimStart().startsWith(BACKGROUND_HANDOFF_PREFIX);
}

/** Whether a bot has background work in flight: any running or queued task, never a count. */
export function backgroundTasksActive(tasks?: { running: number; queued: number } | null): boolean {
  return !!tasks && tasks.running + tasks.queued > 0;
}
