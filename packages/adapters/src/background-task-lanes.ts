import type { PrismaClient } from "@rakazo/db";
import { HIDDEN_BOT_SPAWN_PREFIX } from "@rakazo/db";
import { SLOT_HOLDING_STATUSES } from "./background-task-rows.js";

/*
 * Two lanes of background work per dispatcher bot:
 *   computer  the worker shares the dispatcher's computer (shell, browser, desktop, files). The
 *             existing lane: RAKAZO_BACKGROUND_TASKS_PER_BOT (default 4, at most 10) at once.
 *   think     the worker only thinks: model, web_search/web_fetch, memory, history, skills and
 *             connector (server-side) tools. It has no computer at all, so it never wakes the
 *             computer or holds it awake. RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT (default 20, at
 *             most 20; 0 turns the lane off and every task runs in the computer lane).
 * The lane is stored in the task row's args (args.lane); a row without one is a computer task,
 * so every row from before lanes keeps its meaning. Each lane is its own FIFO queue.
 *
 * Slots: one hidden worker bot per slot, as before. Computer slots are 1..N (the existing
 * workers, unchanged); think slots are THINK_SLOT_BASE+1..THINK_SLOT_BASE+M, so a slot's lane
 * is fixed by its spawn key. Both keep the "bg-worker:<botId>:<n>" key and "<bot> · 后台<n>"
 * name, so every hidden-bot check, worker lookup and slot-name filter covers both lanes as is.
 */

export type BackgroundTaskLane = "computer" | "think";
export const BACKGROUND_TASK_LANES: readonly BackgroundTaskLane[] = ["computer", "think"];

/** Think slots start above the computer lane's highest possible slot (10). */
export const THINK_SLOT_BASE = 100;
export const MAX_COMPUTER_TASKS_PER_BOT = 10;
export const MAX_THINK_TASKS_PER_BOT = 20;

type Env = Record<string, string | undefined>;

function envLimit(raw: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(raw?.trim() || Number.NaN);
  return Number.isFinite(parsed) && parsed >= min ? Math.min(max, Math.floor(parsed)) : fallback;
}

/** Computer-lane workers per bot (RAKAZO_BACKGROUND_TASKS_PER_BOT, default 4, at most 10). */
export function backgroundTaskConcurrency(env: Env = process.env) {
  return envLimit(env.RAKAZO_BACKGROUND_TASKS_PER_BOT, 4, 1, MAX_COMPUTER_TASKS_PER_BOT);
}

/** Think-lane workers per bot (RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT, default 20, 0 = off). */
export function thinkTaskConcurrency(env: Env = process.env) {
  return envLimit(env.RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT, 20, 0, MAX_THINK_TASKS_PER_BOT);
}

export function laneLimit(lane: BackgroundTaskLane, env: Env = process.env) {
  return lane === "think" ? thinkTaskConcurrency(env) : backgroundTaskConcurrency(env);
}

/** The lane's slot numbers, in the order they are filled. */
export function laneSlots(lane: BackgroundTaskLane, env: Env = process.env): number[] {
  const base = lane === "think" ? THINK_SLOT_BASE : 0;
  return Array.from({ length: laneLimit(lane, env) }, (_, i) => base + i + 1);
}

export function slotLane(slot: number): BackgroundTaskLane {
  return slot > THINK_SLOT_BASE ? "think" : "computer";
}

/** The lane a task row runs in. Rows without a lane (all rows from before lanes) are computer. */
export function laneOfTask(row: { args?: unknown }): BackgroundTaskLane {
  const args = row.args;
  return args && typeof args === "object" && (args as { lane?: unknown }).lane === "think"
    ? "think"
    : "computer";
}

/**
 * The lane a task queues and runs in now: its own, except that think tasks run in the computer
 * lane while the think lane is turned off (so rows queued before it was turned off still start).
 */
export function effectiveLane(row: { args?: unknown }, env: Env = process.env): BackgroundTaskLane {
  return laneOfTask(row) === "think" && thinkTaskConcurrency(env) > 0 ? "think" : "computer";
}

/** The oldest queued task of each lane (rows oldest first), with that lane's slots. */
export function laneHeads<T extends { args?: unknown }>(
  queued: readonly T[],
  env: Env = process.env,
): { lane: BackgroundTaskLane; head: T; slots: number[] }[] {
  const heads: { lane: BackgroundTaskLane; head: T; slots: number[] }[] = [];
  for (const lane of BACKGROUND_TASK_LANES) {
    const head = queued.find((row) => effectiveLane(row, env) === lane);
    if (head) heads.push({ lane, head, slots: laneSlots(lane, env) });
  }
  return heads;
}

/** Each queued task's 1-based place in its own lane's queue (rows oldest first). */
export function laneQueueOrder<T extends { id: string; args?: unknown }>(
  queued: readonly T[],
  env: Env = process.env,
): Map<string, number> {
  const counts = { computer: 0, think: 0 };
  const order = new Map<string, number>();
  for (const row of queued) {
    const lane = effectiveLane(row, env);
    counts[lane] += 1;
    order.set(row.id, counts[lane]);
  }
  return order;
}

/** A queued task's place in its lane's queue, and how many tasks of that lane hold a slot. */
export async function laneQueuePosition(
  prisma: Pick<PrismaClient, "backgroundTaskQueue">,
  botId: string,
  row: { id: string; args?: unknown },
  env: Env = process.env,
) {
  const lane = effectiveLane(row, env);
  const [queued, holding] = await Promise.all([
    prisma.backgroundTaskQueue.findMany({
      where: { botId, status: "queued" },
      orderBy: { createdAt: "asc" },
      select: { id: true, args: true },
    }),
    prisma.backgroundTaskQueue.findMany({
      where: { botId, status: { in: SLOT_HOLDING_STATUSES } },
      select: { id: true, args: true },
    }),
  ]);
  return {
    lane,
    position: laneQueueOrder(queued, env).get(row.id) ?? 1,
    busy: holding.filter((held) => effectiveLane(held, env) === lane).length,
  };
}

