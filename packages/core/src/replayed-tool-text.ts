const COPIED_TOOL_STEPS =
  /^[ \t]*\[tool calls this reply made\][ \t]*(?:\r?\n[ \t]*- [^\n]*)+\r?\n?/gim;
const LEADING_WORKER_BRIEF = /^[ \t]*\[to [^\]\r\n]+ · 后台任务\][^\r\n]*(?:\r?\n|$)/;

/** Removes replay formatting a bot copied into its reply instead of making tool calls. */
export function withoutCopiedToolSteps(text: string): string {
  const listAt = text.search(COPIED_TOOL_STEPS);
  const workerBrief = LEADING_WORKER_BRIEF.test(text);
  if (listAt < 0 && !workerBrief) return text;
  // A copied worker brief can span several lines before the copied step list starts.
  const reply = workerBrief
    ? listAt >= 0
      ? text.slice(listAt)
      : text.replace(LEADING_WORKER_BRIEF, "")
    : text;
  return reply.replace(COPIED_TOOL_STEPS, "").trim();
}
