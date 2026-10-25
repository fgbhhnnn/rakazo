import type { MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BOT_MESSAGE_MAX_LENGTH,
  textSimilarity,
  withoutWorkerSlot,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  HIDDEN_BOT_SPAWN_PREFIX,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { announceQueuedTaskStart } from "./background-task-cards.js";
import {
  type BackgroundTaskLane,
  laneComputer,
  laneDisabledTools,
  laneHeads,
  laneLimit,
  laneOfTask,
  laneQueueOrder,
  laneQueuePosition,
  requestedLane,
  THINK_WORKER_INSTRUCTIONS,
} from "./background-task-lanes.js";
import { recoverBackgroundTasks } from "./background-task-recovery.js";
import {
  ACTIVE_TASK_STATUSES,
  MAX_TASK_START_ATTEMPTS,
  SLOT_HOLDING_STATUSES,
  taskDeliveryKey,
} from "./background-task-rows.js";
import { messageBot } from "./bot-messages.js";
import { spawnBot } from "./child-bots.js";
import { formatInstantForUser, resolveRunTimeZone } from "./current-time.js";
import type { ExecutorDeps } from "./executor.js";
import { QUEUE_AFTER_CANCEL_NOTE, queueChangeAfterCancel } from "./queue-after-cancel.js";
import { type AttachmentBlock, attachmentBlocks } from "./task-attachments.js";
import { backgroundTaskHash, newTaskRef, taskTitle } from "./task-identity.js";
import { stopThreadRunsForBots } from "./thread-stop.js";
import { WORKER_ACTIVITY_NOTE, workerActivityFields } from "./worker-activity.js";
import { workerSettingsFromMain } from "./worker-main-settings.js";
import { WORKER_NEEDS_USER_NOTE, workerPending } from "./worker-needs-user.js";
import { WORKER_PROGRESS_INSTRUCTION } from "./worker-progress.js";
import { WORKER_ALWAYS_DISABLED, workerDisabledTools } from "./worker-tool-policy.js";

/**
 * Background tasks: the bot hands heavy work to a worker and stays free to talk.
 *
 * A worker is a hidden child bot of the dispatcher, one per slot, reused across tasks. It shares
 * the dispatcher's computer, has its own thread and context window, and gets the task as a
 * bot-to-bot request. Everything else is the existing delegation machinery: the worker's run is
 * durable (the job reconciler repairs lost wakes), its terminal outcome is returned to the
 * dispatcher automatically (bounded by the bot-message limit), and that reply wakes the dispatcher.
 */

export { backgroundTaskConcurrency, thinkTaskConcurrency } from "./background-task-lanes.js";

export const BACKGROUND_WORKER_SPAWN_PREFIX = HIDDEN_BOT_SPAWN_PREFIX;
export function backgroundWorkerSpawnKey(botId: string, slot: number) {
  return `${BACKGROUND_WORKER_SPAWN_PREFIX}${botId}:${slot}`;
}

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
      "web_fetch",
      "skill_read",
      "render_plot",
    ],
  },
} as const;
export type BackgroundAgentProfile = keyof typeof BACKGROUND_AGENT_PROFILES;

export const WORKER_INSTRUCTIONS = `你是后台工作者（background worker），由主 bot 派来做一项具体任务。
- 你有自己的上下文；用户看不到你的中间过程，主 bot 只看得到你最近的工具调用和你用 report_progress 留的进度，最终以你最后的回复为准。
${WORKER_PROGRESS_INSTRUCTION}
- 只做任务说明里的事。不要问用户问题；信息不够就做合理假设并在结果里写明。
- 你不能再开子任务、子代理或新 bot（background_task、run_subagent、spawn_bot 等都不可用），所有活自己做完。
- 你不能直接找用户：要用户输入、密钥/登录、授权、连接应用、接管电脑或定时提醒时（request_secret、connect_app、request_takeover、schedule_create 等都不可用），先停下，在结果里写清楚具体需要什么、为什么；主 bot 会去找用户处理，再通知你继续。
- 等待后台命令时不要设定时提醒：在本轮里隔一会儿（如 sleep 30–60）查一次 status.json / 日志，直到跑完。
- 大任务按 "Heavy Task Workflow" 技能来：计划清单写文件、素材存文件；技能里说交给子代理或 background_task 的步骤，你自己分批做（看图每批 3-4 张，看完只留文字笔记写进文件）。
- 产物写到电脑工作区里的文件（shell 的默认当前目录就是工作区，建议 ./jobs/<任务名>/out/），结果里给出路径。不要把要交付的文件放在工作区外（如 shell 的 ~、/tmp），那里的文件发不出去；如已写在外面，先复制进工作区。
- 最后的回复就是交给主 bot 的结果：简洁（建议 1500 字以内），包括 完成情况 / 结果要点 / 遇到的问题 / 建议的下一步。短结果（答案、短名单、短文案）直接写进回复；长材料（长报告、长名单、大段正文，超过约 3000 字）写进工作区的报告文件（如 ./jobs/<任务名>/out/report.md），回复里只写要点摘要，并在下面的“文件：”里列出这个报告文件。
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
    // Absolute POSIX, ~/ or Windows drive paths; spaces inside a path are allowed (one path per
    // line). Whether it is inside the workspace is checked when the file is attached.
    if (!/^(?:\/|~\/|[A-Za-z]:[\\/])\S/.test(value) || /^\S+:\/\//.test(value)) return;
    if (files.includes(value)) return;
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
type QueueDeps = Pick<ExecutorDeps, "prisma" | "events" | "jobs">;
type DispatchRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  sourceMessageId?: string | null;
};
type DispatchBot = { id: string; name: string; computerId?: string | null };

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

async function workerBots(deps: Pick<Deps, "prisma">, botId: string, spaceId: string) {
  return deps.prisma.bot.findMany({
    where: {
      spaceId,
      parentBotId: botId,
      spawnKey: { startsWith: `${BACKGROUND_WORKER_SPAWN_PREFIX}${botId}:` },
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

const CLAIM_LEASE_MS = 2 * 60_000;
const PROCESS_LEASE_OWNER = `bgq:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;