/** The computer a worker gets for a task: the dispatcher's, or none at all in the think lane. */
export function laneComputer(lane: BackgroundTaskLane, dispatcherComputerId?: string | null) {
  if (lane === "think") return { computerId: null };
  return dispatcherComputerId ? { computerId: dispatcherComputerId } : {};
}

/**
 * The lane a new background_task call asks for. Missing or empty is computer (the safe default);
 * with the think lane turned off a think request runs in the computer lane.
 */
export function requestedLane(
  raw: unknown,
  env: Env = process.env,
): { lane: BackgroundTaskLane } | { error: string } {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
  if (value === undefined || value === null || value === "" || value === "computer")
    return { lane: "computer" };
  if (value !== "think") return { error: 'lane must be "think" or "computer"' };
  return { lane: thinkTaskConcurrency(env) > 0 ? "think" : "computer" };
}

/** The slot number of a background worker's spawn key ("bg-worker:<botId>:<n>"). */
export function workerSlotOfSpawnKey(spawnKey: string | null | undefined): number | undefined {
  if (!spawnKey?.startsWith(HIDDEN_BOT_SPAWN_PREFIX)) return undefined;
  const match = /:(\d+)$/.exec(spawnKey.slice(HIDDEN_BOT_SPAWN_PREFIX.length));
  return match ? Number(match[1]) : undefined;
}

/** Whether a bot is a think-lane background worker (no computer, no computer tools). */
export function isThinkWorker(bot: { spawnKey?: string | null }): boolean {
  const slot = workerSlotOfSpawnKey(bot.spawnKey);
  return slot !== undefined && slotLane(slot) === "think";
}

/**
 * Builtin tools that run on (or wake) the computer. A think worker never gets them: they are
 * disabled on the worker and refused if called anyway. Media generation is here too: its files
 * reach the user through the computer lane's file hand-off.
 */
export const THINK_LANE_WITHHELD_TOOLS = [
  "computer_observe",
  "computer_act",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "list_files",
  "read_file",
  "write_file",
  "attach_file",
  "shell",
  "open_path",
  "launch_app",
  "request_takeover",
  "render_plot",
  "generate_image",
  "generate_video",
] as const;

const WITHHELD = new Set<string>(THINK_LANE_WITHHELD_TOOLS);

/** Adds the computer tools to a think worker's disabled set; other bots are untouched. */
export function withholdComputerToolsFromThinkWorker(
  bot: { spawnKey?: string | null },
  disabled: Set<string>,
): void {
  if (isThinkWorker(bot)) for (const name of THINK_LANE_WITHHELD_TOOLS) disabled.add(name);
}

/** A task's disabled tools for its lane: a think task also loses every computer tool. */
export function laneDisabledTools(
  lane: BackgroundTaskLane,
  disabled: readonly string[],
  builtinToolNames: readonly string[],
): string[] {
  if (lane !== "think") return [...disabled];
  const all = new Set(disabled);
  for (const name of THINK_LANE_WITHHELD_TOOLS) if (builtinToolNames.includes(name)) all.add(name);
  return [...all].sort();
}

export const THINK_WORKER_COMPUTER_REFUSAL =
  "这是思考任务（think lane），没有电脑：不能用 shell、浏览器、桌面、文件或其他电脑工具。不要再尝试。把你已经得出的结论整理成结果返回，第一行写「需要电脑：<原因>」，主 bot 会把任务改成电脑任务重新派发。";

/** The tool error a think worker gets when it calls a computer tool anyway. */
export function thinkWorkerToolRefusal(
  bot: { spawnKey?: string | null },
  toolName: string,
): string | undefined {
  return isThinkWorker(bot) && WITHHELD.has(toolName) ? THINK_WORKER_COMPUTER_REFUSAL : undefined;
}

/** Appended to a think worker's instructions. */
export const THINK_WORKER_INSTRUCTIONS =
  "【思考任务】你没有电脑：没有 shell、浏览器、桌面、文件工具，也看不到电脑上的文件。只用推理、web_search / web_fetch、记忆和已连接的应用完成任务。如果做到一半发现必须用电脑（跑代码、打开或生成文件、操作网页/桌面），立刻停下，把已有发现作为结果返回，第一行写「需要电脑：<原因>」，主 bot 会改派给电脑任务。上面关于电脑工作区文件和「文件：」列表的说明对你不适用；报告、方案这类成文材料用 write_page 写成页面（页面不需要电脑），短结果直接写在回复里。";

/** Appended to the dispatcher's background_task guidance. */
export const BACKGROUND_LANE_GUIDANCE =
  'Every background_task has a lane. lane "think" is for work that needs no computer: reasoning, writing, planning, translation, summarizing text already in the chat, analysis, and research with web_search/web_fetch or connected apps. A think worker has no shell, browser, desktop or files, never wakes the computer, and many can run at once. lane "computer" (the default) is for everything that touches the computer: shell or code, files or the user\'s uploads (PDFs, spreadsheets, images to process), browser or desktop work, generating images, video or charts, or anything that must save a file. When unsure, use "computer". If a think task\'s result starts with "需要电脑", start a new background_task with lane "computer" for the same work, passing on its findings, without asking the user. Queue positions are per lane.';
