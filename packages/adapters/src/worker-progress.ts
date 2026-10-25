import type { ConnectorTool } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { isHiddenBot, type PrismaClient, type ThreadEvents } from "@rakazo/db";
import { redactSensitiveText } from "@rakazo/logging";

/**
 * report_progress: a hidden background worker leaves a short note at a real milestone. The note is
 * saved on the worker's own run (a progress event in its hidden thread) and shown by the main
 * bot's background_task_status as last_progress. It never wakes the main bot and never posts in
 * the user's chat. Only hidden workers get the tool.
 */
export const REPORT_PROGRESS_TOOL = "report_progress";
/** Marks a progress event as a worker's note. "notice" is a plain (queryable) event payload key. */
export const WORKER_PROGRESS_NOTICE = "worker_progress";
export const WORKER_PROGRESS_MAX_CHARS = 280;
/** At most one note per this interval per run; earlier calls get a gentle "too soon". */
export const WORKER_PROGRESS_MIN_INTERVAL_MS = 2 * 60_000;

export const reportProgressTool: ConnectorTool = {
  name: REPORT_PROGRESS_TOOL,
  description: `Leave one short progress note (max ${WORKER_PROGRESS_MAX_CHARS} characters) for the main bot at a real milestone: a build finished or failed, an emulator or service is up, an app is installed, a major error or a change of plan. The main bot sees it when it checks this task's status; the user is not notified. Not for every step; at most one every 2 minutes.`,
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          'What just happened and what comes next, in one or two sentences (e.g. "Build done; emulator booting (about 3 min)").',
      },
    },
    required: ["text"],
  },
};

/** The one line added to a worker's instructions (see WORKER_INSTRUCTIONS). */
export const WORKER_PROGRESS_INSTRUCTION =
  "- 到了真正的里程碑（编译完成/失败、模拟器启动好、应用装好、遇到大错误或改了方案）时，用 report_progress 留一句简短进度（主 bot 查进度时能看到，不会打扰用户）；不要每一步都报。主 bot 发来的补充/询问，也用 report_progress 回一句当前进度。";

/** Ordinary bots and the main bot never get report_progress. */
export function withholdWorkerOnlyTools(
  bot: { spawnKey?: string | null },
  disabled: Set<string>,
): void {
  if (!isHiddenBot(bot)) disabled.add(REPORT_PROGRESS_TOOL);
}

/** One line, secrets masked, capped at WORKER_PROGRESS_MAX_CHARS. */
export function progressNoteText(raw: unknown, secrets: string[] = []): string {
  const line = redactSensitiveText(
    redactSecrets(String(raw ?? ""), secrets)
      .replace(/\s+/g, " ")
      .trim(),
  );
  return line.length > WORKER_PROGRESS_MAX_CHARS
    ? `${line.slice(0, WORKER_PROGRESS_MAX_CHARS - 1)}…`
    : line;
}

// Serializes notes per run so two parallel calls cannot both pass the interval check.
const inFlight = new Map<string, Promise<unknown>>();

export async function reportWorkerProgress(
  deps: { prisma: Pick<PrismaClient, "event">; events: Pick<ThreadEvents, "append"> },
  input: {
    run: { id: string; spaceId: string };
    threadId: string;
    bot: { id: string; spawnKey?: string | null };
    args: Record<string, unknown>;
    secrets?: string[];
    now?: () => Date;
    minIntervalMs?: number;
  },
): Promise<Record<string, unknown>> {
  if (!isHiddenBot(input.bot)) return { error: "report_progress is only for background workers." };
  const text = progressNoteText(input.args.text, input.secrets);
  if (!text) return { error: "text is required: one short sentence about the milestone." };
  const runId = input.run.id;
  const previous = inFlight.get(runId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => save(deps, input, text));
  inFlight.set(runId, next);
  try {
    return await next;
  } finally {
    if (inFlight.get(runId) === next) inFlight.delete(runId);
  }
}

async function save(
  deps: { prisma: Pick<PrismaClient, "event">; events: Pick<ThreadEvents, "append"> },
  input: Parameters<typeof reportWorkerProgress>[1],
  text: string,
): Promise<Record<string, unknown>> {
  const now = (input.now ?? (() => new Date()))();
  const minInterval = input.minIntervalMs ?? WORKER_PROGRESS_MIN_INTERVAL_MS;
  const last = await deps.prisma.event.findFirst({
    where: {
      runId: input.run.id,
      type: "thread.progress",
      payload: { path: ["notice"], equals: WORKER_PROGRESS_NOTICE },
    },
    orderBy: { seq: "desc" },
    select: { createdAt: true },
  });
  const since = last ? now.getTime() - last.createdAt.getTime() : Number.POSITIVE_INFINITY;
  if (since < minInterval) {
    return {
      ok: false,
      too_soon: true,
      retry_after_s: Math.ceil((minInterval - since) / 1000),
      note: "Not saved: you reported progress less than 2 minutes ago. Keep working and report again at the next real milestone.",
    };
  }
  await deps.events.append({
    spaceId: input.run.spaceId,
    threadId: input.threadId,
    botId: input.bot.id,
    runId: input.run.id,
    type: "thread.progress",
    payload: {
      text: `Progress: ${text}`,
      activity: true,
      notice: WORKER_PROGRESS_NOTICE,
      note: text,
    },
  });
  return {
    ok: true,
    note: "Saved. The main bot sees it when it checks this task's status; the user is not notified. Keep working.",
  };
}
