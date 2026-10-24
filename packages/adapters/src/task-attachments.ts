import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";

export type AttachmentBlock = Extract<MessageBlock, { kind: "file" | "image" }>;

/** The file and image blocks among `blocks`, each artifact once, in order. */
export function attachmentBlocks(blocks: readonly MessageBlock[]): AttachmentBlock[] {
  const seen = new Set<string>();
  const out: AttachmentBlock[] = [];
  for (const block of blocks) {
    if (block.kind !== "file" && block.kind !== "image") continue;
    if (seen.has(block.artifactId)) continue;
    seen.add(block.artifactId);
    out.push(block);
  }
  return out;
}

/**
 * The user's uploads a background task carries to its worker: this turn's, steering's and the
 * recent thread's, deduplicated and capped. The worker's own run copies them into its workspace,
 * so the dispatcher never needs a computer for them.
 */
export function dispatcherTaskAttachments(
  ...sources: ReadonlyArray<readonly MessageBlock[]>
): AttachmentBlock[] {
  return attachmentBlocks(sources.flat()).slice(0, ATTACHMENT_MAX_COUNT);
}
