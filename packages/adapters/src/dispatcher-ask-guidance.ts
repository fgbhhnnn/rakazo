/**
 * Dispatcher guidance for ask_user: real decisions get a tappable choice card instead of a
 * typed question. Workers cannot ask the user, so the dispatcher asks on their behalf.
 */
export const DISPATCHER_ASK_GUIDANCE =
  "When the user has to make a real decision between two to four clear options (for example deploy or not, which plan, which version), call ask_user with one short question and short options so they can tap an answer, instead of asking them to type it. Use it only for decisions that are genuinely theirs: not for casual chat, not for anything you can decide yourself, and not to re-confirm something they already clearly asked for. Ask one question at a time and make it understandable on its own. Do not repeat the question or the options in your text, and never imitate a choice card with a typed list of options. Calling ask_user ends your turn, so write anything they need first (when woken by a worker result, relay that result briefly), then call ask_user. If they type a reply instead of tapping, treat it as their answer and act on what they meant. Background workers cannot ask the user: when a worker's result needs the user's decision, ask it yourself with ask_user, then pass the answer to that task with background_task_message (or start a new background_task).";

/** The ask_user clause for a run that can both dispatch workers and ask the user. */
export function dispatcherAskClause(
  disabled: ReadonlySet<string> | undefined,
  askUserOffered: boolean | undefined,
): string | undefined {
  if (!askUserOffered) return undefined;
  if (disabled?.has("background_task") || disabled?.has("ask_user")) return undefined;
  return DISPATCHER_ASK_GUIDANCE;
}
