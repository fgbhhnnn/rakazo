import {
  isTaskProgressActive,
  type MessageBlock,
  TASK_PROGRESS_MAX_TASKS,
  TASK_PROGRESS_STEP_MAX_LENGTH,
  type TaskProgressBlock,
  TaskProgressBlockSchema,
  type TaskProgressEntry,
  type TaskProgressState,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  type PrismaClient,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { laneOfTask, laneQueueOrder } from "./background-task-lanes.js";
import { ACTIVE_TASK_STATUSES } from "./background-task-rows.js";
import type { ExecutorDeps } from "./executor.js";
import { teamTaskProgressIsCurrent } from "./group-team-run-stop.js";
import { activitySummary, summarizeWorkerActivity } from "./worker-activity.js";
import { isIncompleteContinuing } from "./worker-incomplete-result.js";
import { workerPending } from "./worker-needs-user.js";
import { WORKER_PROGRESS_NOTICE } from "./worker-progress.js";

/**
 * The background-task progress card (see TaskProgressBlockSchema). While a bot has background
 * tasks, its chat holds one card listing each task's state, run time and latest step. Server code
 * rebuilds it from the task rows and the workers' own events: on every job-reconciler pass (30 s)
 * and right after a task is started, steered, cancelled or delivers its result. It is rewritten in
 * place (thread.message.updated) only when something on it changed; the model is never asked.
 *
 * Milestones it says out loud, once each, as a short bot message in the same chat:
 * - a task has had no activity for the stuck threshold (default 10 min);
 * - a task failed without its result reaching the main bot (e.g. the hand-off never completed),
 *   so the main bot will not report it itself.
 * Finished and failed results that do reach the main bot are still reported by the main bot, and a
 * worker's approval card is already mirrored into the chat, so neither is repeated here.
 */

type Deps = Pick<ExecutorDeps, "prisma" | "events">;

const DEFAULT_STUCK_MINUTES = 10;
/** Finished tasks stay candidates this long, so their card gets its final state. */
const RECENT_FINISHED_MS = 15 * 60_000;
/** Events read per running worker: enough for its open call and latest note. */
const EVENT_WINDOW = 120;
const CARD_KIND = { array_contains: [{ kind: "task_progress" }] };

/** Quiet time after which a running task counts as stuck. */
export const TASK_STUCK_MS = DEFAULT_STUCK_MINUTES * 60_000;

function clip(text: string | undefined, max = TASK_PROGRESS_STEP_MAX_LENGTH): string | undefined {
  const line = text ? activitySummary(text, max) : undefined;
  return line || undefined;
}

type TaskRow = {
  id: string;
  ref: string | null;
  name: string;
  status: string;
  args: unknown;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  workerBotId: string | null;
  workerRunId: string | null;
};

type WorkerRunInfo = {
  status: string;
  error: string | null;
  completedAt: Date | null;
  botOutcomeReturnedAt: Date | null;
};

type ActivityEvent = { seq: number; type: string; payload: unknown; createdAt: Date };

/** What the server knows about one task right now, read from the database. */
export interface TaskSnapshot {
  row: TaskRow;
  run?: WorkerRunInfo | null;
  /** The worker's last message blocks (for a pending ask). */
  lastBlocks?: unknown;
  /** The worker run's recent events, newest first or in any order. */
  events?: readonly ActivityEvent[];
  /** When the worker run last wrote any event. */
  lastEventAt?: Date;
  position?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The worker's latest step: the call it is in, else whichever came last of its note and its last call. */
export function latestStep(events: readonly ActivityEvent[], now: Date): string | undefined {
  const summary = summarizeWorkerActivity(events, { now, timeZone: "UTC", limit: 1 });
  if (summary.current_call) return clip(summary.current_call.summary ?? summary.current_call.tool);
  const ordered = [...events].sort((a, b) => b.seq - a.seq);
  const newest = ordered.find((event) => {
    const payload = record(event.payload);
    return (
      event.type === "agent.tool.called" ||
      (event.type === "thread.progress" && payload.notice === WORKER_PROGRESS_NOTICE)
    );
  });
  if (newest?.type === "thread.progress") {
    const note = record(newest.payload).note;
    if (typeof note === "string") return clip(note);
  }
  const last = summary.recent_activity.at(-1);
  return last ? clip(last.summary ?? last.tool) : undefined;
}

function iso(date: Date | null | undefined): string | undefined {
  return date ? date.toISOString() : undefined;
}

/**
 * One card row from a task snapshot. Pure. prev is the same task's row on the card so far; its
 * stuck bookkeeping carries over.
 */
export function taskProgressEntry(
  snapshot: TaskSnapshot,
  options: { now: Date; stuckMs: number; prev?: TaskProgressEntry },
): TaskProgressEntry {
  const { row, run } = snapshot;
  const { now, prev } = options;
  const runActive = run ? ACTIVE_RUN_STATUSES.includes(run.status as never) : false;
  let state: TaskProgressState;
  let step: string | undefined;
  let stuckSince: string | undefined;
  if (row.status === "queued") state = "queued";
  else if (row.status === "claiming") state = "starting";
  else if (row.status === "completed") state = "done";
  else if (row.status === "cancelled") state = "cancelled";
  else if (row.status === "failed") {
    state = "failed";
    step = clip(row.error ?? run?.error ?? undefined);
  } else {
    // started
    const pending =
      run?.status === "waiting_input" || run?.status === "waiting_takeover"
        ? (workerPending(
            run.status === "waiting_takeover" ? "takeover" : run.status,
            snapshot.lastBlocks,
          ) ?? { kind: "question" as const, text: "" })
        : undefined;
    if (pending) {
      state = "needs_user";
      step = clip(pending.text) ?? (pending.kind === "takeover" ? "等你操作电脑" : "等你确认");
    } else if (isIncompleteContinuing(row.args)) {
      // Auto-continued after an incomplete final; not done until a genuine result lands.
      state = "continuing";
      step = snapshot.events?.length ? latestStep(snapshot.events, now) : undefined;
    } else if (!runActive && run) {
      // The worker ended; its result is on its way to the main bot.
      state = "running";
      step = "收尾中";
    } else {
      state = "running";
      step = snapshot.events?.length ? latestStep(snapshot.events, now) : undefined;
      const lastActive = Math.max(
        snapshot.lastEventAt?.getTime() ?? 0,
        row.startedAt?.getTime() ?? row.createdAt.getTime(),
      );
      if (runActive && now.getTime() - lastActive >= options.stuckMs) {
        state = "stuck";
        stuckSince = prev?.stuckSince ?? new Date(lastActive + options.stuckMs).toISOString();
      }
    }
  }
  const finishedAt =
    state === "done" || state === "failed" || state === "cancelled"
      ? (row.finishedAt ?? run?.completedAt ?? undefined)
      : undefined;
  // A task that recovered from being stuck may be reported again if it gets stuck again later.
  const notified = (prev?.notified ?? []).filter((kind) => kind !== "stuck" || state === "stuck");
  return {
    ref: row.ref ?? row.id.slice(-8),
    name: row.name.slice(0, 120),
    state,
    lane: laneOfTask(row),
    ...(row.workerBotId ? { workerBotId: row.workerBotId } : {}),
    queuedAt: row.createdAt.toISOString(),
    ...(row.startedAt && state !== "queued" ? { startedAt: iso(row.startedAt) } : {}),
    ...(finishedAt ? { finishedAt: iso(finishedAt) } : {}),
    ...(step ? { step } : {}),
    ...(state === "queued" && snapshot.position ? { position: snapshot.position } : {}),
    ...(stuckSince ? { stuckSince } : {}),
    ...(notified.length ? { notified } : {}),
  };
}

/** Whether the result of a failed task never reached the main bot, so nobody would tell the user. */
function failedSilently(snapshot: TaskSnapshot): boolean {
  return snapshot.row.status === "failed" && !snapshot.run?.botOutcomeReturnedAt;
}

/** The milestone lines to post for a card update, marking them said on the entries. Pure. */
export function takeMilestones(
  entries: TaskProgressEntry[],
  snapshots: ReadonlyMap<string, TaskSnapshot>,
  options: { now: Date; stuckMs: number },
): { entries: TaskProgressEntry[]; lines: string[] } {
  const lines: string[] = [];
  const next = entries.map((entry) => {
    const said = new Set(entry.notified ?? []);
    const label = `「${entry.name} #${entry.ref}」`;
    if (entry.state === "stuck" && !said.has("stuck")) {
      said.add("stuck");
      const since = entry.stuckSince ? Date.parse(entry.stuckSince) : options.now.getTime();
      const quietMin = Math.max(
        1,
        Math.round((options.now.getTime() - since + options.stuckMs) / 60_000),
      );
      lines.push(
        `后台任务${label}已经约 ${quietMin} 分钟没有新进展${entry.step ? `（最近一步：${entry.step}）` : ""}。它还在运行，我没有打断它；需要的话可以让我查看情况、补充说明或取消。`,
      );
    }
    const snapshot = snapshots.get(entry.ref);
    if (entry.state === "failed" && !said.has("failed") && snapshot && failedSilently(snapshot)) {
      said.add("failed");
      lines.push(
        `后台任务${label}没能完成${entry.step ? `：${entry.step}` : ""}。需要的话我可以重新派一次。`,
      );
    }
    return said.size ? { ...entry, notified: [...said] } : entry;
  });
  return { entries: next, lines };
}

/** The open card's block, or the latest closed one, as stored. */
function cardBlock(blocks: unknown): TaskProgressBlock | undefined {
  if (!Array.isArray(blocks)) return undefined;
  for (const block of blocks) {
    const parsed = TaskProgressBlockSchema.safeParse(block);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function sameTasks(a: readonly TaskProgressEntry[], b: readonly TaskProgressEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function latestCard(
  prisma: Pick<PrismaClient, "message">,
  threadId: string,
  botId: string,
  since: Date,
) {
  const message = await prisma.message.findFirst({
    where: {
      threadId,
      botId,
      role: "bot",
      runId: null,
      createdAt: { gte: since },
      blocks: CARD_KIND,
    },
    orderBy: { seq: "desc" },
    select: { id: true, blocks: true },
  });
  const block = message ? cardBlock(message.blocks) : undefined;
  return message && block ? { id: message.id, block } : undefined;
}

async function snapshotTask(
  prisma: PrismaClient,
  row: TaskRow,
  position: number | undefined,
): Promise<TaskSnapshot> {
  if (row.status !== "started" || !row.workerRunId) {
    const run =
      row.status === "failed" && row.workerRunId
        ? await prisma.run.findUnique({
            where: { id: row.workerRunId },
            select: { status: true, error: true, completedAt: true, botOutcomeReturnedAt: true },
          })
        : null;
    return { row, run, position };
  }
  const [run, events, last, lastMessage] = await Promise.all([
    prisma.run.findUnique({
      where: { id: row.workerRunId },
      select: { status: true, error: true, completedAt: true, botOutcomeReturnedAt: true },
    }),
    prisma.event.findMany({
      where: {
        runId: row.workerRunId,
        type: { in: ["agent.tool.called", "agent.tool.completed", "thread.progress"] },
      },
      orderBy: { seq: "desc" },
      take: EVENT_WINDOW,
      select: { seq: true, type: true, payload: true, createdAt: true },
    }),
    prisma.event.findFirst({
      where: { runId: row.workerRunId },
      orderBy: { seq: "desc" },
      select: { createdAt: true },
    }),
    row.workerBotId
      ? prisma.message.findFirst({
          where: { thread: { botId: row.workerBotId }, role: { not: "user" } },
          orderBy: { createdAt: "desc" },
          select: { blocks: true },
        })
      : null,
  ]);
  return { row, run, events, lastEventAt: last?.createdAt, lastBlocks: lastMessage?.blocks };
}

const TASK_SELECT = {
  id: true,
  ref: true,
  name: true,
  status: true,
  args: true,
  error: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  workerBotId: true,
  workerRunId: true,
  threadId: true,
  spaceId: true,
} as const;

/**
 * Rebuilds the progress card of one bot's chat. Best effort: never throws. Returns whether the
 * card changed.
 */
export async function refreshTaskProgressCard(
  deps: Deps,
  botId: string,
  options: { now?: Date; stuckMs?: number } = {},
): Promise<boolean> {
  try {
    return await refreshNow(deps, botId, options);
  } catch (error) {
    getLogger().error("background task progress card", error);
    return false;
  }
}

async function refreshNow(
  deps: Deps,
  botId: string,
  options: { now?: Date; stuckMs?: number },
): Promise<boolean> {
  const now = options.now ?? new Date();
  const stuckMs = options.stuckMs ?? TASK_STUCK_MS;
  const active = await deps.prisma.backgroundTaskQueue.findMany({
    where: { botId, status: { in: ACTIVE_TASK_STATUSES } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: TASK_PROGRESS_MAX_TASKS,
    select: TASK_SELECT,
  });
  const recent = active.length
    ? []
    : await deps.prisma.backgroundTaskQueue.findMany({
        where: { botId, finishedAt: { gte: new Date(now.getTime() - RECENT_FINISHED_MS) } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: TASK_PROGRESS_MAX_TASKS,
        select: TASK_SELECT,
      });
  const anchor = active[0] ?? recent[0];
  if (!anchor) return false;
  const { threadId, spaceId } = anchor;
  // A card older than its oldest task is not this batch's card.
  const oldest = Math.min(...[...active, ...recent].map((row) => row.createdAt.getTime()));
  const since = new Date(Math.min(oldest, now.getTime() - RECENT_FINISHED_MS) - 60 * 60_000);
  const before = await latestCard(deps.prisma, threadId, botId, since);
  const openCard = before && !before.block.closed ? before : undefined;
  if (!openCard && !active.some((row) => row.threadId === threadId)) return false;

  // The open card's tasks keep their order; tasks started since join at the end.
  const onCard = openCard?.block.tasks.map((task) => task.ref) ?? [];
  const known = new Set(onCard);
  const extraRefs = onCard.filter((ref) => !active.some((row) => (row.ref ?? "") === ref));
  const finished = extraRefs.length
    ? await deps.prisma.backgroundTaskQueue.findMany({
        where: { botId, ref: { in: extraRefs } },
        orderBy: { createdAt: "desc" },
        select: TASK_SELECT,
      })
    : [];
  const byRef = new Map<string, (typeof active)[number]>();
  for (const row of [...finished].reverse()) if (row.ref) byRef.set(row.ref, row);
  for (const row of active) if (row.threadId === threadId) byRef.set(row.ref ?? row.id, row);
  const refs = [
    ...onCard.filter((ref) => byRef.has(ref)),
    ...[...byRef.keys()].filter((ref) => !known.has(ref)),
  ].slice(-TASK_PROGRESS_MAX_TASKS);
  const order = laneQueueOrder(active.filter((row) => row.status === "queued"));
  const snapshots = new Map<string, TaskSnapshot>();
  for (const ref of refs) {
    const row = byRef.get(ref)!;
    snapshots.set(ref, await snapshotTask(deps.prisma as PrismaClient, row, order.get(row.id)));
  }
  const prevByRef = new Map(openCard?.block.tasks.map((task) => [task.ref, task]) ?? []);
  const built = refs.map((ref) =>
    taskProgressEntry(snapshots.get(ref)!, { now, stuckMs, prev: prevByRef.get(ref) }),
  );
  const { entries, lines } = takeMilestones(built, snapshots, { now, stuckMs });
  const closed = entries.every((entry) => !isTaskProgressActive(entry.state));
  if (openCard && sameTasks(openCard.block.tasks, entries) && !closed && !lines.length)
    return false;
  if (!openCard && closed) return false;
  const block: TaskProgressBlock = {
    kind: "task_progress",
    botId,
    tasks: entries,
    updatedAt: now.toISOString(),
    ...(closed ? { closed: true as const } : {}),
  };
  const blocks: MessageBlock[] = [block];

  const events = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      if (
        !(await teamTaskProgressIsCurrent(
          tx,
          [...snapshots.values()].map((snapshot) => snapshot.row),
        ))
      )
        return [];
      // Someone else rewrote the card since we read it: their write wins, the next pass redoes ours.
      const current = await latestCard(tx as never, threadId, botId, since);
      if (
        current?.id !== before?.id ||
        (current && before && JSON.stringify(current.block) !== JSON.stringify(before.block))
      )
        return [];
      const written: Array<{ threadId: string; seq: number }> = [];
      if (openCard) {
        await tx.message.update({ where: { id: openCard.id }, data: { blocks: blocks as never } });
        written.push(
          await appendEventInTransaction(tx, {
            spaceId,
            threadId,
            botId,
            type: "thread.message.updated",
            payload: { messageId: openCard.id, role: "bot", blocks },
          }),
        );
      } else {
        const message = await createThreadMessageInTransaction(tx, {
          threadId,
          role: "bot",
          blocks,
          botId,
          markUnread: false,
        });
        written.push(
          await appendEventInTransaction(tx, {
            spaceId,
            threadId,
            botId,
            type: "thread.message.created",
            payload: { messageId: message.id, role: "bot", blocks },
          }),
        );
      }
      for (const text of lines) {
        const textBlocks: MessageBlock[] = [{ kind: "text", text }];
        const message = await createThreadMessageInTransaction(tx, {
          threadId,
          role: "bot",
          blocks: textBlocks,
          botId,
        });
        written.push(
          await appendEventInTransaction(tx, {
            spaceId,
            threadId,
            botId,
            type: "thread.message.created",
            payload: { messageId: message.id, role: "bot", blocks: textBlocks },
          }),
        );
      }
      return written;
    }),
  );
  const last = events.at(-1);
  if (last) await deps.events.notify(last.threadId, last.seq).catch(() => undefined);
  return events.length > 0;
}

/** Refreshes the card of the bot whose task a worker run carries (after it delivered its result). */
export async function refreshTaskProgressForWorkerRun(deps: Deps, workerRunId: string) {
  try {
    const task = await deps.prisma.backgroundTaskQueue.findFirst({
      where: { workerRunId },
      select: { botId: true },
    });
    if (task) await refreshTaskProgressCard(deps, task.botId);
  } catch (error) {
    getLogger().error("background task progress card", error);
  }
}

/** Reconciler pass: every bot with background tasks running, or finished in the last minutes. */
export async function refreshAllTaskProgressCards(deps: Deps, now = new Date()) {
  const bots = await deps.prisma.backgroundTaskQueue.findMany({
    where: {
      OR: [
        { status: { in: ACTIVE_TASK_STATUSES } },
        { finishedAt: { gte: new Date(now.getTime() - RECENT_FINISHED_MS) } },
      ],
    },
    distinct: ["botId"],
    select: { botId: true },
    take: 200,
  });
  for (const { botId } of bots) await refreshTaskProgressCard(deps, botId, { now });
}

/** For background_task_status: a running task that has been quiet past the stuck threshold. */
export async function taskStuckFields(
  prisma: Pick<PrismaClient, "event">,
  row: { status: string; workerRunId: string | null; startedAt: Date | null; createdAt: Date },
  runStatus: string | undefined,
  now = new Date(),
): Promise<Record<string, unknown>> {
  if (row.status !== "started" || !row.workerRunId) return {};
  if (!runStatus || !["queued", "leased", "running"].includes(runStatus)) return {};
  const last = await prisma.event.findFirst({
    where: { runId: row.workerRunId },
    orderBy: { seq: "desc" },
    select: { createdAt: true },
  });
  const lastActive = Math.max(
    last?.createdAt.getTime() ?? 0,
    row.startedAt?.getTime() ?? row.createdAt.getTime(),
  );
  const quiet = now.getTime() - lastActive;
  return quiet >= TASK_STUCK_MS ? { stuck: true, quiet_for_min: Math.round(quiet / 60_000) } : {};
}

export const TASK_STUCK_NOTE =
  "stuck: true means the task's worker has done nothing for quiet_for_min minutes; say so plainly. A progress card in the chat already shows every task's state, run time and latest step and updates itself, so do not post progress reports on your own; answer when asked, and speak up only for results, failures or decisions.";
