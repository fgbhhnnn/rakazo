import { ACTIVE_RUN_STATUSES, BOT_MESSAGE_MAX_LENGTH, textSimilarity } from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  HIDDEN_BOT_SPAWN_PREFIX,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { messageBot } from "./bot-messages.js";
import { spawnBot } from "./child-bots.js";
import { formatInstantForUser, resolveRunTimeZone } from "./current-time.js";
import type { ExecutorDeps } from "./executor.js";
import { stopThreadRunsForBots } from "./thread-stop.js";

/**
 * Background tasks: the bot hands heavy work to a worker and stays free to talk.
 *
 * A worker is a hidden child bot of the dispatcher, one per slot, reused across tasks. It shares
 * the dispatcher's computer, has its own thread and context window, and gets the task as a
 * bot-to-bot request. Everything else is the existing delegation machinery: the worker's run is
 * durable (the job reconciler repairs lost wakes), its terminal outcome is returned to the
 * dispatcher automatically (bounded by the bot-message limit), and that reply wakes the dispatcher.
 */
export const BACKGROUND_TASK_TOOL_NAMES = [
  "background_task",
  "background_task_status",
  "background_task_message",
  "background_task_cancel",
] as const;

export function backgroundTaskConcurrency(env: Record<string, string | undefined> = process.env) {
  const parsed = Number(env.RAKAZO_BACKGROUND_TASKS_PER_BOT?.trim() || Number.NaN);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(10, Math.floor(parsed)) : 4;
}

export const BACKGROUND_WORKER_SPAWN_PREFIX = HIDDEN_BOT_SPAWN_PREFIX;
export function backgroundWorkerSpawnKey(botId: string, slot: number) {
  return `${BACKGROUND_WORKER_SPAWN_PREFIX}${botId}:${slot}`;
}

/** Tools a worker never gets: no recursion, no fleet changes, no talking to the user directly. */
const WORKER_ALWAYS_DISABLED = [
  ...BACKGROUND_TASK_TOOL_NAMES,
  "spawn_bot",
  "archive_bot",
  "update_bot",
  "handoff_to_bot",
  "call_user",
  "end_call",
  "create_space",
  "propose_instructions_update",
  "list_fleet",
  "create_group",
  "update_group",
  "organize_bot",
  "set_child_instructions",
  "set_child_bot_model",
  "create_child_routine",
];

export const BACKGROUND_AGENT_PROFILES = {
  general: {
    prompt: "通用后台执行者：按任务说明完成工作。",
    tools: undefined as string[] | undefined,
  },
  researcher: {
    prompt: "调研员：搜索、阅读、核实来源，输出结论和出处链接。不改文件以外的任何东西。",
    tools: [
      "web_search",
      "web_fetch",
      "read_file",
      "write_file",
      "list_files",
      "shell",
      "run_subagent",
      "recall_memory",
      "search_history",
      "read_history",
      "skill_read",
      "attach_file",
    ],
  },
  coder: {
    prompt: "程序员：在电脑上写代码、跑测试，完成后汇报改了哪些文件和测试结果。",
    tools: [
      "shell",
      "read_file",
      "write_file",
      "list_files",
      "open_path",
      "web_search",
      "web_fetch",
      "run_subagent",
      "skill_read",
      "attach_file",
    ],
  },
  media: {
    prompt:
      "媒体制作：生成/处理图片、视频、音频（可用 MCP 生成工具和 ffmpeg），产物存文件，关键产物用 attach_file 预览。",
    tools: [
      "shell",
      "read_file",
      "write_file",
      "list_files",
      "attach_file",
      "run_subagent",
      "web_fetch",
      "skill_read",
      "render_plot",
    ],
  },
} as const;
export type BackgroundAgentProfile = keyof typeof BACKGROUND_AGENT_PROFILES;

