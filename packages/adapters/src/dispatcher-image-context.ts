import type { MessageBlock } from "@rakazo/contracts";

/**
 * A dispatcher's main turn only talks and dispatches, so it never gets image bytes: a handful of
 * phone screenshots (plus the images still in recent history) kept the model from answering
 * within the reply budget. It gets a short note naming the images instead, and the worker it
 * starts receives and sees them (background_task carries this turn's uploads, and earlier ones
 * the task text names; see task-attachments.ts).
 */
export function dispatcherWithholdsImages(dispatcherTurn: boolean): boolean {
  return dispatcherTurn;
}

function imageNames(blocks: readonly MessageBlock[] | undefined): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const block of blocks ?? []) {
    if (block.kind !== "image" || seen.has(block.artifactId)) continue;
    seen.add(block.artifactId);
    names.push(block.name);
  }
  return names;
}

function quoted(names: readonly string[]): string {
  return names.map((name) => JSON.stringify(name)).join(", ");
}

/**
 * The note that stands in for image bytes in a dispatcher turn: what the user attached to the
 * message(s) being answered, and the images attached earlier that a task may still need.
 * Empty when there are no images to mention.
 */
export function dispatcherImageNote(
  turnBlocks: readonly MessageBlock[] | undefined,
  earlierImageNames: readonly string[] = [],
): string {
  const current = imageNames(turnBlocks);
  const earlier = [...new Set(earlierImageNames)].filter((name) => !current.includes(name));
  const lines: string[] = [];
  if (current.length) {
    lines.push(
      `The user attached ${current.length} image${current.length === 1 ? "" : "s"} to this message: ${quoted(current)}. You cannot see image contents in this chat turn, so do not describe or guess what they show. Anything that needs looking at them goes to background_task: the worker receives this message's images and can see them.`,
    );
  }
  if (earlier.length) {
    lines.push(
      `Images attached earlier in this conversation (not visible to you): ${quoted(earlier)}. When a task needs one of them, name the file in the background_task text so the worker receives it.`,
    );
  }
  return lines.join("\n");
}
