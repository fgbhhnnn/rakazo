/*
 * A hidden background worker's approval card is mirrored into the main chat (the worker's own
 * chat stays hidden). The copy carries workerApproval, links to the worker run, and is answered
 * through it: answerable while open, never once answered or closed (the worker ended first).
 */

type MirrorLike = {
  kind: string;
  status?: string;
  workerApproval?: { runId: string; closed?: string };
};

/** The block is a mirrored worker approval the user can still answer. */
export function isOpenWorkerApprovalMirror(block: MirrorLike): boolean {
  return (
    block.kind === "ask" &&
    Boolean(block.workerApproval) &&
    block.status !== "answered" &&
    !block.workerApproval?.closed
  );
}

/** Why a mirrored approval can no longer be answered, if it was closed before an answer. */
export function workerApprovalClosedState(block: MirrorLike): "cancelled" | "expired" | undefined {
  if (block.kind !== "ask" || block.status === "answered") return undefined;
  const closed = block.workerApproval?.closed;
  return closed === "cancelled" || closed === "expired" ? closed : undefined;
}

/** The run an answer to this message goes to: the worker's run for a mirrored approval. */
export function askAnswerRunId(message: {
  runId?: string | null;
  blocks: readonly MirrorLike[];
}): string | undefined {
  for (const block of message.blocks) {
    if (block.kind === "ask" && block.workerApproval) return block.workerApproval.runId;
  }
  return message.runId ?? undefined;
}
