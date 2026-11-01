import type { MessageBlock } from "@rakazo/contracts";
import { postWorkerApprovalMirror, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";

/*
 * A hidden worker can still pause for the user: an approval card (auto-review, effects) is raised
 * in the worker's own thread, which the user is not looking at. The worker cannot post into the
 * main chat itself, so the card is mirrored there and answered there (the answer resolves the
 * worker's own card), and background_task_status reports the task as needs_user.
 */

export type WorkerPendingKind = "approval" | "secret" | "question" | "takeover";

export type WorkerPending = { kind: WorkerPendingKind; text: string };

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
  'A task in state "needs_user" is paused until the user acts: pending says what it needs. Its approval card is already shown in this chat, and the user approves or denies it right there. Tell the user in one line what it waits for and point them to that card. Never approve or deny for them, and do not resend the task; background_task_message cannot reach it until the user has acted.';

/**
 * Mirrors a hidden worker's approval card into the main chat (the background task's thread),
 * where the user answers it directly. Best effort and silent for runs that carry no background
 * task (ordinary bots, child bots). Returns the main bot and chat so the push points there.
 */
export async function mirrorWorkerApproval(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  input: { workerRunId: string; workerThreadId: string; block: MessageBlock },
): Promise<{ botId: string; threadId: string } | null> {
  if (input.block.kind !== "ask" || !input.block.approvalEffectId) return null;
  try {
    const posted = await withTransactionRetry(() =>
      postWorkerApprovalMirror(deps.prisma, {
        workerRunId: input.workerRunId,
        workerThreadId: input.workerThreadId,
        block: input.block as Extract<MessageBlock, { kind: "ask" }>,
      }),
    );
    if (!posted) return null;
    await deps.events.notify(posted.threadId, posted.seq).catch(() => undefined);
    return { botId: posted.botId, threadId: posted.threadId };
  } catch (error) {
    getLogger().error("worker approval mirror", error);
    return null;
  }
}