const WORKER_INSTRUCTIONS = `你是后台工作者（background worker），由主 bot 派来做一项具体任务。
- 你有自己的上下文；主 bot 和用户看不到你的中间过程，只看到你最后的回复。
- 只做任务说明里的事。不要问用户问题；信息不够就做合理假设并在结果里写明。
- 大任务按 "Heavy Task Workflow" 技能来：计划清单写文件、素材存文件、看图分批交给 run_subagent。
- 产物写到电脑工作区里的文件（shell 的默认当前目录就是工作区，建议 ./jobs/<任务名>/out/），结果里给出路径。不要把要交付的文件放在工作区外（如 shell 的 ~、/tmp），那里的文件发不出去；如已写在外面，先复制进工作区。
- 最后的回复就是交给主 bot 的结果：简洁（建议 1500 字以内），包括 完成情况 / 结果正文 / 遇到的问题 / 建议的下一步。结果本身（名单、答案、文案等）直接写进回复，不要只给路径。
- 要交给用户的产物文件，在回复最后单独列出（每行一个绝对路径，用 realpath 确认存在），格式严格如下，系统会自动把这些文件发给用户：
文件：
- /绝对路径/文件名.扩展名`;

/** Most files the main bot attaches automatically from one worker report. */
const MAX_REPORT_FILES = 10;

/**
 * The output files a worker lists in its report's "文件：" section (see WORKER_INSTRUCTIONS),
 * as absolute or ~/ paths. URLs and anything else are left for the main bot to relay as text.
 */
export function parseWorkerReportFiles(text: string): string[] {
  const files: string[] = [];
  const add = (raw: string) => {
    const value = raw
      .trim()
      .replace(/^[-*•]\s*|^\d+[.)]\s*/, "")
      .replace(/^`+|`+$/g, "")
      .replace(/^\[[^\]]*\]\((.*)\)$/, "$1")
      .trim();
    if (!/^(?:\/|~\/)\S/.test(value) || /\s/.test(value) || files.includes(value)) return;
    if (files.length < MAX_REPORT_FILES) files.push(value);
  };
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const header =
      /^\s*(?:#+\s*)?(?:\*\*)?(?:产物文件|输出文件|文件|files?|outputs?)(?:\*\*)?\s*[:：](?:\*\*)?\s*(.*)$/i.exec(
        lines[index] ?? "",
      );
    if (!header) continue;
    if (header[1]?.trim()) for (const part of header[1].split(/[,，、]\s*/)) add(part);
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] ?? "";
      if (!line.trim()) {
        if (files.length) break;
        continue;
      }
      if (!/^\s*(?:[-*•]|\d+[.)])\s*/.test(line)) break;
      add(line);
    }
  }
  return files;
}

type Deps = Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "sandbox">;
type DispatchRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  sourceMessageId?: string | null;
};
type DispatchBot = { id: string; name: string; computerId?: string | null };

/** Builtin tools a worker may not use, given an optional allowlist. Unknown names are ignored. */
export function workerDisabledTools(
  allBuiltinNames: readonly string[],
  allowlist: readonly string[] | undefined,
): string[] {
  const disabled = new Set<string>(WORKER_ALWAYS_DISABLED);
  if (allowlist && allowlist.length > 0) {
    const allowed = new Set(allowlist);
    for (const name of allBuiltinNames) if (!allowed.has(name)) disabled.add(name);
  }
  return [...disabled].filter((name) => allBuiltinNames.includes(name)).sort();
}

export function buildBackgroundTaskMessage(input: {
  name: string;
  task: string;
  instructions?: string;
  agent: BackgroundAgentProfile;
}): string {
  const parts = [
    `【后台任务】${input.name}`,
    `角色：${BACKGROUND_AGENT_PROFILES[input.agent].prompt}`,
    input.instructions?.trim() ? `额外要求：\n${input.instructions.trim()}` : "",
    `任务：\n${input.task.trim()}`,
  ].filter(Boolean);
  const text = parts.join("\n\n");
  return text.length <= BOT_MESSAGE_MAX_LENGTH
    ? text
    : `${text.slice(0, BOT_MESSAGE_MAX_LENGTH - 80)}\n…[任务说明过长已截断，把完整说明写进文件再引用路径]`;
}

async function workerBots(deps: Deps, bot: DispatchBot, spaceId: string) {
  return deps.prisma.bot.findMany({
    where: {
      spaceId,
      parentBotId: bot.id,
      spawnKey: { startsWith: `${BACKGROUND_WORKER_SPAWN_PREFIX}${bot.id}:` },
      archivedAt: null,
    },
    select: {
      id: true,
      name: true,
      title: true,
      description: true,
      spawnKey: true,
      thread: { select: { id: true } },
    },
  });
}

