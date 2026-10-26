import * as z from "zod";

/**
 * The background-task progress card: one message in the main chat that the server rewrites in
 * place while a bot's background tasks run. Built by server code from the task rows and the
 * workers' own events (never by asking the model). Clients show the run time live from
 * startedAt/finishedAt, so the card only changes when a task's state or latest step changes.
 */
export const TASK_PROGRESS_MAX_TASKS = 30;
export const TASK_PROGRESS_STEP_MAX_LENGTH = 160;

export const TaskProgressState = z.enum([
  "queued",
  "starting",
  "running",
  "continuing",
  "needs_user",
  "stuck",
  "done",
  "failed",
  "cancelled",
]);
export type TaskProgressState = z.infer<typeof TaskProgressState>;

export const TaskProgressEntrySchema = z.object({
  /** The task's #ref (its task_id). */
  ref: z.string().max(40),
  name: z.string().max(120),
  state: TaskProgressState,
  lane: z.enum(["computer", "think"]).optional(),
  /** The hidden worker carrying the task. Clients never open its thread from the card. */
  workerBotId: z.string().optional(),
  queuedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  /** Its latest step: the tool it is in, its own progress note, or why it stopped. */
  step: z.string().max(TASK_PROGRESS_STEP_MAX_LENGTH).optional(),
  /** Place in its lane's queue while queued. */
  position: z.number().int().positive().optional(),
  /** When the server first saw it stuck (no activity past the threshold). */
  stuckSince: z.string().optional(),
  /** Milestones already posted to the chat for this task, so each is said once. */
  notified: z.array(z.enum(["stuck", "failed"])).optional(),
});
export type TaskProgressEntry = z.infer<typeof TaskProgressEntrySchema>;

export const TaskProgressBlockSchema = z.object({
  kind: z.literal("task_progress"),
  /** The bot whose background tasks these are. */
  botId: z.string(),
  tasks: z.array(TaskProgressEntrySchema).max(TASK_PROGRESS_MAX_TASKS),
  updatedAt: z.string(),
  /** Every task on it ended; the card no longer changes and the next task opens a new one. */
  closed: z.literal(true).optional(),
});
export type TaskProgressBlock = z.infer<typeof TaskProgressBlockSchema>;

export const TASK_PROGRESS_ACTIVE_STATES: readonly TaskProgressState[] = [
  "queued",
  "starting",
  "running",
  "continuing",
  "needs_user",
  "stuck",
];

export function isTaskProgressActive(state: TaskProgressState): boolean {
  return TASK_PROGRESS_ACTIVE_STATES.includes(state);
}

/** Run time in whole seconds: queued tasks have none; running ones count up to now. */
export function taskProgressRunSeconds(entry: TaskProgressEntry, now: Date): number | undefined {
  if (!entry.startedAt) return undefined;
  const start = Date.parse(entry.startedAt);
  const end = entry.finishedAt ? Date.parse(entry.finishedAt) : now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, Math.round((end - start) / 1000));
}

/** "45s", "12m", "1h 05m". */
export function formatTaskRunTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Counts per state group, for the card header. */
export function taskProgressCounts(block: Pick<TaskProgressBlock, "tasks">) {
  const counts = { active: 0, done: 0, failed: 0, attention: 0 };
  for (const task of block.tasks) {
    if (task.state === "done") counts.done += 1;
    else if (task.state === "failed" || task.state === "cancelled") counts.failed += 1;
    else counts.active += 1;
    if (task.state === "needs_user" || task.state === "stuck") counts.attention += 1;
  }
  return counts;
}

/** One line for quotes and previews, e.g. "后台任务进度：2 个进行中 · 1 个完成". */
export function taskProgressHeadline(block: Pick<TaskProgressBlock, "tasks">): string {
  const counts = taskProgressCounts(block);
  const parts = [
    counts.active ? `${counts.active} 个进行中` : "",
    counts.done ? `${counts.done} 个完成` : "",
    counts.failed ? `${counts.failed} 个未完成` : "",
  ].filter(Boolean);
  return `后台任务进度${parts.length ? `：${parts.join(" · ")}` : ""}`;
}
