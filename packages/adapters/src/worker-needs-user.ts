import type { MessageBlock } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { backgroundTaskCard, postDispatcherTaskMessage } from "./background-task-cards.js";
import type { ExecutorDeps } from "./executor.js";

/*
 * A hidden worker can still pause for the user: an approval card (auto-review, effects) is raised
 * in the worker's own thread, which the user is not looking at. The worker cannot post into the
 * main chat itself, so the main chat gets a card linking to the worker's chat, where the real
 * approval card is answerable, and background_task_status reports the task as needs_user.
 */

export type WorkerPendingKind = "approval" | "secret" | "question" | "takeover";

export type WorkerPending = { kind: WorkerPendingKind; text: string };

const KIND_LABEL: Record<WorkerPendingKind, string> = {
  approval: "批准",
  secret: "提供凭据",
  question: "回答",
  takeover: "接管电脑",
};

const MAX_PENDING_TEXT = 300;

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_PENDING_TEXT ? `${trimmed.slice(0, MAX_PENDING_TEXT - 1)}…` : trimmed;
}

/** The pending ask a waiting worker's last message holds, if any. */
export function pendingAskFromBlocks(blocks: unknown): WorkerPending | undefined {
  if (!Array.isArray(blocks)) return undefined;
  for (const block of [...blocks].reverse()) {
    if (!block || typeof block !== "object") continue;
    const ask = block as {
      kind?: unknown;
      text?: unknown;
      status?: unknown;
      approvalEffectId?: unknown;
      input?: unknown;
    };
    if (ask.kind !== "ask" || ask.status === "answered") continue;
    const kind: WorkerPendingKind = ask.approvalEffectId
      ? "approval"
      : ask.input === "secret"
        ? "secret"
        : "question";
    return { kind, text: clip(String(ask.text ?? "")) };
  }
  return undefined;
}

/**
 * What a waiting worker needs from the user, for background_task_status. undefined when the
 * worker run is not waiting on the user.
 */
export function workerPending(
  runStatus: string | undefined,
  lastBlocks: unknown,
): WorkerPending | undefined {
  if (runStatus === "takeover") {
    return pendingAskFromBlocks(lastBlocks) ?? { kind: "takeover", text: "" };
  }
  if (runStatus !== "waiting_input") return undefined;
  return pendingAskFromBlocks(lastBlocks) ?? { kind: "question", text: "" };
}

export const WORKER_NEEDS_USER_NOTE =
  "A task in state \"needs_user\" is paused until the user acts: pending says what it needs. Tell the user in one line what it needs and that they can tap that task's card (任务 #REF) to approve, deny or answer it in the worker's chat. Never approve or deny for them, and do not resend the task; background_task_message cannot reach it until the user has acted.";

/** The main-chat line and card announcing that a worker is waiting on the user. */
export function workerNeedsUserBlocks(
  task: { workerId: string; name: string; ref: string },
  pending: WorkerPending,
): MessageBlock[] {
  const card = backgroundTaskCard(task.workerId, task.name, task.ref);
  const label = KIND_LABEL[pending.kind];
  const what = pending.text ? `：${pending.text}` : "";
  return [
    { kind: "text", text: `任务 #${task.ref}（${task.name}）需要你${label}${what}` },
    { ...card, title: `任务 #${task.ref} · 需要你${label}，点开处理` },
  ];
}

/**
 * Posts that card into the dispatcher's chat when a hidden worker's run pauses for the user.
 * Best effort and silent for runs that carry no background task (ordinary bots, child bots).
 */
export async function announceWorkerNeedsUser(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  input: { workerRunId: string; pending: WorkerPending },
): Promise<void> {
  try {
    const task = await deps.prisma.backgroundTaskQueue.findFirst({
      where: { workerRunId: input.workerRunId, status: "started" },
      select: {
        id: true,
        spaceId: true,
        botId: true,
        runId: true,
        threadId: true,
        name: true,
        ref: true,
        workerBotId: true,
      },
    });
    if (!task?.workerBotId) return;
    await postDispatcherTaskMessage(
      deps,
      { id: task.runId, spaceId: task.spaceId, threadId: task.threadId, botId: task.botId },
      workerNeedsUserBlocks(
        { workerId: task.workerBotId, name: task.name, ref: task.ref ?? task.id },
        input.pending,
      ),
    );
  } catch (error) {
    getLogger().error("worker needs-user card", error);
  }
}
