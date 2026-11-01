import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { SandboxUnresponsiveError } from "@rakazo/adapter-kit";
import { COMPUTER_KEEP_ACTION, COMPUTER_RESTART_ACTION } from "@rakazo/core";
import type { ComputerMainChat, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  countComputerUnresponsive,
  findComputerMainChat,
  postComputerNotice,
  postComputerRestartPrompt,
  readComputerHealth,
  settleComputerRestartPrompt,
  updateComputerHealth,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isSandboxGoneError } from "./sandbox-errors.js";

/*
 * Computer health, checked from the idle-sleep job so it costs no extra wake-ups:
 * - a disk/memory reading at most every RESOURCE_CHECK_INTERVAL_MS; crossing a threshold posts
 *   one notice in the owner's main chat, repeated only for a new resource or after a day;
 * - a count of failed checks in a row (a checkpoint or stop that hung or found the sandbox
 *   unresponsive, or a reading that did not come back). At RESTART_PROMPT_AFTER failures the
 *   main chat gets a card asking whether to restart the computer from its last save. Only the
 *   owner's "restart" answer restarts it (see apps/api computer-restart-answer.ts); no approval
 *   setting skips the question. Any success resets the count and closes an open card.
 * Everything here is best effort: a failure is logged and never fails the sleep job.
 */

/** The sleep job's checkpoint gives up after this long and reports the sandbox unresponsive. */
export const COMPUTER_CHECKPOINT_DEADLINE_MS = 20 * 60 * 1000;
/** Pausing the sandbox gives up after this long. */
export const COMPUTER_STOP_DEADLINE_MS = 5 * 60 * 1000;
/**
 * A "suspending" claim older than this belongs to a sleep job that died or hung: past both
 * deadlines with room to spare, so the next sleep job takes the computer back to "running".
 */
export const SUSPEND_CLAIM_STALE_MS =
  COMPUTER_CHECKPOINT_DEADLINE_MS + COMPUTER_STOP_DEADLINE_MS + 5 * 60 * 1000;

export const RESOURCE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
export const RESOURCE_PROBE_TIMEOUT_MS = 10_000;
const RESOURCE_PROBE_DEADLINE_MS = 20_000;
/** Usage at or above this percent posts a notice. */
export const RESOURCE_ALERT_PERCENT = 90;
/** A resource must fall below this percent before crossing the threshold notifies again. */
export const RESOURCE_REARM_PERCENT = 85;
export const RESOURCE_REALERT_MS = 24 * 60 * 60 * 1000;
/** Failed checks in a row before the owner is asked whether to restart. */
export const RESTART_PROMPT_AFTER = 3;
/** After a card was posted (and answered or not), no new one for this long. */
export const RESTART_REPROMPT_MS = 24 * 60 * 60 * 1000;

export type ComputerHealthDeps = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  events: Pick<ThreadEvents, "notify">;
};

type HealthComputer = { id: string; spaceId: string; kind: string };

