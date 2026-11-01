import { ORPCError } from "@orpc/server";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { closeWorkerApprovalMirrors, findWorkerApprovalMirror } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { approvalRulesLockedError } from "./member-settings-guard.js";

/*
 * Answering the main-chat copy of a hidden worker's approval card answers the worker's own card:
 * the same answerRunInput transaction, keyed by the worker's run and message, so one decision
 * resumes the worker once however often or wherever it is sent. Only the run's user can answer.
 */

export const WORKER_APPROVAL_FORBIDDEN = "Only the person this task runs for can answer it";
export const WORKER_APPROVAL_GONE = "This prompt is no longer awaiting an answer";

type Deps = { prisma: PrismaClient; events: ThreadEvents; jobs: JobPublisher };

/**
 * Handles an answer to a mirrored worker approval. false when the message is not one (the
 * normal answer path runs); throws when it is one that cannot be answered by this user now.
 */
export async function answerWorkerApprovalMirror(
  deps: Deps,
  actor: { spaceId: string; userId: string },
  target: { threadId: string },
  input: {
    runId: string;
    messageId: string;
    answer: string;
    username?: string;
    dismiss?: true;
    /** False for a locked deployment's member, whose "always" answer is refused. */
    mayChangeApprovalRules?: boolean;
  },
): Promise<boolean> {
  const mirror = await findWorkerApprovalMirror(deps.prisma, {
    spaceId: actor.spaceId,
    threadId: target.threadId,
    messageId: input.messageId,
  });
  if (!mirror) return false;
  if (!mirror.run) throw new ORPCError("CONFLICT", { message: WORKER_APPROVAL_GONE });
  if (mirror.run.userId !== actor.userId)
    throw new ORPCError("FORBIDDEN", { message: WORKER_APPROVAL_FORBIDDEN });
  // An approval has no dismissal or login; the run named must be the worker's.
  if (!mirror.open || input.runId !== mirror.workerRunId || input.dismiss || input.username)
    throw new ORPCError("CONFLICT", { message: WORKER_APPROVAL_GONE });
  const answered = await deps.events
    .answerRunInput({
      spaceId: actor.spaceId,
      threadId: mirror.run.threadId,
      runId: mirror.workerRunId,
      messageId: mirror.workerMessageId,
      answeredByUserId: actor.userId,
      answer: input.answer,
      mayChangeApprovalRules: input.mayChangeApprovalRules,
    })
    .catch((error: unknown) => {
      throw approvalRulesLockedError(error);
    });
  if (!answered) {
    // The worker ended (or was answered) meanwhile; show that on the copy instead.
    const closed = await closeWorkerApprovalMirrors(deps.prisma, mirror.workerRunId).catch(
      (error) => {
        getLogger().error("worker approval close", error);
        return null;
      },
    );
    if (closed) await deps.events.notify(closed.threadId, closed.seq).catch(() => undefined);
    throw new ORPCError("CONFLICT", { message: WORKER_APPROVAL_GONE });
  }
  await deps.jobs.enqueue(runContinueJob(mirror.workerRunId)).catch((error) => {
    // The answer and queued run are durable; the reconciler repairs a missed immediate wake.
    getLogger().error("worker approval enqueue", error);
  });
  return true;
}
