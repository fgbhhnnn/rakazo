/**
 * A background task's card ("后台任务：… #REF", a child_bot block) belongs in the user's
 * transcript whichever run posted it. A queued task often starts inside the dispatcher run woken
 * by another task's result (a bot_message run), whose other chatter is folded or hidden; the
 * card must not go with it.
 */
export function isBackgroundTaskCardBlock(block: unknown): boolean {
  return !!block && typeof block === "object" && "kind" in block && block.kind === "child_bot";
}