const UNDELIVERED_HOLD_MS = 10 * 60_000;

/** The worker's latest finished run whose outcome was not yet returned to the dispatcher. */
async function undeliveredOutcome(deps: Deps, botId: string) {
  const latest = await deps.prisma.run.findFirst({
    where: { botId, status: { notIn: [...ACTIVE_RUN_STATUSES] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, completedAt: true, botOutcomeReturnedAt: true },
  });
  if (!latest || latest.botOutcomeReturnedAt) return null;
  if (latest.status !== "completed" && latest.status !== "failed") return null;
  // Delivery normally follows within seconds; a result stuck longer must not hold the slot forever.
  const finishedAt = latest.completedAt?.getTime() ?? 0;
  return Date.now() - finishedAt < UNDELIVERED_HOLD_MS ? latest : null;
}

async function activeRunFor(deps: Deps, botId: string) {
  return deps.prisma.run.findFirst({
    where: { botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, taskId: true, status: true, createdAt: true },
  });
}

// Parallel background_task calls in one turn must not pick the same idle slot before either
// has queued its run, so launches for one dispatcher run one at a time in this process.
/** Short unique label of one background task, shown on its card and in the worker's title. */
export function newTaskRef(): string {
  return `T${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
}

/** A worker title without its " #REF" task label. */
export function taskTitle(title: string): string {
  return title.replace(/ #[A-Z0-9]{4,10}$/, "");
}

const FRESH_TASK_SUMMARY = "此前的后台任务已结束，与接下来的新任务无关；只按新任务消息工作。";

const launchLocks = new Map<string, Promise<unknown>>();

export function launchBackgroundTask(
  deps: Deps,
  run: DispatchRun,
  bot: DispatchBot,
  args: Record<string, unknown>,
  options: { builtinToolNames: readonly string[]; deliveryKey: string },
) {
  const previous = launchLocks.get(bot.id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => launchBackgroundTaskNow(deps, run, bot, args, options));
  launchLocks.set(bot.id, next);
  const release = () => {
    if (launchLocks.get(bot.id) === next) launchLocks.delete(bot.id);
  };
  next.then(release, release);
  return next;
}

async function launchBackgroundTaskNow(
  deps: Deps,
  run: DispatchRun,
  bot: DispatchBot,
  args: Record<string, unknown>,
  options: { builtinToolNames: readonly string[]; deliveryKey: string },
) {
  const name =
    String(args.name ?? "")
      .trim()
      .slice(0, 40) || "任务";
  const task = String(args.task ?? "").trim();
  if (!task) return { error: "task is required" };
  const agentArg = String(args.agent ?? "general");
  if (!(agentArg in BACKGROUND_AGENT_PROFILES)) {
    return { error: `agent must be one of ${Object.keys(BACKGROUND_AGENT_PROFILES).join(", ")}` };
  }
  const agent = agentArg as BackgroundAgentProfile;
  const toolsArg = Array.isArray(args.tools) ? args.tools.map(String) : undefined;
  const allowlist = toolsArg ?? BACKGROUND_AGENT_PROFILES[agent].tools;

  // Never start a second copy of a task that is still running or queued (e.g. a retry after a
  // provider error while the first attempt is in fact still going).
  const duplicate = await findDuplicateTask(deps, run, bot, name, task);
  if (duplicate) return duplicate;
  const limit = backgroundTaskConcurrency();
  // FIFO: older queued tasks take free slots before this new one.
  if ((await queuedTasks(deps, bot.id)).length) await drainQueue(deps, bot.id, run);
  const found = await freeSlot(deps, run, bot);
  if ("error" in found) return { error: found.error };
  const { slotBot, busy } = found;
  if (!slotBot) {
    // Over the soft max: keep the request, FIFO per dispatcher, and start it when a slot frees.
    const queued = await deps.prisma.backgroundTaskQueue.create({
      data: {
        spaceId: run.spaceId,
        botId: bot.id,
        userId: run.userId,
        runId: run.id,
        threadId: run.threadId,
        name,
        task,
        args: {
          ...(args.instructions ? { instructions: String(args.instructions) } : {}),
          agent,
          disabled: workerDisabledTools(options.builtinToolNames, allowlist),
          deliveryKey: options.deliveryKey,
        },
      },
    });
    const position = await deps.prisma.backgroundTaskQueue.count({
      where: { botId: bot.id, status: "queued", createdAt: { lte: queued.createdAt } },
    });
    return {
      ok: true as const,
      status: "queued" as const,
      task_id: `q:${queued.id}`,
      name,
      position,
      running: busy,
      limit,
      note: `${busy} 个后台任务正在运行（上限 ${limit}），这个任务已排队，第 ${position} 位；有空位时自动开始，结果照常发回给你。如实告诉用户“已排队，第 ${position} 位”，不要说已开始。`,
    };
  }
  return startOnSlot(deps, run, bot, slotBot, {
    name,
    task,
    instructions: args.instructions ? String(args.instructions) : undefined,
    agent,
    disabled: workerDisabledTools(options.builtinToolNames, allowlist),
    deliveryKey: options.deliveryKey,
  });
}

type SlotBot = { id: string; name: string };
type StartSpec = {
  name: string;
  task: string;
  instructions?: string;
  agent: BackgroundAgentProfile;
  disabled: string[];
  deliveryKey: string;
  allowTerminalSource?: boolean;
};

/** Free slot bot of this dispatcher, spawning one if needed; null when all slots are busy. */
async function freeSlot(deps: Deps, run: DispatchRun, bot: DispatchBot) {
  const limit = backgroundTaskConcurrency();
  const existing = await workerBots(deps, bot, run.spaceId);
  let busy = 0;
  for (let slot = 1; slot <= limit; slot += 1) {
    const worker = existing.find((b) => b.spawnKey === backgroundWorkerSpawnKey(bot.id, slot));
    if (
      worker &&
      ((await activeRunFor(deps, worker.id)) || (await undeliveredOutcome(deps, worker.id)))
    ) {
      // Busy, or its last result has not reached the dispatcher yet: never hand the slot
      // (and its context) to unrelated work before that result is delivered.
      busy += 1;
      continue;
    }
    if (worker) return { slotBot: worker as SlotBot, busy };
    const spawned = await spawnBot(deps, {
      spawnedBy: { id: bot.id, name: bot.name, spaceId: run.spaceId, userId: run.userId },
      runId: run.id,
      spawnKey: backgroundWorkerSpawnKey(bot.id, slot),
      name: `${bot.name} · 后台${slot}`.slice(0, 60),
      title: "后台工作者",
      description: `${bot.name} 的后台工作者，由 background_task 自动管理。`,
      instructions: WORKER_INSTRUCTIONS,
    });
    if ("error" in spawned) return { error: spawned.error as string, busy };
    return { slotBot: { id: spawned.botId, name: spawned.name } as SlotBot, busy };
  }
  return { slotBot: null, busy };
}

async function startOnSlot(
  deps: Deps,
  run: DispatchRun,
  bot: DispatchBot,
  slotBot: SlotBot,
  spec: StartSpec,
) {
  const { name, task, agent } = spec;
  // A slot is reused across tasks; the ref tells this task apart from the slot's earlier ones.
  const ref = newTaskRef();

  // Per task: same computer as the dispatcher, quiet notifications, this task's tool set.
  await deps.prisma.bot.update({
    where: { id: slotBot.id },
    data: {
      notifyOnFinish: false,
      instructions: WORKER_INSTRUCTIONS,
      // The current task, so status can name it and the user can stop "the video one".
      title: `${name.slice(0, 70)} #${ref}`,
      description: task.slice(0, 300),
      disabledBuiltinTools: spec.disabled,
      ...(bot.computerId ? { computerId: bot.computerId } : {}),
    },
  });
  // An unrelated new task starts with a fresh context: earlier tasks stay visible in the
  // worker's thread but are cut from its model history (follow-ups go via background_task_message).
  const workerThread = await deps.prisma.thread.findFirst({
    where: { botId: slotBot.id },
    select: { id: true, nextMessageSeq: true },
  });
  if (workerThread && workerThread.nextMessageSeq > 0) {
    await deps.prisma.thread.update({
      where: { id: workerThread.id },
      data: {
        historyCompactedUpToSeq: workerThread.nextMessageSeq - 1,
        historyCompactionSummary: FRESH_TASK_SUMMARY,
        historyCompactionGeneration: { increment: 1 },
      },
    });
  }

  const sendArgs = [
    deps,
    run,
    { id: bot.id, name: bot.name },
    {
      bot_id: slotBot.id,
      message: buildBackgroundTaskMessage({
        name,
        task,
        instructions: spec.instructions,
        agent,
      }),
      intent: "request",
      deliveryKey: spec.deliveryKey,
    },
  ] as const;
  const sent = spec.allowTerminalSource
    ? await messageBot(...sendArgs, { allowTerminalSource: true })
    : await messageBot(...sendArgs);
  if (!sent.ok) return { error: sent.error };
  return {
    ok: true as const,
    task_id: slotBot.id,
    task_ref: ref,
    name,
    agent,
    note: "已在后台开始。结果完成后会自动作为消息发回给你并唤醒你；现在先简短告诉用户已派出，然后结束本轮或继续别的事。不要轮询等待。",
  };
}

