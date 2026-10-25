import type { PrismaClient } from "@rakazo/db";
import { redactSensitiveText } from "@rakazo/logging";
import { formatInstantForUser } from "./current-time.js";
import { WORKER_PROGRESS_NOTICE } from "./worker-progress.js";

/**
 * What a running background worker has been doing, for background_task_status: its last tool
 * calls (name, the activity line it showed, outcome, duration), the call still open and for how
 * long, when it last did anything, and its own latest progress note (report_progress). Built from
 * the events the run already writes; nothing new is recorded for it.
 */

/** Tool calls listed in recent_activity. */
export const WORKER_ACTIVITY_LIMIT = 6;
/** Events read per worker run: enough for the last calls with their activity lines. */
const WORKER_ACTIVITY_EVENT_WINDOW = 240;
const SUMMARY_MAX_CHARS = 160;

export interface WorkerActivityCall {
  tool: string;
  summary?: string;
  outcome: string;
  duration_s?: number;
  at: string;
}

export interface WorkerCurrentCall {
  tool: string;
  summary?: string;
  started_at: string;
  running_for_s: number;
}

export interface WorkerActivity {
  recent_activity: WorkerActivityCall[];
  current_call?: WorkerCurrentCall;
  last_event_at?: string;
  progress_note?: { text: string; at: string };
}

interface ActivityEvent {
  seq: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}

