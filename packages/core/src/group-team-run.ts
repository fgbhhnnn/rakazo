/**
 * A group "team run": one human request that the group's team carries to completion on its
 * own. The leader (the first visible member) plans and hands stages out; a member that
 * finishes a stage without handing it on returns it to the leader (the system does that when
 * the member does not); the leader closes the run with complete_team_run, which posts a final
 * summary for the user. Budgets, the loop guard and "a human message always wins" are enforced
 * in code, not left to the model.
 */

export const COMPLETE_TEAM_RUN_TOOL_NAME = "complete_team_run";

export const TEAM_RUN_DEFAULT_MAX_HOPS = 16;
export const TEAM_RUN_DEFAULT_MAX_MINUTES = 60;
/** The leader may send the same member another stage this many times in a row, then it stops. */
export const TEAM_RUN_MAX_LEADER_REPEATS = 2;
/**
 * When the member returned a new result each time, the leader's sends back to it are review
 * rounds (fix this, then that), not a loop: this many of them are allowed before the run pauses.
 */
export const TEAM_RUN_MAX_REVISION_ROUNDS = 3;

export type TeamRunStatus =
  | "active"
  | "completed"
  | "paused"
  | "stopped"
  | "answered"
  | "superseded";

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function teamRunBudget(env: Record<string, string | undefined> = process.env): {
  maxHops: number;
  maxMinutes: number;
} {
  return {
    maxHops: positiveInt(env.RAKAZO_GROUP_TEAM_RUN_MAX_HOPS, TEAM_RUN_DEFAULT_MAX_HOPS),
    maxMinutes: positiveInt(env.RAKAZO_GROUP_TEAM_RUN_MAX_MINUTES, TEAM_RUN_DEFAULT_MAX_MINUTES),
  };
}

/** Whether one more handoff fits the run's budget. */
export function teamRunWithinBudget(
  run: { hops: number; createdAt: Date },
  now: Date,
  budget: { maxHops: number; maxMinutes: number },
): boolean {
  return (
    run.hops < budget.maxHops &&
    now.getTime() - run.createdAt.getTime() <= budget.maxMinutes * 60_000
  );
}

/**
 * The leader's streak after it hands a stage to `targetId`, and whether that is one repeat
 * too many: the same member again and again with nothing else in between is a loop. With
 * `revision` (the member returned a new result since the leader's last send to it), the send
 * is a review round instead, and up to TEAM_RUN_MAX_REVISION_ROUNDS of those are allowed.
 */
export function nextLeaderStreak(
  run: { lastLeaderTargetId: string | null; leaderTargetStreak: number },
  targetId: string,
  options: { revision?: boolean } = {},
): { streak: number; loop: boolean } {
  const streak = run.lastLeaderTargetId === targetId ? run.leaderTargetStreak + 1 : 1;
  const repeats = options.revision ? TEAM_RUN_MAX_REVISION_ROUNDS : TEAM_RUN_MAX_LEADER_REPEATS;
  return { streak, loop: streak > repeats + 1 };
}

/** Visible text of the system's hand-back card after a member finishes a stage. */
export function teamRunReturnText(memberName: string, leaderName: string, reply: string): string {
  const head = `${memberName} 已完成，交回 ${leaderName}。`;
  const body = reply.trim();
  return body ? `${head}\n\n${memberName} 的结果：\n${body}` : head;
}

/** Visible line, and the leader's prompt, when the leader stopped without closing the run. */
export function teamRunNudgeText(leaderName: string): string {
  return `（系统提醒 ${leaderName}：团队任务还没结束。请把下一阶段交给合适的成员，或在全部完成后调用 ${COMPLETE_TEAM_RUN_TOOL_NAME} 收尾。）`;
}

export const TEAM_RUN_PAUSED_NOTICE = "团队任务已暂停，等你回复。";

export const TEAM_RUN_LOOP_NOTICE = "团队任务在同一阶段反复往返，已暂停，等你回复。";

function list(label: string, items: readonly string[]): string[] {
  const clean = items.map((item) => item.trim()).filter(Boolean);
  return clean.length ? [`${label}：`, ...clean.map((item) => `- ${item}`)] : [];
}

/** The final summary posted to the user when the leader closes the run. */
export function teamRunSummaryText(input: {
  summary: string;
  deliverables?: readonly string[];
  openIssues?: readonly string[];
}): string {
  return [
    "✅ 团队任务完成",
    input.summary.trim(),
    ...list("交付物", input.deliverables ?? []),
    ...list("待跟进", input.openIssues ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

export type TeamRunMember = { name: string; title?: string | null; description?: string | null };

function rosterLine(member: TeamRunMember): string {
  const clean = (value: string | null | undefined) =>
    (value ?? "").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  const about = clean(member.description) || clean(member.title);
  return about ? `- ${clean(member.name)}: ${about}` : `- ${clean(member.name)}`;
}

/**
 * The prompt section for a bot in an active team run. Generic on purpose: what each member does
 * comes only from its own name and description, so the same run works for any kind of team.
 */
export function renderTeamRunContext(input: {
  role: "leader" | "member";
  leaderName: string;
  goal: string;
  /** The group's members, leader included, in roster order. */
  members: readonly TeamRunMember[];
}): string {
  const goal = input.goal.replace(/[<>]/g, " ").trim().slice(0, 1_000);
  const roster = [
    "Team members (what each does comes from its own description):",
    ...input.members.map(rosterLine),
  ];
  if (input.role === "leader") {
    return [
      "<team_run>",
      `You lead this group's team task. The user's request: ${goal}`,
      ...roster,
      "Run it to completion with the team, one stage at a time:",
      "- Plan the stages from what the request needs and what each member does, then hand the first stage to the best-suited member with handoff_to_bot and a short brief (objective, deliverable, acceptance criteria, links to earlier results). Do your own part yourself when it is yours.",
      `- When a member finishes, the system returns the result to you. Check it, then hand the next stage on, or send it back with exactly what to fix (at most ${TEAM_RUN_MAX_REVISION_ROUNDS} review rounds per member). When a member only needs information another member has, relay it in one handoff or let them ask each other.`,
      "- Before you close the task, check the result against the acceptance criteria. If a member's description fits reviewing or checking work, you may hand it to them to verify first.",
      `- When everything is done, call ${COMPLETE_TEAM_RUN_TOOL_NAME} with a summary for the user, the deliverables and any open issues. Saying it is done does not close it.`,
      `- If the user asks to stop or cancel the task, hand nothing on and call ${COMPLETE_TEAM_RUN_TOOL_NAME} with outcome "stopped"; a stopped task is never reported as completed.`,
      "- Ask the user only when you are truly blocked. Teammates cannot approve anything on the user's behalf.",
      "</team_run>",
    ].join("\n");
  }
  return [
    "<team_run>",
    `You are working on one stage of a team task led by ${input.leaderName}. The user's request: ${goal}`,
    ...roster,
    `Do your stage and post its result here. If the next stage clearly belongs to another member, hand it to them with handoff_to_bot; otherwise just finish, and the system returns your result to ${input.leaderName}. Do not close the team task yourself.`,
    "</team_run>",
  ].join("\n");
}