export async function backgroundTaskStatus(
  deps: Deps,
  run: DispatchRun,
  bot: DispatchBot,
  args: Record<string, unknown>,
) {
  const workers = await workerBots(deps, bot, run.spaceId);
  // Times go out in the user's zone (else the owner's or deployment's), with the offset shown.
  const zone = await resolveRunTimeZone(deps.prisma as never, run);
  const wanted = args.task_id ? String(args.task_id) : undefined;
  const selected = wanted ? workers.filter((w) => w.id === wanted) : workers;
  if (wanted && !wanted.startsWith("q:") && selected.length === 0)
    return { error: "no background task with that task_id" };
  const tasks = await Promise.all(
    selected.map(async (worker) => {
      const latest = await deps.prisma.run.findFirst({
        where: { botId: worker.id },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, createdAt: true, completedAt: true, error: true },
      });
      const last = worker.thread
        ? await deps.prisma.message.findFirst({
            where: { threadId: worker.thread.id, role: { not: "user" } },
            orderBy: { seq: "desc" },
            select: { blocks: true },
          })
        : null;
      const finishedAt = latest?.completedAt;
      return {
        task_id: worker.id,
        name: worker.title,
        task: worker.description,
        state: latest?.status ?? "idle",
        started_at: latest?.createdAt ? formatInstantForUser(latest.createdAt, zone) : undefined,
        finished_at: finishedAt ? formatInstantForUser(finishedAt, zone) : undefined,
        finished_recently: finishedAt ? Date.now() - finishedAt.getTime() < 30 * 60_000 : false,
        last_progress: lastText(last?.blocks),
        ...(latest?.error ? { error: String(latest.error).slice(0, 500) } : {}),
      };
    }),
  );
  const queue = wanted?.startsWith("q:") || !wanted ? await queuedTasks(deps, bot.id) : [];
  const queued = queue
    .map((row, index) => ({
      task_id: `q:${row.id}`,
      name: row.name,
      task: row.task.slice(0, 300),
      state: "queued",
      position: index + 1,
      queued_at: formatInstantForUser(row.createdAt, zone),
    }))
    .filter((q) => !wanted || q.task_id === wanted);
  if (wanted?.startsWith("q:") && queued.length === 0)
    return { error: "no queued task with that task_id" };
  return {
    ok: true as const,
    limit: backgroundTaskConcurrency(),
    tasks: wanted?.startsWith("q:") ? [] : tasks,
    queued,
    time_zone: zone ?? "UTC",
    note: `Times above are in ${zone ?? "UTC"}; quote them to the user with that offset label, never as bare UTC unless the zone is UTC. Only state "done" for a task whose state is completed here or whose result you received; running/queued tasks are not done. Routing: send a new request to an existing task_id with background_task_message only when, by its meaning, it continues that same task's work or deliverable (a follow-up, correction or change to it). A request about a different subject or deliverable is new work: start a new background_task, even if a worker is idle. When unsure, start a new background_task.`,
  };
}

