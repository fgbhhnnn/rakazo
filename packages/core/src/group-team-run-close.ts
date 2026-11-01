import { COMPLETE_TEAM_RUN_TOOL_NAME, teamRunSummaryText } from "./group-team-run.js";

/**
 * How a group team run was closed by its leader: finished, or stopped because the user asked.
 * A stopped run never reads as done ("✅ 团队任务完成"), and its row records "stopped".
 */
export type TeamRunCloseOutcome = "completed" | "stopped";

export const TEAM_RUN_STOPPED_HEADER = "⏹ 团队任务已停止";

/** The outcome a complete_team_run call asked for; anything but "stopped" completes. */
export function teamRunCloseOutcome(value: unknown): TeamRunCloseOutcome {
  return typeof value === "string" && value.trim().toLowerCase() === "stopped"
    ? "stopped"
    : "completed";
}

function list(label: string, items: readonly string[]): string[] {
  const clean = items.map((item) => item.trim()).filter(Boolean);
  return clean.length ? [`${label}：`, ...clean.map((item) => `- ${item}`)] : [];
}

/** The closing message posted to the user when the leader closes the run. */
export function teamRunClosingText(input: {
  outcome: TeamRunCloseOutcome;
  summary: string;
  deliverables?: readonly string[];
  openIssues?: readonly string[];
}): string {
  if (input.outcome === "completed") return teamRunSummaryText(input);
  return [
    TEAM_RUN_STOPPED_HEADER,
    input.summary.trim(),
    ...list("已完成的部分", input.deliverables ?? []),
    ...list("未完成", input.openIssues ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The leader's prompt line when its new request arrived while an earlier team task in the group
 * was still running: that task is already stopped in code; a pure "stop" needs no new work.
 */
export function teamRunSupersededNote(previousGoal: string): string {
  const goal = previousGoal.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  return [
    `The user's message arrived while an earlier team task in this group was still running${goal ? ` ("${goal}")` : ""}. That task has been stopped and nobody continues it.`,
    `If the user only wants to stop, hand nothing on: confirm briefly, or call ${COMPLETE_TEAM_RUN_TOOL_NAME} with outcome "stopped" and what was and was not done. Never report a stopped task as completed.`,
  ].join(" ");
}
