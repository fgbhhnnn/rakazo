import { runContinueJob } from "@rakazo/adapter-kit";
import { isHiddenBot } from "@rakazo/db";
import type { ExecutorDeps } from "./executor.js";

/*
 * Dispatcher mode: a user's bot only talks and dispatches; work runs in hidden background
 * workers. Everything the executor needs for it lives here; executor.ts only calls in.
 */

/** Thrown into a dispatcher turn that ran past its watchdog. */
export class DispatcherTurnTimeout extends Error {
  constructor(ms: number) {
    super(`The reply took longer than ${Math.round(ms / 1000)} s and was stopped.`);
    this.name = "DispatcherTurnTimeout";
  }
}

/** Triggers whose main turn is a reply to a person, so a hung turn is restarted for them. */
export const DISPATCHER_RESTART_TRIGGERS = new Set([
  "user",
  "follow_up",
  "messaging",
  "bot_message",
]);
export const DISPATCHER_MAX_RESTARTS = 2;

/**
 * Start a fresh main turn after the watchdog stopped one: steering the stopped turn had taken is
 * released so the new turn answers the latest messages. Restarts chain through retryOfRunId, so
 * a turn that keeps hanging stops after DISPATCHER_MAX_RESTARTS. Returns whether one was queued.
 */
export async function restartDispatcherTurn(
  deps: ExecutorDeps,
  failed: {
    id: string;
    spaceId: string;
    botId: string;
    threadId: string;
    taskId: string;
    userId: string;
    trigger: string;
    sourceMessageId: string | null;
  },
  continuationQueued: boolean,
): Promise<boolean> {
  let depth = 0;
  let cursor: string | null = failed.id;
  while (cursor && depth <= DISPATCHER_MAX_RESTARTS) {
    const row: { retryOfRunId: string | null } | null = await deps.prisma.run.findUnique({
      where: { id: cursor },
      select: { retryOfRunId: true },
    });
    cursor = row?.retryOfRunId ?? null;
    if (cursor) depth += 1;
  }
  if (depth >= DISPATCHER_MAX_RESTARTS) return false;
  const task = await deps.prisma.task.findUnique({
    where: { id: failed.taskId },
    select: { prompt: true },
  });
  if (!task) return false;
  const queued = await deps.prisma.$transaction(async (tx) => {
    await tx.steeringMessage.updateMany({ where: { runId: failed.id }, data: { runId: null } });
    // A continuation already queued for newer messages answers them; it sees the stopped
    // turn's messages too now that their claim is released.
    if (continuationQueued) return null;
    const retryTask = await tx.task.create({
      data: {
        spaceId: failed.spaceId,
        botId: failed.botId,
        threadId: failed.threadId,
        userId: failed.userId,
        prompt: task.prompt,
        status: "queued",
      },
    });
    return tx.run.create({
      data: {
        spaceId: failed.spaceId,
        botId: failed.botId,
        threadId: failed.threadId,
        taskId: retryTask.id,
        userId: failed.userId,
        status: "queued",
        trigger: failed.trigger,
        sourceMessageId: failed.sourceMessageId,
        retryOfRunId: failed.id,
      },
      select: { id: true },
    });
  });
  if (queued) await deps.jobs.enqueue(runContinueJob(queued.id));
  return true;
}

/** Longest a dispatcher's main turn may run (RAKAZO_DISPATCHER_TURN_MAX_MS, default 90 s). */
export function dispatcherTurnMaxMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.RAKAZO_DISPATCHER_TURN_MAX_MS);
  return Number.isFinite(parsed) && parsed >= 5_000 ? Math.floor(parsed) : 90_000;
}

/** RAKAZO_DISPATCHER_MODE=0 turns dispatcher mode off; it is on otherwise. */
export function dispatcherModeEnabled(env: Record<string, string | undefined> = process.env) {
  return !["0", "false", "off"].includes((env.RAKAZO_DISPATCHER_MODE ?? "").trim().toLowerCase());
}

/** How often a running run checks whether it was stopped. RAKAZO_RUN_CANCEL_POLL_MS overrides. */
export function runCancelPollMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.RAKAZO_RUN_CANCEL_POLL_MS);
  return Number.isFinite(parsed) && parsed >= 200 ? Math.floor(parsed) : 2_000;
}

/**
 * Tools a dispatcher's main run keeps: talk, dispatch/steer/check/cancel workers, and relay
 * their results. Everything that is work runs in a background worker.
 */
export const DISPATCHER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "message_user",
  "ask_user",
  "end_call",
  "background_task",
  "background_task_status",
  "background_task_message",
  "background_task_cancel",
  "attach_file",
]);

export const DISPATCH_ONLY_TOOL_NAMES = [
  "background_task",
  "background_task_status",
  "background_task_message",
  "background_task_cancel",
] as const;

/** Thrown to skip the computer lease for a dispatcher turn (it has no computer tools). */
export class SkipComputerLease extends Error {}

/** A user's own bot that can dispatch (background_task not disabled); workers never dispatch. */
export function isDispatcherBot(bot: {
  spawnKey?: string | null;
  disabledBuiltinTools?: readonly string[] | null;
}): boolean {
  return !isHiddenBot(bot) && !(bot.disabledBuiltinTools ?? []).includes("background_task");
}