/** Notes each main turn already sent to a worker, so a looping turn cannot send the same note 2-3x. */
const sentThisTurn = new Map<string, string[]>();
const MAX_TRACKED_TURNS = 500;
const REPEATED_NOTE_SIMILARITY = 0.8;

export function alreadySentThisTurn(runId: string, workerId: string, text: string): boolean {
  const key = `${runId}:${workerId}`;
  const sent = sentThisTurn.get(key) ?? [];
  if (sent.some((prior) => textSimilarity(prior, text) >= REPEATED_NOTE_SIMILARITY)) return true;
  sentThisTurn.delete(key);
  sentThisTurn.set(key, [...sent, text]);
  while (sentThisTurn.size > MAX_TRACKED_TURNS) {
    const oldest = sentThisTurn.keys().next().value;
    if (oldest === undefined) break;
    sentThisTurn.delete(oldest);
  }
  return false;
}

export async function backgroundTaskMessage(
  deps: Deps,
  run: DispatchRun,
  bot: DispatchBot,
  args: Record<string, unknown>,
  deliveryKey: string,
) {
  const workers = await workerBots(deps, bot, run.spaceId);
  const text = String(args.message ?? "").trim();
  const wantedId = String(args.task_id ?? "");
  if (wantedId.startsWith("q:")) {
    if (!text) return { error: "message is empty" };
    const row = await deps.prisma.backgroundTaskQueue.findFirst({
      where: { id: wantedId.slice(2), botId: bot.id, status: "queued" },
    });
    if (!row)
      return {
        error:
          "no queued task with that task_id (it may have started; check background_task_status)",
      };
    await deps.prisma.backgroundTaskQueue.update({
      where: { id: row.id },
      data: { task: `${row.task}\n\n[补充/改向指令]\n${text}`.slice(0, 20_000) },
    });
    return {
      ok: true as const,
      task_id: wantedId,
      note: "Queued task updated; it starts with this change.",
    };
  }
  const worker = workers.find((w) => w.id === wantedId);
  if (!worker) return { error: "no background task with that task_id" };
  if (!text) return { error: "message is empty" };
  if (alreadySentThisTurn(run.id, worker.id, text))
    return {
      ok: true as const,
      task_id: worker.id,
      note: "Already sent this to the worker in this turn; not sent again. Reply to the user once and end the turn.",
    };
  // A worker that is mid-run takes the note as steering on its next model step, the same way
  // a user's follow-up reaches a busy bot. An idle worker gets a normal bot message instead.
  const active = worker.thread ? await activeRunFor(deps, worker.id) : null;
  if (active && worker.thread && active.status === "running") {
    const threadId = worker.thread.id;
    const steered = await deps.prisma.$transaction(async (tx) => {
      const message = await createThreadMessageInTransaction(tx, {
        threadId,
        role: "user",
        blocks: [{ kind: "text", text: `[来自 ${bot.name} 的补充/改向指令]\n${text}` }],
        runId: active.id,
      });
      await tx.steeringMessage.create({
        data: { messageId: message.id, botId: worker.id, userId: run.userId, runId: active.id },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId,
        botId: worker.id,
        type: "thread.message.created",
        runId: active.id,
        payload: { messageId: message.id, role: "user", blocks: message.blocks },
      });
      return event.seq;
    });
    await deps.events.notify(threadId, steered).catch(() => undefined);
    return {
      ok: true as const,
      task_id: worker.id,
      note: "Delivered to the running worker; it sees it on its next step.",
    };
  }
  const sent = await messageBot(
    deps,
    run,
    { id: bot.id, name: bot.name },
    // Never fyi: an idle worker treats this as a new request and its result always comes back.
    { bot_id: worker.id, message: text, intent: "request", deliveryKey },
  );
  if (!sent.ok) return { error: sent.error };
  return {
    ok: true as const,
    task_id: worker.id,
    note: "Worker was idle; it resumes with this as a new request and its result comes back to you as a message.",
  };
}

