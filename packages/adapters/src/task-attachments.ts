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
 * The user's uploads a background task carries to its worker: the files of the messages that led
 * to this dispatch (this turn's and steering's), plus earlier uploads only when the task text names
 * them (e.g. "sum column B of up TK3C7DFF.csv" sent after the upload). Earlier uploads the task does
 * not mention stay out, so an old CSV is not handed to every later, unrelated worker task.
 * Deduplicated and capped. The worker's own run copies them into its workspace, so the dispatcher
 * never needs a computer for them.
 */
export function dispatcherTaskAttachments(input: {
  turn: ReadonlyArray<readonly MessageBlock[]>;
  recent: readonly MessageBlock[];
  taskText: string;
}): AttachmentBlock[] {
  const text = input.taskText.toLowerCase();
  const named = attachmentBlocks(input.recent).filter((block) => mentionsFile(text, block.name));
  return attachmentBlocks([...input.turn.flat(), ...named]).slice(0, ATTACHMENT_MAX_COUNT);
}

/** Whether lower-cased task text names a file, with or without its extension. */
function mentionsFile(text: string, fileName: string): boolean {
  const name = fileName.trim().toLowerCase();
  if (!name) return false;
  if (text.includes(name)) return true;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  // A bare stem must be specific enough not to match ordinary words ("data", "up").
  return stem.length >= 6 && text.includes(stem);
}