/** Runs `work` with an abort signal; past `ms` aborts it and rejects with `timeout()`. */
export async function withDeadline<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
  timeout: () => Error,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeout());
    }, ms);
  });
  const running = work(controller.signal);
  // The abandoned work may still settle later; its result no longer matters.
  running.catch(() => undefined);
  try {
    return await Promise.race([running, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export class ComputerDeadlineError extends SandboxUnresponsiveError {
  constructor(step: "checkpoint" | "stop" | "health", ms: number) {
    super(`computer ${step} did not finish within ${Math.round(ms / 1000)} s`);
  }
}

/** The probe prints "disk <used%> <availableKiB>" and "mem <totalKiB> <availableKiB>". */
export const RESOURCE_PROBE = [
  "set -u",
  'df -Pk . 2>/dev/null | awk \'NR==2 { sub(/%/, "", $5); print "disk", $5, $4 }\'',
  "awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } END { print \"mem\", t, a }' /proc/meminfo",
].join("\n");

export type ResourceReading = {
  diskPercent: number | null;
  diskAvailableKiB: number | null;
  memoryPercent: number | null;
};

export function parseResourceProbe(stdout: string): ResourceReading {
  const reading: ResourceReading = {
    diskPercent: null,
    diskAvailableKiB: null,
    memoryPercent: null,
  };
  for (const line of stdout.split("\n")) {
    const [kind, a, b] = line.trim().split(/\s+/);
    const first = Number(a);
    const second = Number(b);
    if (kind === "disk" && Number.isFinite(first) && a !== "") {
      reading.diskPercent = Math.max(0, Math.min(100, Math.round(first)));
      reading.diskAvailableKiB = Number.isFinite(second) && b !== undefined ? second : null;
    }
    if (kind === "mem" && first > 0 && Number.isFinite(second) && b !== undefined) {
      reading.memoryPercent = Math.max(0, Math.min(100, Math.round((1 - second / first) * 100)));
    }
  }
  return reading;
}

type Resource = "disk" | "memory";

function parseResources(value: string | null | undefined): Set<Resource> {
  return new Set(
    (value ?? "")
      .split(",")
      .filter((item): item is Resource => item === "disk" || item === "memory"),
  );
}

/**
 * What a reading changes about the notice: the resources still counted as alerted (one leaves
 * once it falls under RESOURCE_REARM_PERCENT) and which ones to announce now.
 */
export function resourceAlertDecision(
  reading: ResourceReading,
  previous: { alertedResources: string | null; alertedAt: Date | null },
  now: Date,
): { alerted: Set<Resource>; announce: Resource[] } {
  const percent: Record<Resource, number | null> = {
    disk: reading.diskPercent,
    memory: reading.memoryPercent,
  };
  const before = parseResources(previous.alertedResources);
  const alerted = new Set<Resource>();
  const over: Resource[] = [];
  for (const resource of ["disk", "memory"] as const) {
    const value = percent[resource];
    if (value === null) {
      // No reading for it this time: keep what was known.
      if (before.has(resource)) alerted.add(resource);
      continue;
    }
    if (value >= RESOURCE_ALERT_PERCENT) over.push(resource);
    if (
      value >= RESOURCE_ALERT_PERCENT ||
      (before.has(resource) && value >= RESOURCE_REARM_PERCENT)
    )
      alerted.add(resource);
  }
  const stale =
    !previous.alertedAt || now.getTime() - previous.alertedAt.getTime() >= RESOURCE_REALERT_MS;
  const fresh = over.filter((resource) => !before.has(resource));
  const announce = fresh.length ? over : stale ? over : [];
  return { alerted, announce };
}

function gigabytes(kib: number): string {
  const gb = kib / (1024 * 1024);
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

export function resourceNoticeText(reading: ResourceReading, resources: Resource[]): string {
  const parts: string[] = [];
  if (resources.includes("disk") && reading.diskPercent !== null) {
    const left =
      reading.diskAvailableKiB !== null ? `，只剩约 ${gigabytes(reading.diskAvailableKiB)}` : "";
    parts.push(
      `磁盘已用 ${reading.diskPercent}%${left}。满了之后保存和新文件都会失败，可以让我清理不需要的文件（缓存、旧下载、构建产物等）。`,
    );
  }
  if (resources.includes("memory") && reading.memoryPercent !== null) {
    parts.push(
      `内存已用 ${reading.memoryPercent}%。电脑可能变慢，程序也可能被系统强制结束，可以让我关掉不用的程序或浏览器标签页。`,
    );
  }
  return `电脑资源快不够了：${parts.join("")}`;
}

async function mainChat(deps: ComputerHealthDeps, computerId: string) {
  return findComputerMainChat(deps.prisma, computerId);
}

async function notice(deps: ComputerHealthDeps, chat: ComputerMainChat, text: string) {
  const event = await postComputerNotice(deps.prisma, chat, text);
  await deps.events.notify(event.threadId, event.seq).catch(() => undefined);
}

/** "约 3 小时前": how long ago the last save was, for the restart card. */
export function savedAgoText(savedAt: Date | null, now: Date): string {
  if (!savedAt) return "上次保存的时间不详";
  const minutes = Math.max(0, Math.round((now.getTime() - savedAt.getTime()) / 60_000));
  if (minutes < 1) return "刚刚保存过";
  if (minutes < 60) return `约 ${minutes} 分钟前保存`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `约 ${hours} 小时前保存`;
  return `约 ${Math.round(hours / 24)} 天前保存`;
}

export function restartPromptContent(savedAt: Date | null, now: Date) {
  return {
    text: `电脑连续 ${RESTART_PROMPT_AFTER} 次没有响应，要重启吗？`,
    detail: [
      `重启会把电脑恢复到上次保存的状态（${savedAgoText(savedAt, now)}）。`,
      "这之后的改动可能会丢失，正在进行的任务也会被中断。",
      "只有你点「重启电脑」才会重启；先不重启的话，电脑恢复响应后这张卡片会自动失效。",
    ].join("\n"),
    actions: [
      { id: COMPUTER_RESTART_ACTION, label: "重启电脑" },
      { id: COMPUTER_KEEP_ACTION, label: "先不重启" },
    ],
  };
}

/**
 * One more failed check in a row. At RESTART_PROMPT_AFTER, asks the owner in the main chat
 * whether to restart, unless a card is open or one was posted within RESTART_REPROMPT_MS.
 */
export async function recordComputerUnresponsive(
  deps: ComputerHealthDeps,
  computer: HealthComputer,
  reason: string,
  now = new Date(),
): Promise<void> {
  try {
    const count = await countComputerUnresponsive(deps.prisma, {
      computerId: computer.id,
      spaceId: computer.spaceId,
    });
    getLogger().warn("computer.health_unresponsive", {
      "computer.id": computer.id,
      provider: computer.kind,
      reason,
      count,
    });
    if (count < RESTART_PROMPT_AFTER) return;
    const health = await readComputerHealth(deps.prisma, computer.id);
    if (
      health?.restartPromptedAt &&
      now.getTime() - health.restartPromptedAt.getTime() < RESTART_REPROMPT_MS
    )
      return;
    const chat = await mainChat(deps, computer.id);
    if (!chat) return;
    const saved = await deps.prisma.computer.findUnique({
      where: { id: computer.id },
      select: { homeRevisionAt: true },
    });
    const posted = await postComputerRestartPrompt(deps.prisma, {
      chat,
      computerId: computer.id,
      ...restartPromptContent(saved?.homeRevisionAt ?? null, now),
    });
    if (!posted) return;
    getLogger().info("computer.restart_prompted", { "computer.id": computer.id, count });
    await deps.events.notify(posted.threadId, posted.seq).catch(() => undefined);
  } catch (error) {
    getLogger().error("computer.health_record_failed", error);
  }
}

/** A check succeeded: resets the failure count and closes an open restart card. */
export async function recordComputerResponsive(
  deps: ComputerHealthDeps,
  computer: HealthComputer,
): Promise<void> {
  try {
    const health = await readComputerHealth(deps.prisma, computer.id);
    if (!health || (health.unresponsiveCount === 0 && !health.restartMessageId)) return;
    await updateComputerHealth(deps.prisma, {
      computerId: computer.id,
      spaceId: computer.spaceId,
      data: { unresponsiveCount: 0, restartMessageId: null, restartThreadId: null },
    });
    if (health.restartMessageId && health.restartThreadId) {
      const closed = await settleComputerRestartPrompt(deps.prisma, {
        spaceId: computer.spaceId,
        threadId: health.restartThreadId,
        messageId: health.restartMessageId,
        settle: { closed: "recovered" },
      });
      if (closed) await deps.events.notify(closed.threadId, closed.seq).catch(() => undefined);
    }
  } catch (error) {
    getLogger().error("computer.health_record_failed", error);
  }
}

async function readResources(
  deps: ComputerHealthDeps,
  ref: ComputerRef,
  ctx: AdapterContext,
): Promise<ResourceReading | "gone" | "failed"> {
  try {
    return await withDeadline(
      RESOURCE_PROBE_DEADLINE_MS,
      async (signal) => {
        let stdout = "";
        let exitCode: number | undefined;
        for await (const event of deps.sandbox.execute(
          ref,
          { argv: ["bash", "-c", RESOURCE_PROBE], timeoutMs: RESOURCE_PROBE_TIMEOUT_MS },
          { ...ctx, signal },
        )) {
          if (event.type === "stdout") stdout += event.data;
          if (event.type === "exit") exitCode = event.code;
        }
        const reading = parseResourceProbe(stdout);
        if (exitCode !== 0 || (reading.diskPercent === null && reading.memoryPercent === null))
          return "failed" as const;
        return reading;
      },
      () => new ComputerDeadlineError("health", RESOURCE_PROBE_DEADLINE_MS),
    );
  } catch (error) {
    return isSandboxGoneError(error) ? "gone" : "failed";
  }
}

/**
 * Reads disk and memory when the last reading is older than RESOURCE_CHECK_INTERVAL_MS, and
 * posts a notice in the main chat when one crosses RESOURCE_ALERT_PERCENT. A reading that does
 * not come back counts as a failed check. Never throws.
 */
export async function checkComputerResources(
  deps: ComputerHealthDeps,
  computer: HealthComputer,
  ref: ComputerRef,
  ctx: AdapterContext,
  now = new Date(),
): Promise<void> {
  if (computer.kind === "desktop") return;
  try {
    const health = await readComputerHealth(deps.prisma, computer.id);
    if (
      health?.checkedAt &&
      now.getTime() - health.checkedAt.getTime() < RESOURCE_CHECK_INTERVAL_MS
    )
      return;
    const reading = await readResources(deps, ref, ctx);
    if (reading === "gone") return;
    if (reading === "failed") {
      await updateComputerHealth(deps.prisma, {
        computerId: computer.id,
        spaceId: computer.spaceId,
        data: { checkedAt: now },
      });
      await recordComputerUnresponsive(deps, computer, "health_probe", now);
      return;
    }
    const decision = resourceAlertDecision(
      reading,
      { alertedResources: health?.alertedResources ?? null, alertedAt: health?.alertedAt ?? null },
      now,
    );
    const chat = decision.announce.length ? await mainChat(deps, computer.id) : null;
    const announced = Boolean(chat);
    await updateComputerHealth(deps.prisma, {
      computerId: computer.id,
      spaceId: computer.spaceId,
      data: {
        checkedAt: now,
        diskPercent: reading.diskPercent,
        memoryPercent: reading.memoryPercent,
        // Without a chat nothing was said; leave it to announce once there is one.
        alertedResources: announced
          ? [...decision.alerted].join(",") || null
          : [...decision.alerted].filter((r) => !decision.announce.includes(r)).join(",") || null,
        ...(announced ? { alertedAt: now } : {}),
      },
    });
    if (chat) {
      await notice(deps, chat, resourceNoticeText(reading, decision.announce));
      getLogger().info("computer.resource_alert", {
        "computer.id": computer.id,
        resources: decision.announce.join(","),
        disk: reading.diskPercent ?? undefined,
        memory: reading.memoryPercent ?? undefined,
      });
    }
    await recordComputerResponsive(deps, computer);
  } catch (error) {
    getLogger().error("computer.health_check_failed", error);
  }
}