/**
 * Stops one worker (task_id) or every worker of this bot (task_id "all"). Uses the same path
 * as the Stop button: runs flip to cancelled (the worker's executor aborts its model call,
 * tools and MCP polling when it sees that), its shell processes are killed on the computer,
 * and the screen and lease are released.
 */
export async function cancelBackgroundTask(
  deps: Deps,
  run: DispatchRun,
  bot: DispatchBot,
  args: Record<string, unknown>,
  stop: (
    actor: { spaceId: string; userId: string },
    target: { threadId: string; botIds: readonly string[] },
  ) => Promise<{ runIds: string[] }> = (actor, target) =>
    stopThreadRunsForBots(deps, actor, target),
) {
  const startedAt = Date.now();
  const workers = await workerBots(deps, bot, run.spaceId);
  const wanted = String(args.task_id ?? "").trim();
  const byId = workers.filter((w) => w.id === wanted);
  const needle = wanted.toLowerCase();
  // A task name (from background_task) also works, so "the video one" can be stopped alone.
  const targets =
    wanted === "all"
      ? workers
      : byId.length > 0 || !needle
        ? byId
        : workers.filter(
            (w) =>
              w.title &&
              (w.title.toLowerCase() === needle || taskTitle(w.title).toLowerCase() === needle),
          );
  const queue = await queuedTasks(deps, bot.id);
  const queuedTargets =
    wanted === "all"
      ? queue
      : queue.filter((q) => `q:${q.id}` === wanted || (needle && q.name.toLowerCase() === needle));
  const cancelledQueued: Array<{ task_id: string; name: string }> = [];
  for (const q of queuedTargets) {
    const done = await deps.prisma.backgroundTaskQueue.updateMany({
      where: { id: q.id, status: "queued" },
      data: { status: "cancelled" },
    });
    if (done.count) cancelledQueued.push({ task_id: `q:${q.id}`, name: q.name });
  }
  if (targets.length === 0 && cancelledQueued.length > 0) {
    return {
      ok: true as const,
      cancelled: [],
      cancelled_queued: cancelledQueued,
      note: "These queued tasks were removed before they started.",
    };
  }
  if (targets.length === 0) {
    return wanted === "all"
      ? { ok: true as const, cancelled: [], note: "no background tasks" }
      : { error: "no background task with that task_id" };
  }
  const cancelled: Array<{ task_id: string; name: string; cancelled_runs: number }> = [];
  for (const worker of targets) {
    if (!worker.thread) continue;
    const { runIds } = await stop(
      { spaceId: run.spaceId, userId: run.userId },
      { threadId: worker.thread.id, botIds: [worker.id] },
    );
    cancelled.push({
      task_id: worker.id,
      name: worker.title || worker.name,
      cancelled_runs: runIds.length,
    });
  }
  getLogger().info("background task cancelled", {
    runId: run.id,
    workers: cancelled.map((c) => c.task_id),
    ms: Date.now() - startedAt,
  });
  // Freed slots go to the next queued tasks (unless everything was cancelled).
  if (wanted !== "all") await startQueuedBackgroundTasks(deps, bot.id, run).catch(() => undefined);
  return {
    ok: true as const,
    cancelled,
    cancelled_queued: cancelledQueued,
    note: "Tell the user exactly which tasks were stopped (cancelled_runs > 0). A task with cancelled_runs 0 had already finished or was idle: say so instead of claiming you stopped it.",
  };
}