const FRESH_TASK_SUMMARY = "此前的后台任务已结束，与接下来的新任务无关；只按新任务消息工作。";

// In-process serialization only avoids needless contention; correctness comes from the
// per-dispatcher row lock in claimSlot, which holds across API and worker processes.
const launchLocks = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = launchLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  launchLocks.set(key, next);
  const release = () => {
    if (launchLocks.get(key) === next) launchLocks.delete(key);
  };
  next.then(release, release);
  return next;
}

/** The user's uploads to forward to a worker as attachments (deduplicated, file/image only). */
export const taskAttachmentBlocks = attachmentBlocks;

type TaskRow = Awaited<ReturnType<typeof findTaskRow>> & {};

export function launchBackgroundTask(
  deps: QueueDeps,
  run: DispatchRun,
  bot: DispatchBot,
  args: Record<string, unknown>,
  options: {
    builtinToolNames: readonly string[];
    deliveryKey: string;
    attachments?: readonly AttachmentBlock[];
  },
) {
  return serialized(bot.id, () => launchBackgroundTaskNow(deps, run, bot, args, options));
}

async function launchBackgroundTaskNow(
  deps: QueueDeps,
  run: DispatchRun,
  bot: DispatchBot,
  args: Record<string, unknown>,
  options: {
    builtinToolNames: readonly string[];
    deliveryKey: string;
    attachments?: readonly AttachmentBlock[];
  },
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
  const instructions = args.instructions ? String(args.instructions) : undefined;
  const lanePick = requestedLane(args.lane);
  if ("error" in lanePick) return { error: lanePick.error };
  const { lane } = lanePick;
  // A computer task hashes as before; a think task never dedupes against its computer re-dispatch.
  const taskHash = backgroundTaskHash({
    name,
    task,
    instructions,
    agent: lane === "think" ? `${agent}:think` : agent,
  });

  // Never start a second copy of the same work that is still running or queued (e.g. a retry
  // after a provider error while the first attempt is in fact still going). Same content only.
  const duplicate = await deps.prisma.backgroundTaskQueue.findFirst({
    where: { botId: bot.id, taskHash, status: { in: ACTIVE_TASK_STATUSES } },
    orderBy: { createdAt: "asc" },
  });
  if (duplicate) {
    return {
      ok: true as const,
      status:
        duplicate.status === "queued" ? ("already_queued" as const) : ("already_running" as const),
      task_id: duplicate.ref ?? duplicate.id,
      name: duplicate.name,
      note: "This same task is already running or queued; nothing new was started. To change it, use background_task_message with this task_id.",
    };
  }
  // Retried tool call (same delivery key): return the task it already created.
  const replay = await deps.prisma.backgroundTaskQueue.findFirst({
    where: {
      botId: bot.id,
      runId: run.id,
      args: { path: ["deliveryKey"], equals: options.deliveryKey },
    },
  });
  const row =
    replay ??
    (await deps.prisma.backgroundTaskQueue.create({
      data: {
        spaceId: run.spaceId,
        botId: bot.id,
        userId: run.userId,
        runId: run.id,
        threadId: run.threadId,
        name,
        task,
        ref: newTaskRef(),
        taskHash,
        args: {
          ...(instructions ? { instructions } : {}),
          agent,
          ...(lane === "think" ? { lane } : {}),
          disabled: laneDisabledTools(
            lane,
            workerDisabledTools(options.builtinToolNames, allowlist),
            options.builtinToolNames,
          ),
          deliveryKey: options.deliveryKey,
          ...(options.attachments?.length
            ? { attachments: options.attachments.map((block) => ({ ...block })) }
            : {}),
        } as never,
      },
    }));
  // Every new task enters the queue, so it can never jump ahead of older queued ones (FIFO
  // even when the head of the queue fails to start).
  // This call's own card is posted by the tool; every other task started here gets one from the drain.
  await drainQueue(deps, bot.id, run, row.id);
  const now = await deps.prisma.backgroundTaskQueue.findUnique({ where: { id: row.id } });
  const limit = laneLimit(lane);
  if (now && (now.status === "started" || now.status === "claiming") && now.workerBotId) {
    return {
      ok: true as const,
      status: "started" as const,
      task_id: now.ref ?? now.id,
      task_ref: now.ref ?? now.id,
      worker_id: now.workerBotId,
      name,
      agent,
      lane,
      note: "已在后台开始。结果完成后会自动作为消息发回给你并唤醒你；现在先简短告诉用户已派出，然后结束本轮或继续别的事。不要轮询等待。",
    };
  }
  if (!now || now.status === "failed" || now.status === "cancelled") {
    return { error: now?.error ?? "background task could not be started" };
  }
  const { position, busy } = await laneQueuePosition(deps.prisma, bot.id, now);
  const laneName = lane === "think" ? "思考" : "电脑";
  return {
    ok: true as const,
    status: "queued" as const,
    task_id: now.ref ?? now.id,
    name,
    lane,
    position,
    running: busy,
    limit,
    note: `${busy} 个${laneName}后台任务正在运行（${laneName}任务上限 ${limit}），这个任务已排队，${laneName}队列第 ${position} 位；有空位时自动开始，结果照常发回给你。如实告诉用户“已排队，第 ${position} 位”，不要说已开始。`,
  };
}