interface OpenCall {
  executionId: string;
  tool: string;
  summary?: string;
  startedAt: Date;
  outcome?: string;
  durationMs?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** One short line, secrets and emails masked, capped. */
export function activitySummary(text: string, max = SUMMARY_MAX_CHARS): string | undefined {
  const line = redactSensitiveText(text.replace(/\s+/g, " ").trim());
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Pairs tool calls with the activity line shown just before each (oldest first) and with their
 * completion. Pure: the events of one run, in any order.
 */
export function summarizeWorkerActivity(
  events: readonly ActivityEvent[],
  options: { now: Date; timeZone?: string; limit?: number },
): Omit<WorkerActivity, "progress_note" | "last_event_at"> {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const calls: OpenCall[] = [];
  const byExecution = new Map<string, OpenCall>();
  // Activity lines not yet claimed by a call; parallel calls announce theirs first, in order.
  let pendingLines: string[] = [];
  for (const event of ordered) {
    const payload = record(event.payload);
    if (event.type === "thread.progress") {
      if (payload.activity !== true || payload.notice !== undefined) continue;
      const summary = typeof payload.text === "string" ? activitySummary(payload.text) : undefined;
      if (summary) pendingLines.push(summary);
      continue;
    }
    const executionId = typeof payload.executionId === "string" ? payload.executionId : undefined;
    const tool = typeof payload.name === "string" ? payload.name : undefined;
    if (!executionId || !tool) continue;
    if (event.type === "agent.tool.called") {
      if (byExecution.has(executionId)) continue;
      const call: OpenCall = {
        executionId,
        tool,
        summary: pendingLines.shift(),
        startedAt: event.createdAt,
      };
      calls.push(call);
      byExecution.set(executionId, call);
    } else if (event.type === "agent.tool.completed") {
      const call = byExecution.get(executionId);
      if (call && call.outcome === undefined) {
        call.outcome = typeof payload.outcome === "string" ? payload.outcome : "completed";
        call.durationMs =
          typeof payload.durationMs === "number"
            ? payload.durationMs
            : event.createdAt.getTime() - call.startedAt.getTime();
      }
      // Every call announces its line just before it starts, so lines left over once nothing
      // is running belong to no call (e.g. a call that was skipped, or one before the window).
      if (calls.every((entry) => entry.outcome !== undefined)) pendingLines = [];
    }
  }
  const limit = options.limit ?? WORKER_ACTIVITY_LIMIT;
  const open = calls.filter((call) => call.outcome === undefined);
  const current = open.at(-1);
  return {
    recent_activity: calls.slice(-limit).map((call) => ({
      tool: call.tool,
      ...(call.summary ? { summary: call.summary } : {}),
      outcome: call.outcome ?? "running",
      ...(call.durationMs !== undefined
        ? { duration_s: Math.max(0, Math.round(call.durationMs / 1000)) }
        : {}),
      at: formatInstantForUser(call.startedAt, options.timeZone),
    })),
    ...(current
      ? {
          current_call: {
            tool: current.tool,
            ...(current.summary ? { summary: current.summary } : {}),
            started_at: formatInstantForUser(current.startedAt, options.timeZone),
            running_for_s: Math.max(
              0,
              Math.round((options.now.getTime() - current.startedAt.getTime()) / 1000),
            ),
          },
        }
      : {}),
  };
}

/** The worker's latest report_progress note, if any. */
export async function latestWorkerProgressNote(
  prisma: Pick<PrismaClient, "event">,
  runId: string,
): Promise<{ text: string; createdAt: Date } | undefined> {
  const note = await prisma.event.findFirst({
    where: {
      runId,
      type: "thread.progress",
      payload: { path: ["notice"], equals: WORKER_PROGRESS_NOTICE },
    },
    orderBy: { seq: "desc" },
    select: { payload: true, createdAt: true },
  });
  const text = record(note?.payload).note;
  return note && typeof text === "string" && text ? { text, createdAt: note.createdAt } : undefined;
}

/** Recent activity of one worker run, read from its events. */
export async function workerActivity(
  prisma: Pick<PrismaClient, "event">,
  runId: string,
  options: { now?: Date; timeZone?: string; limit?: number } = {},
): Promise<WorkerActivity> {
  const now = options.now ?? new Date();
  const [events, last, note] = await Promise.all([
    prisma.event.findMany({
      where: {
        runId,
        type: { in: ["agent.tool.called", "agent.tool.completed", "thread.progress"] },
      },
      orderBy: { seq: "desc" },
      take: WORKER_ACTIVITY_EVENT_WINDOW,
      select: { seq: true, type: true, payload: true, createdAt: true },
    }),
    prisma.event.findFirst({
      where: { runId },
      orderBy: { seq: "desc" },
      select: { createdAt: true },
    }),
    latestWorkerProgressNote(prisma, runId),
  ]);
  return {
    ...summarizeWorkerActivity(events, { now, timeZone: options.timeZone, limit: options.limit }),
    ...(last ? { last_event_at: formatInstantForUser(last.createdAt, options.timeZone) } : {}),
    ...(note
      ? {
          progress_note: {
            text: note.text,
            at: formatInstantForUser(note.createdAt, options.timeZone),
          },
        }
      : {}),
  };
}

/** Told to the main bot with every background_task_status result. */
export const WORKER_ACTIVITY_NOTE =
  "For a running task, current_call is the tool its worker is in right now and for how long (running_for_s), recent_activity its last tool calls (outcome, duration_s), last_event_at when it last did anything, and last_progress/last_progress_at its own latest note. When the user asks where a task is at, answer from these: name the step and how long it has taken, say so plainly if a call has run long or nothing happened for a while, and do not guess beyond them.";

/** Status fields for a started task's worker run; last_progress only when it left a note. */
export async function workerActivityFields(
  prisma: Pick<PrismaClient, "event">,
  runId: string,
  timeZone?: string,
): Promise<Record<string, unknown>> {
  const activity = await workerActivity(prisma, runId, { timeZone });
  return {
    ...(activity.progress_note
      ? { last_progress: activity.progress_note.text, last_progress_at: activity.progress_note.at }
      : {}),
    ...(activity.current_call ? { current_call: activity.current_call } : {}),
    recent_activity: activity.recent_activity,
    ...(activity.last_event_at ? { last_event_at: activity.last_event_at } : {}),
  };
}