/**
 * Starts queued background_task requests of one dispatcher, oldest first, while slots are free.
 * Called when a worker run ends, after a cancel, and at the start of every dispatcher turn, so
 * the persisted queue also drains after a restart.
 */
export function startQueuedBackgroundTasks(
  deps: Deps,
  dispatcherBotId: string,
  liveRun?: DispatchRun,
) {
  const previous = launchLocks.get(dispatcherBotId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => drainQueue(deps, dispatcherBotId, liveRun));
  launchLocks.set(dispatcherBotId, next);
  const release = () => {
    if (launchLocks.get(dispatcherBotId) === next) launchLocks.delete(dispatcherBotId);
  };
  next.then(release, release);
  return next;
}

async function drainQueue(deps: Deps, dispatcherBotId: string, liveRun?: DispatchRun) {
  const started: string[] = [];
  for (;;) {
    const row = await deps.prisma.backgroundTaskQueue.findFirst({
      where: { botId: dispatcherBotId, status: "queued" },
      orderBy: { createdAt: "asc" },
    });
    if (!row) break;
    const bot = await deps.prisma.bot.findUnique({
      where: { id: dispatcherBotId },
      select: { id: true, name: true, computerId: true, archivedAt: true },
    });
    if (!bot || bot.archivedAt) break;
    // The run that queued this row has usually ended by now. Hand off from the dispatcher run
    // doing the drain when there is one; otherwise send on behalf of the ended source run.
    const live = liveRun && liveRun.botId === bot.id ? liveRun : undefined;
    const run: DispatchRun = live ?? {
      id: row.runId,
      spaceId: row.spaceId,
      threadId: row.threadId,
      botId: bot.id,
      userId: row.userId,
    };
    const sourceEnded =
      !live &&
      (await deps.prisma.run.findUnique({ where: { id: row.runId }, select: { status: true } }))
        ?.status !== "running";
    const found = await freeSlot(deps, run, bot);
    if ("error" in found || !found.slotBot) break;
    // Claim first so two processes never start the same row.
    const claimed = await deps.prisma.backgroundTaskQueue.updateMany({
      where: { id: row.id, status: "queued" },
      data: { status: "started", startedAt: new Date(), workerBotId: found.slotBot.id },
    });
    if (claimed.count === 0) continue;
    const a = (row.args ?? {}) as Record<string, unknown>;
    const agent = (
      String(a.agent ?? "general") in BACKGROUND_AGENT_PROFILES ? a.agent : "general"
    ) as BackgroundAgentProfile;
    const out = await startOnSlot(deps, run, bot, found.slotBot, {
      name: row.name,
      task: row.task,
      instructions: a.instructions ? String(a.instructions) : undefined,
      agent,
      disabled: Array.isArray(a.disabled) ? a.disabled.map(String) : [...WORKER_ALWAYS_DISABLED],
      deliveryKey: `${String(a.deliveryKey ?? row.id)}:queued`,
      allowTerminalSource: sourceEnded,
    });
    if ("error" in out) {
      getLogger().error("queued background task failed to start", {
        queueId: row.id,
        reason: out.error,
      });
      await deps.prisma.backgroundTaskQueue.update({
        where: { id: row.id },
        data: { status: "queued", startedAt: null, workerBotId: null },
      });
      break;
    }
    started.push(row.id);
    getLogger().info("queued background task started", { queueId: row.id, worker: out.task_id });
  }
  return started;
}

