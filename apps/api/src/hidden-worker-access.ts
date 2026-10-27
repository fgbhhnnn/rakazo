import { IsolationError, isHiddenBot } from "@rakazo/db";

/**
 * Hidden background workers are never opened as chats: their work reaches the user through the
 * dispatcher's relay, and a worker chat with a composer let people message a worker directly.
 * Every bot chat target (bootstrap, bots/get, threads/*) refuses one like a missing bot, so a
 * stale link or a typed URL falls back to the first chat.
 */
export function assertOpenableBot<B extends { spawnKey?: string | null }>(bot: B): B {
  if (isHiddenBot(bot)) throw new IsolationError();
  return bot;
}