/** Keeps the bot a dispatcher: heavy work goes to background workers so the chat stays responsive. */
export const BACKGROUND_DISPATCH_GUIDANCE =
  'You are a dispatcher: you talk with the user and run background workers; you have no work tools. Every task that is work (images, video, code, shell, web search or research, files, computer or browser, apps and plugins, anything beyond a chat answer from your own knowledge) goes to background_task. Pure chat questions you answer directly. After a tool call, continue from where your text left off; never restate or reword an answer you already wrote earlier in this reply (write the answer once; if you need a tool first, call it before answering). Send a worker the same note at most once per turn. Never tell the user that something will run or is running in the background unless you called background_task (or background_task_message) for it in this same turn; if the user asks you to do work yourself or "in the foreground" (for example a shell command), you still cannot, so start a worker for it and say so. A main turn is short: reply in a sentence or two, call background_task (one per independent task, several may run in parallel), then end the turn, so every new user message gets a reply within seconds. Read all new user messages before acting: if a later message shows the user no longer wants an earlier request (judge the intent yourself, in any wording), do not start it; if a worker is already running it, call background_task_cancel (the matching task_id, or "all" when the user means everything) and confirm only what the tool reports was stopped. To stop or change one task the user describes, match it with background_task_status and act on that task_id only. Never claim from memory whether a task is running, queued or finished: call background_task_status first and report what it returns. Never say work is done, generated or ready (e.g. "已经生成了") until the worker result message has arrived or background_task_status shows it completed; before that, say it is running or queued. When woken by a worker result, relay only the result(s) in this wake message; do not repeat results you already relayed earlier in this chat, and do not contradict them. Before starting a new background_task while workers exist, check background_task_status and judge for yourself whether the new request is a follow-up, correction or change to a running or recently finished task (e.g. "配音换成男声", "改成竖屏" after a video task): if so, send it to that task_id with background_task_message (an idle worker resumes with its earlier context) instead of starting a new worker. Judge relatedness by meaning, not by wording or by which worker happens to be idle: a request about a different subject or deliverable is unrelated work and gets a new background_task, even when a worker is idle; when unsure, start a new background_task. Usually 1-2 workers are enough. When you mention a task to the user, call it by its name and #ref (e.g. \u201c生成封面 #AB12CD34\u201d), never by a worker slot name such as \u201c后台1\u201d. Shell commands with $?, $#, $$ or $! are allowed; do not warn the user that they may be blocked. If a worker reports a failure (for example a provider error), call background_task_status before retrying and relaunch only if that task is not still running or queued; never start a second copy. If background_task returns status "queued", tell the user truthfully it is queued and its position (e.g. "已排队，第 1 位"), not that it started; it starts automatically when a worker frees up. Do not wait or poll; each worker\'s result wakes you as a message. Always answer that wake in the same turn with a message to the user (never stay silent, even if it failed or was cancelled): relay the actual result content itself (the list, answer, text or numbers the worker reported), not a promise like "我先把文件发给你", and never hand the work back to the worker just to send or format what it already reported. Files in the report "文件：" section are attached to your reply automatically; call attach_file only for other image, video or file paths the report mentions.';
/** Mid-run user messages get an acknowledgement before the bot goes back to work. */
export const STEERING_REPLY_GUIDANCE =
  "If a new user message arrives while you are in the middle of work, first answer it briefly with message_user (acknowledge, answer a quick question, or confirm the change of plan), then continue, redirect, or stop as it asks.";

/**
 * Watchdog: a dispatcher turn only talks and dispatches, so one that runs long has a hung model
 * call. Aborts it so the thread is free for the next message. Returns the clear function.
 */
export function startDispatcherWatchdog(
  controller: AbortController,
  onFire: () => void,
  ms = dispatcherTurnMaxMs(),
): () => void {
  const watchdog = setTimeout(() => {
    onFire();
    controller.abort(new DispatcherTurnTimeout(ms));
  }, ms);
  watchdog.unref?.();
  const clear = () => clearTimeout(watchdog);
  controller.signal.addEventListener("abort", clear);
  return clear;
}

/**
 * Tool surface of a run. A dispatcher's main run (a user's bot that can dispatch) keeps only
 * DISPATCHER_TOOL_NAMES: every work tool (shell, computer, browser, files, generation, web, agent
 * connections...) is disabled and refused if called, so new messages always get a short, real
 * reply and stop cancels only workers. Connector tools are withheld by the caller. A hidden
 * worker does the work itself and never dispatches further workers. Returns whether this is a
 * dispatcher run.
 */
export function applyDispatcherToolPolicy(
  dispatcherMode: boolean | undefined,
  bot: { spawnKey?: string | null; disabledBuiltinTools?: readonly string[] | null },
  disabled: Set<string>,
  offered: readonly { name: string }[],
): boolean {
  if (isHiddenBot(bot)) for (const name of DISPATCH_ONLY_TOOL_NAMES) disabled.add(name);
  const dispatcherRun = Boolean(dispatcherMode) && isDispatcherBot(bot);
  if (dispatcherRun) {
    for (const tool of offered) if (!DISPATCHER_TOOL_NAMES.has(tool.name)) disabled.add(tool.name);
  }
  return dispatcherRun;
}
