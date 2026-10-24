import { createHash } from "node:crypto";

/** Short unique label of one background task, shown on its card and used as its task_id. */
export function newTaskRef(): string {
  return `T${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
}

/** A worker title without its " #REF" task label. */
export function taskTitle(title: string): string {
  return title.replace(/ #[A-Z0-9]{4,10}$/, "");
}

/**
 * Identity of a task: its name plus normalized content. Same name with different content is a
 * different task, and so is the same content under a different name (the user asked twice).
 */
export function backgroundTaskHash(input: {
  name?: string;
  task: string;
  instructions?: string;
  agent: string;
}): string {
  const normalize = (text: string | undefined) =>
    (text ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256")
    .update(
      `${normalize(input.name)}\n${input.agent}\n${normalize(input.instructions)}\n${normalize(input.task)}`,
    )
    .digest("hex")
    .slice(0, 32);
}
