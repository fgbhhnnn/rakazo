import { isRunWorking } from "./run-state.js";

type RosterChat = { status?: string | null; updatedAt?: string | null };

// Above any real timestamp, so working chats lead and keep their own newest-first order.
const WORKING_BOOST = 1e15;

/**
 * Sort key for the chat list: a bot whose turn or background task is working leads, then the
 * chat that last moved (roster `updatedAt` is the newest message's time). Higher sorts first.
 */
export function rosterRecency(chat: RosterChat): number {
  const at = chat.updatedAt ? Date.parse(chat.updatedAt) : Number.NaN;
  const time = Number.isFinite(at) ? at : 0;
  return isRunWorking(chat.status) ? WORKING_BOOST + time : time;
}

/** Newest first; a stable sort, so equal keys keep the server's order. */
export function sortByRosterRecency<T>(items: readonly T[], chatOf: (item: T) => RosterChat): T[] {
  return items
    .map((item, index) => ({ item, index, key: rosterRecency(chatOf(item)) }))
    .sort((a, b) => b.key - a.key || a.index - b.index)
    .map(({ item }) => item);
}