async function queuedTasks(deps: Deps, botId: string) {
  return deps.prisma.backgroundTaskQueue.findMany({
    where: { botId, status: "queued" },
    orderBy: { createdAt: "asc" },
  });
}

function lastText(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const text = blocks
    .map((b) =>
      b && typeof b === "object" && (b as { kind?: unknown }).kind === "text"
        ? String((b as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n")
    .trim();
  return text ? (text.length > 300 ? `…${text.slice(-300)}` : text) : undefined;
}

async function findDuplicateTask(
  deps: Deps,
  run: DispatchRun,
  bot: DispatchBot,
  name: string,
  task: string,
) {
  const same = (a: string | null | undefined, b: string) =>
    Boolean(a?.trim()) && a!.trim().toLowerCase() === b.trim().toLowerCase();
  for (const worker of await workerBots(deps, bot, run.spaceId)) {
    if (!same(worker.title ? taskTitle(worker.title) : worker.title, name)) continue;
    if (!(await activeRunFor(deps, worker.id))) continue;
    return {
      ok: true as const,
      status: "already_running" as const,
      task_id: worker.id,
      name: worker.title,
      note: "This task is already running on that worker; nothing new was started. To change it, use background_task_message with this task_id.",
    };
  }
  const queued = (await queuedTasks(deps, bot.id)).find((q) => same(q.name, name));
  return queued
    ? {
        ok: true as const,
        status: "already_queued" as const,
        task_id: `q:${queued.id}`,
        name: queued.name,
        note: "This task is already queued; nothing new was started.",
      }
    : null;
}