/** Whether a worker is free: no task holds it and it has no live run of its own. */
async function workerIsFree(
  prisma: Pick<Deps["prisma"], "backgroundTaskQueue" | "run">,
  workerId: string,
) {
  const holding = await prisma.backgroundTaskQueue.findFirst({
    where: { workerBotId: workerId, status: { in: SLOT_HOLDING_STATUSES } },
    select: { id: true },
  });
  if (holding) return false;
  const live = await prisma.run.findFirst({
    where: { botId: workerId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true },
  });
  return !live;
}

type Claim =
  | {
      kind: "claimed";
      row: NonNullable<TaskRow>;
      workerId: string;
      attempts: number;
      lane: BackgroundTaskLane;
    }
  | { kind: "spawn"; slot: number; row: NonNullable<TaskRow> }
  | { kind: "none" };

/**
 * Atomically reserves a free slot for the head of this dispatcher's queue. The dispatcher's bot
 * row is locked for the transaction, so two processes never pick the same slot or row.
 */
async function claimSlot(
  deps: QueueDeps,
  dispatcherBotId: string,
  spaceId: string,
): Promise<Claim> {
  return deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${dispatcherBotId} FOR UPDATE`;
    const queued = await tx.backgroundTaskQueue.findMany({
      where: { botId: dispatcherBotId, status: "queued" },
      orderBy: { createdAt: "asc" },
    });
    if (queued.length === 0) return { kind: "none" } as const;
    const existing = await workerBots({ prisma: tx as never }, dispatcherBotId, spaceId);
    // Each lane is its own FIFO queue with its own slots: a full computer lane never holds
    // back think tasks, and the other way round.
    for (const { lane, head, slots } of laneHeads(queued)) {
      const claim = await claimLaneSlot(tx, dispatcherBotId, existing, lane, head, slots);
      if (claim) return claim;
    }
    return { kind: "none" } as const;
  });
}

async function claimLaneSlot(
  tx: Parameters<Parameters<QueueDeps["prisma"]["$transaction"]>[0]>[0],
  dispatcherBotId: string,
  existing: Awaited<ReturnType<typeof workerBots>>,
  lane: BackgroundTaskLane,
  head: NonNullable<TaskRow>,
  slots: readonly number[],
): Promise<Claim | undefined> {
  for (const slot of slots) {
    const worker = existing.find(
      (b) => b.spawnKey === backgroundWorkerSpawnKey(dispatcherBotId, slot),
    );
    if (!worker) return { kind: "spawn", slot, row: head } as const;
    if (!(await workerIsFree(tx as never, worker.id))) continue;
    const attempts = head.attempts + 1;
    await tx.backgroundTaskQueue.update({
      where: { id: head.id },
      data: {
        status: "claiming",
        workerBotId: worker.id,
        leaseOwner: PROCESS_LEASE_OWNER,
        leaseExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS),
        attempts,
        startedAt: new Date(),
      },
    });
    return { kind: "claimed", row: head, workerId: worker.id, attempts, lane } as const;
  }
  return undefined;
}

async function findTaskRow(deps: Pick<Deps, "prisma">, id: string) {
  return deps.prisma.backgroundTaskQueue.findUnique({ where: { id } });
}

/**
 * Starts queued tasks of one dispatcher, oldest first, while slots are free. Called on every
 * new task, at the start of every dispatcher turn, after a cancel and by the job reconciler,
 * so the persisted queue also drains after a restart. Returns how many queued tasks remain.
 */
export function startQueuedBackgroundTasks(
  deps: QueueDeps,
  dispatcherBotId: string,
  liveRun?: DispatchRun,
) {
  return serialized(dispatcherBotId, () => drainQueue(deps, dispatcherBotId, liveRun));
}

async function drainQueue(
  deps: QueueDeps,
  dispatcherBotId: string,
  liveRun?: DispatchRun,
  /** A task whose card the caller posts itself (the background_task call that created it). */
  announcedByCaller?: string,
) {
  await recoverBackgroundTasks(deps, { botId: dispatcherBotId }).catch((error) =>
    getLogger().error("background task recovery", error),
  );
  const bot = await deps.prisma.bot.findUnique({
    where: { id: dispatcherBotId },
    select: {
      id: true,
      name: true,
      spaceId: true,
      userId: true,
      computerId: true,
      archivedAt: true,
    },
  });
  const started: string[] = [];
  if (!bot || bot.archivedAt) return { started, remaining: 0 };
  for (let guard = 0; guard < 50; guard += 1) {
    const claim = await claimSlot(deps, bot.id, bot.spaceId);
    if (claim.kind === "none") break;
    if (claim.kind === "spawn") {
      const anchor = liveRun?.botId === bot.id ? liveRun : undefined;
      const head = claim.row;
      const spawned = await spawnBot(deps, {
        spawnedBy: { id: bot.id, name: bot.name, spaceId: bot.spaceId, userId: head.userId },
        runId: anchor?.id ?? head.runId,
        spawnKey: backgroundWorkerSpawnKey(bot.id, claim.slot),
        name: `${bot.name} · 后台${claim.slot}`.slice(0, 60),
        title: "后台工作者",
        description: `${bot.name} 的后台工作者，由 background_task 自动管理。`,
        instructions: WORKER_INSTRUCTIONS,
      }).catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }));
      if ("error" in spawned) {
        getLogger().error("background worker spawn failed", { reason: spawned.error });
        break;
      }
      continue;
    }
    const { row, workerId, attempts, lane } = claim;
    const live = liveRun && liveRun.botId === bot.id ? liveRun : undefined;
    // The run that queued this row has usually ended by now. Hand off from the dispatcher run
    // doing the drain when there is one; otherwise send on behalf of the ended source run.
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
    const a = (row.args ?? {}) as Record<string, unknown>;
    const agent = (
      String(a.agent ?? "general") in BACKGROUND_AGENT_PROFILES ? a.agent : "general"
    ) as BackgroundAgentProfile;
    let out: Awaited<ReturnType<typeof startOnSlot>>;
    try {
      out = await startOnSlot(deps, run, bot, workerId, {
        ref: row.ref ?? row.id,
        name: row.name,
        task: row.task,
        instructions: a.instructions ? String(a.instructions) : undefined,
        agent,
        disabled: Array.isArray(a.disabled) ? a.disabled.map(String) : [...WORKER_ALWAYS_DISABLED],
        attachments: Array.isArray(a.attachments) ? (a.attachments as AttachmentBlock[]) : [],
        deliveryKey: taskDeliveryKey(row, attempts),
        allowTerminalSource: sourceEnded,
        lane,
      });
    } catch (error) {
      out = { error: error instanceof Error ? error.message : String(error) };
    }
    if ("error" in out) {
      getLogger().error("queued background task failed to start", {
        queueId: row.id,
        attempts,
        reason: out.error,
      });
      // Give the slot back. The row keeps its place at the head of the queue (FIFO), or fails
      // for good after a few attempts so it cannot block the queue forever.
      const giveUp = attempts >= MAX_TASK_START_ATTEMPTS;
      await deps.prisma.backgroundTaskQueue.updateMany({
        where: { id: row.id, status: "claiming", leaseOwner: PROCESS_LEASE_OWNER },
        data: giveUp
          ? {
              status: "failed",
              error: String(out.error).slice(0, 2000),
              finishedAt: new Date(),
              leaseOwner: null,
              leaseExpiresAt: null,
            }
          : {
              status: "queued",
              startedAt: null,
              workerBotId: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              error: String(out.error).slice(0, 2000),
            },
      });
      if (giveUp) continue;
      break;
    }
    const bound = await deps.prisma.backgroundTaskQueue.updateMany({
      where: { id: row.id, status: "claiming", leaseOwner: PROCESS_LEASE_OWNER },
      data: {
        status: "started",
        workerRunId: out.runId,
        leaseOwner: null,
        leaseExpiresAt: null,
        error: null,
      },
    });
    if (bound.count === 0) {
      getLogger().warn("background task changed while starting", { queueId: row.id });
      continue;
    }
    started.push(row.id);
    getLogger().info("background task started", { queueId: row.id, worker: workerId });
    if (row.id !== announcedByCaller) {
      // Not awaited: the card is best effort and must not hold the queue lock or the launch.
      void announceQueuedTaskStart(deps, run, {
        workerId,
        name: row.name,
        ref: row.ref ?? row.id,
      });
    }
  }
  const remaining = await deps.prisma.backgroundTaskQueue.count({
    where: { botId: dispatcherBotId, status: "queued" },
  });
  return { started, remaining };
}

type StartSpec = {
  ref: string;
  name: string;
  task: string;
  instructions?: string;
  agent: BackgroundAgentProfile;
  disabled: string[];
  attachments: readonly AttachmentBlock[];
  deliveryKey: string;
  allowTerminalSource?: boolean;
  lane: BackgroundTaskLane;
};

async function startOnSlot(
  deps: QueueDeps,
  run: DispatchRun,
  bot: DispatchBot,
  workerId: string,
  spec: StartSpec,
): Promise<{ runId: string } | { error: string }> {
  const { name, task, agent, ref } = spec;
  // Per task: same computer as the dispatcher, quiet notifications, this task's tool set, plus
  // the main bot's own instructions and the tools its owner turned off.
  const settings = await workerSettingsFromMain(
    deps.prisma,
    bot.id,
    spec.lane === "think"
      ? `${WORKER_INSTRUCTIONS}\n\n${THINK_WORKER_INSTRUCTIONS}`
      : WORKER_INSTRUCTIONS,
    spec.disabled,
  );
  await deps.prisma.bot.update({
    where: { id: workerId },
    data: {
      notifyOnFinish: false,
      instructions: settings.instructions,
      // Display only (cards, the worker's own chat); results are attributed through the task row.
      title: `${name.slice(0, 70)} #${ref}`,
      description: task.slice(0, 300),
      disabledBuiltinTools: settings.disabledBuiltinTools,
      // A think worker has no computer, so its runs never wake or hold the dispatcher's.
      ...laneComputer(spec.lane, bot.computerId),
    },
  });
  // An unrelated new task starts with a fresh context: earlier tasks stay visible in the
  // worker's thread but are cut from its model history (follow-ups go via background_task_message).
  const workerThread = await deps.prisma.thread.findFirst({
    where: { botId: workerId },
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
  const sent = await messageBot(
    deps,
    run,
    { id: bot.id, name: bot.name },
    {
      bot_id: workerId,
      message: buildBackgroundTaskMessage({ name, task, instructions: spec.instructions, agent }),
      intent: "request",
      deliveryKey: spec.deliveryKey,
      // The user's uploads travel with the task: the worker's own run copies them into its
      // workspace, so the dispatcher never needs a computer for them.
      attachments: spec.attachments,
    },
    spec.allowTerminalSource ? { allowTerminalSource: true } : undefined,
  );
  if (!sent.ok) return { error: sent.error };
  if (!sent.runId) return { error: "worker run was not created" };
  return { runId: sent.runId };
}

/**
 * Job-reconciler pass: repair rows, then drain dispatchers that still have queued tasks (so
 * the queue moves even when no dispatcher turn or worker result happens).
 */
export async function reconcileBackgroundTasks(
  deps: Pick<Deps, "prisma" | "jobs"> & { events?: QueueDeps["events"] },
) {
  await recoverBackgroundTasks(deps);
  if (!deps.events) return;
  const pending = await deps.prisma.backgroundTaskQueue.findMany({
    where: { status: "queued" },
    distinct: ["botId"],
    select: { botId: true },
    take: 50,
  });
  for (const { botId } of pending) {
    await startQueuedBackgroundTasks(deps as QueueDeps, botId).catch((error) =>
      getLogger().error("background queue reconcile drain", error),
    );
  }
}

/** Resolves a task_id: the task ref ("T1AB2C3D", "#T1AB2C3D"), "q:<row id>", or a row id. */
async function resolveTask(deps: Pick<Deps, "prisma">, botId: string, wanted: string) {
  const id = wanted.trim().replace(/^#/, "");
  if (!id) return null;
  if (id.startsWith("q:"))
    return deps.prisma.backgroundTaskQueue.findFirst({ where: { botId, id: id.slice(2) } });
  return (
    (await deps.prisma.backgroundTaskQueue.findFirst({
      where: { botId, ref: id.toUpperCase() },
      orderBy: { createdAt: "desc" },
    })) ?? (await deps.prisma.backgroundTaskQueue.findFirst({ where: { botId, id } }))
  );
}

const RECENT_TASK_MS = 30 * 60_000;

export async function backgroundTaskStatus(
  deps: Pick<Deps, "prisma">,
  run: DispatchRun,
  bot: DispatchBot,
  args: Record<string, unknown>,
) {
  // Times go out in the user's zone (else the owner's or deployment's), with the offset shown.
  const zone = await resolveRunTimeZone(deps.prisma as never, run);
  const wanted = args.task_id ? String(args.task_id) : undefined;
  const rows = wanted
    ? [await resolveTask(deps, bot.id, wanted)].filter((row) => row !== null)
    : await deps.prisma.backgroundTaskQueue.findMany({
        where: {
          botId: bot.id,
          OR: [
            { status: { in: ACTIVE_TASK_STATUSES } },
            { finishedAt: { gte: new Date(Date.now() - RECENT_TASK_MS) } },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: 30,
      });
  if (wanted && rows.length === 0) return { error: "no background task with that task_id" };
  const queuedOrder = laneQueueOrder(await queuedTasks(deps, bot.id));
  const tasks = await Promise.all(
    rows.map(async (row) => {
      const workerRun = row.workerRunId
        ? await deps.prisma.run.findUnique({
            where: { id: row.workerRunId },
            select: { status: true, createdAt: true, completedAt: true, error: true },
          })
        : null;
      const worker = row.workerBotId
        ? await deps.prisma.bot.findUnique({
            where: { id: row.workerBotId },
            select: { thread: { select: { id: true } } },
          })
        : null;
      const last =
        worker?.thread && row.status === "started"
          ? await deps.prisma.message.findFirst({
              where: { threadId: worker.thread.id, role: { not: "user" } },
              orderBy: { seq: "desc" },
              select: { blocks: true },
            })
          : null;
      const activity =
        row.status === "started" && row.workerRunId
          ? await workerActivityFields(deps.prisma, row.workerRunId, zone)
          : {};
      const state =
        row.status === "queued"
          ? "queued"
          : row.status === "claiming"
            ? "starting"
            : row.status === "started"
              ? workerRun && ACTIVE_RUN_STATUSES.includes(workerRun.status as never)
                ? workerRun.status
                : "finishing"
              : row.status;
      const finishedAt = row.finishedAt ?? workerRun?.completedAt ?? undefined;
      const pending =
        row.status === "started" ? workerPending(workerRun?.status, last?.blocks) : undefined;
      return {
        task_id: row.ref ?? row.id,
        name: row.name,
        task: row.task.slice(0, 300),
        state: pending ? "needs_user" : state,
        ...(pending ? { pending } : {}),
        lane: laneOfTask(row),
        ...(row.status === "queued" ? { position: queuedOrder.get(row.id) ?? 1 } : {}),
        queued_at: formatInstantForUser(row.createdAt, zone),
        started_at: row.startedAt ? formatInstantForUser(row.startedAt, zone) : undefined,
        finished_at:
          finishedAt && !ACTIVE_TASK_STATUSES.includes(row.status)
            ? formatInstantForUser(finishedAt, zone)
            : undefined,
        last_progress: lastText(last?.blocks),
        ...activity,
        ...(row.error || workerRun?.error
          ? { error: String(row.error ?? workerRun?.error).slice(0, 500) }
          : {}),
      };
    }),
  );
  return {
    ok: true as const,
    limit: laneLimit("computer"),
    think_limit: laneLimit("think"),
    tasks,
    time_zone: zone ?? "UTC",
    note: `Each task runs in a lane (computer or think); limit is the computer lane's, think_limit the think lane's, and position is the place in that task's own lane queue. Times above are in ${zone ?? "UTC"}; quote them to the user with that offset label, never as bare UTC unless the zone is UTC. task_id is the task's #ref. Only state "done" for a task whose state is completed here or whose result you received; running/queued/starting/finishing tasks are not done. Routing: send a new request to an existing task_id with background_task_message only when, by its meaning, it continues that same task's work or deliverable (a follow-up, correction or change to it). A request about a different subject or deliverable is new work: start a new background_task, even if a worker is idle. When unsure, start a new background_task. ${WORKER_ACTIVITY_NOTE} ${WORKER_NEEDS_USER_NOTE}`,
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

const STEERABLE_RUN_STATUSES = ["queued", "leased", "running"];

export async function backgroundTaskMessage(
  deps: QueueDeps,
  run: DispatchRun,
  bot: DispatchBot,
  args: Record<string, unknown>,
  deliveryKey: string,
) {
  return serialized(bot.id, () => backgroundTaskMessageNow(deps, run, bot, args, deliveryKey));
}

async function backgroundTaskMessageNow(
  deps: QueueDeps,
  run: DispatchRun,
  bot: DispatchBot,
  args: Record<string, unknown>,
  deliveryKey: string,
) {
  const text = String(args.message ?? "").trim();
  if (!text) return { error: "message is empty" };
  const row = await resolveTask(deps, bot.id, String(args.task_id ?? ""));
  if (!row) return { error: "no background task with that task_id (check background_task_status)" };
  const taskId = row.ref ?? row.id;
  if (row.status === "queued") {
    // CAS on the status and the text we read: a drain that claimed it meanwhile wins, and the
    // change then goes to the started task below instead of into a row nobody reads again.
    const updated = await deps.prisma.backgroundTaskQueue.updateMany({
      where: { id: row.id, status: "queued", task: row.task },
      data: { task: `${row.task}\n\n[补充/改向指令]\n${text}`.slice(0, 20_000) },
    });
    if (updated.count === 1)
      return {
        ok: true as const,
        task_id: taskId,
        note: "Queued task updated; it starts with this change.",
      };
    const fresh = await findTaskRow(deps, row.id);
    if (!fresh || fresh.status === "queued")
      return {
        error: "the queued task changed at the same time; call background_task_message again",
      };
    return backgroundTaskMessageNow(deps, run, bot, args, deliveryKey);
  }
  if (row.status === "claiming")
    return {
      error:
        "this task is being handed to a worker right now; send the change again in a few seconds",
    };
  if (row.status === "cancelled")
    return { error: "this task was cancelled; start a new background_task" };
  if (!row.workerBotId)
    return { error: "this task never reached a worker; start a new background_task" };
  const workerId = row.workerBotId;
  if (alreadySentThisTurn(run.id, workerId, text))
    return {
      ok: true as const,
      task_id: taskId,
      note: "Already sent this to the worker in this turn; not sent again. Reply to the user once and end the turn.",
    };
  const worker = await deps.prisma.bot.findUnique({
    where: { id: workerId },
    select: { id: true, thread: { select: { id: true } } },
  });
  if (!worker?.thread) return { error: "that task's worker is no longer available" };
  const threadId = worker.thread.id;
  const block: MessageBlock = {
    kind: "bot_message_received",
    fromBotId: bot.id,
    fromBotName: bot.name,
    text: `[来自 ${bot.name} 的补充/改向指令]\n${text}`,
    intent: "request",
  };
  // Steer the live run under a row lock on it, so the run cannot finish between the check and
  // the write. A queued or leased run takes it too (merged, picked up on its first steps); a
  // run that finishes later hands unclaimed steering to a continuation run, never drops it.
  const steered = await deps.prisma.$transaction(async (tx) => {
    const active = await tx.run.findFirst({
      where: { botId: workerId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!active) return { kind: "idle" } as const;
    const locked = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM runs WHERE id = ${active.id} FOR UPDATE`;
    const status = locked[0]?.status;
    if (status === "waiting_input" || status === "waiting_takeover")
      return { kind: "waiting" } as const;
    if (!status || !STEERABLE_RUN_STATUSES.includes(status)) return { kind: "retry" } as const;
    const message = await createThreadMessageInTransaction(tx, {
      threadId,
      role: "user",
      blocks: [block],
      runId: active.id,
    });
    await tx.steeringMessage.create({
      data: { messageId: message.id, botId: workerId, userId: run.userId, runId: active.id },
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId,
      botId: workerId,
      type: "thread.message.created",
      runId: active.id,
      payload: { messageId: message.id, role: "user", blocks: message.blocks },
    });
    if (row.workerRunId !== active.id) {
      await tx.backgroundTaskQueue.updateMany({
        where: { id: row.id, workerBotId: workerId },
        data: { workerRunId: active.id, status: "started", finishedAt: null },
      });
    }
    return { kind: "steered", seq: event.seq } as const;
  });
  if (steered.kind === "steered") {
    await deps.events.notify(threadId, steered.seq).catch(() => undefined);
    return {
      ok: true as const,
      task_id: taskId,
      note: "Delivered to the running worker; it sees it on its next step.",
    };
  }
  if (steered.kind === "waiting")
    return {
      error:
        "the worker is waiting on the user (its approval card is in this chat); it cannot take a change now. Tell the user to approve or deny it on that card; never approve or deny for them.",
    };
  if (steered.kind === "retry") return backgroundTaskMessageNow(deps, run, bot, args, deliveryKey);
  // The worker is idle: resume this task on it with its context, unless the slot has already
  // been handed to another task (then its context is gone; a new task must carry what it needs).
  const reclaimed = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${bot.id} FOR UPDATE`;
    const other = await tx.backgroundTaskQueue.findFirst({
      where: { workerBotId: workerId, status: { in: SLOT_HOLDING_STATUSES }, id: { not: row.id } },
      select: { id: true },
    });
    const later = await tx.backgroundTaskQueue.findFirst({
      where: {
        workerBotId: workerId,
        id: { not: row.id },
        startedAt: { gt: row.startedAt ?? row.createdAt },
      },
      select: { id: true },
    });
    if (other || later) return false;
    await tx.backgroundTaskQueue.update({
      where: { id: row.id },
      data: { status: "started", finishedAt: null, error: null },
    });
    return true;
  });
  if (!reclaimed)
    return {
      error:
        "that task's worker has since been reused for another task, so its context is gone; start a new background_task and include what it needs from the earlier result",
    };
  const sent = await messageBot(
    deps,
    run,
    { id: bot.id, name: bot.name },
    // Never fyi: an idle worker treats this as a new request and its result always comes back.
    { bot_id: workerId, message: text, intent: "request", deliveryKey },
  );
  if (!sent.ok || !sent.runId) {
    await deps.prisma.backgroundTaskQueue.updateMany({
      where: { id: row.id, status: "started", workerRunId: row.workerRunId },
      data: { status: row.status, finishedAt: row.finishedAt },
    });
    return { error: sent.ok ? "worker run was not created" : sent.error };
  }
  await deps.prisma.backgroundTaskQueue.updateMany({
    where: { id: row.id },
    data: { workerRunId: sent.runId },
  });
  return {
    ok: true as const,
    task_id: taskId,
    note: "Worker was idle; it resumes this task with this as a new request and its result comes back to you as a message.",
  };
}

/**
 * Stops one task (task_id or its name) or every task of this bot (task_id "all"). Uses the
 * same path as stopping a run: runs flip to cancelled (the worker's executor aborts its model
 * call, tools and MCP polling when it sees that), its shell processes are killed on the
 * computer, and the screen and lease are released.
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
  const wanted = String(args.task_id ?? "").trim();
  if (!wanted) return { error: 'task_id is required (a task\'s #ref, its name, or "all")' };
  const active = await deps.prisma.backgroundTaskQueue.findMany({
    where: { botId: bot.id, status: { in: ACTIVE_TASK_STATUSES } },
    orderBy: { createdAt: "asc" },
  });
  const needle = wanted.toLowerCase();
  let targets: typeof active;
  if (wanted === "all") targets = active;
  else {
    const byId = await resolveTask(deps, bot.id, wanted);
    targets = byId
      ? [byId]
      : active.filter(
          (row) =>
            row.name.toLowerCase() === needle || taskTitle(row.name).toLowerCase() === needle,
        );
  }
  const cancelledQueued: Array<{ task_id: string; name: string }> = [];
  const cancelled: Array<{ task_id: string; name: string; cancelled_runs: number }> = [];
  const workers = await workerBots(deps, bot.id, run.spaceId);
  for (const row of targets) {
    const taskId = row.ref ?? row.id;
    if (!ACTIVE_TASK_STATUSES.includes(row.status)) {
      cancelled.push({ task_id: taskId, name: row.name, cancelled_runs: 0 });
      continue;
    }
    const done = await deps.prisma.backgroundTaskQueue.updateMany({
      where: { id: row.id, status: { in: ACTIVE_TASK_STATUSES } },
      data: { status: "cancelled", finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
    });
    if (!done.count) continue;
    if (row.status === "queued") {
      cancelledQueued.push({ task_id: taskId, name: row.name });
      continue;
    }
    const worker = workers.find((w) => w.id === row.workerBotId);
    const runIds = worker?.thread
      ? (
          await stop(
            { spaceId: run.spaceId, userId: run.userId },
            { threadId: worker.thread.id, botIds: [worker.id] },
          )
        ).runIds
      : [];
    cancelled.push({ task_id: taskId, name: row.name, cancelled_runs: runIds.length });
  }
  if (wanted === "all") {
    // Workers running work no task row tracks (started before task rows existed).
    for (const worker of workers) {
      if (!worker.thread || targets.some((row) => row.workerBotId === worker.id)) continue;
      const live = await deps.prisma.run.findFirst({
        where: { botId: worker.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
        select: { id: true },
      });
      if (!live) continue;
      const { runIds } = await stop(
        { spaceId: run.spaceId, userId: run.userId },
        { threadId: worker.thread.id, botIds: [worker.id] },
      );
      cancelled.push({
        task_id: worker.id,
        name: taskTitle(worker.title || withoutWorkerSlot(worker.name)),
        cancelled_runs: runIds.length,
      });
    }
  }
  if (cancelled.length === 0 && cancelledQueued.length === 0) {
    return wanted === "all"
      ? { ok: true as const, cancelled: [], note: "no background tasks" }
      : { error: "no background task with that task_id" };
  }
  getLogger().info("background task cancelled", {
    runId: run.id,
    tasks: [...cancelled, ...cancelledQueued].map((c) => c.task_id),
    ms: Date.now() - startedAt,
  });
  // Freed slots go to the next queued tasks (unless everything was cancelled).
  const queuedBefore = (await queuedTasks(deps, bot.id)).map((row) => row.id);
  if (wanted !== "all") await startQueuedBackgroundTasks(deps, bot.id, run).catch(() => undefined);
  return {
    ok: true as const,
    cancelled,
    cancelled_queued: cancelledQueued,
    ...(await queueChangeAfterCancel(deps.prisma, bot.id, queuedBefore)),
    note: `Tell the user exactly which tasks were stopped (cancelled_runs > 0) and which queued ones were removed. A task with cancelled_runs 0 had already finished or was idle: say so instead of claiming you stopped it.${QUEUE_AFTER_CANCEL_NOTE}`,
  };
}

async function queuedTasks(deps: Pick<Deps, "prisma">, botId: string) {
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

export { recoverBackgroundTasks } from "./background-task-recovery.js";
export {
  backgroundTaskForWorkerRun,
  finalizeBackgroundTaskForRun,
  MAX_TASK_START_ATTEMPTS,
} from "./background-task-rows.js";
export { backgroundTaskHash, newTaskRef, taskTitle } from "./task-identity.js";
export {
  BACKGROUND_TASK_TOOL_NAMES,
  workerDisabledTools,
  workerToolSurface,
} from "./worker-tool-policy.js";
