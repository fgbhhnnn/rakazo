/**
 * Whether an auto-continued worker just repeated its previous final reply. A worker that
 * answers a continue with (nearly) the same text is not making progress, so continuing again
 * only spends another turn. Pure helpers; hooked from worker-incomplete-continue.ts.
 */
import { createHash } from "node:crypto";

/** Key on background_task_queue.args holding the previous incomplete final's signature. */
export const INCOMPLETE_LAST_SIGNATURE_KEY = "incompleteLastSignature";

/** Share of sentences two finals must have in common to count as a repeat. */
export const REPEAT_SIMILARITY = 0.9;

const MAX_SIGNATURE_PARTS = 400;

/** Hashes of the reply's normalized sentences; whitespace and case do not matter. */
export function resultSignature(text: string): string[] {
  const parts = (text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .split(/[\n。！？!?；;]+|\.(?:\s|$)/u)
    .map((part) => part.replace(/\s+/gu, ""))
    .filter(Boolean)
    .map((part) => createHash("sha256").update(part).digest("hex").slice(0, 12));
  return parts.slice(0, MAX_SIGNATURE_PARTS);
}

/** True when two signatures share at least REPEAT_SIMILARITY of the longer one's sentences. */
export function nearlyIdenticalSignatures(previous: string[], next: string[]): boolean {
  if (!previous.length || !next.length) return false;
  const counts = new Map<string, number>();
  for (const part of previous) counts.set(part, (counts.get(part) ?? 0) + 1);
  let shared = 0;
  for (const part of next) {
    const left = counts.get(part) ?? 0;
    if (left > 0) {
      shared += 1;
      counts.set(part, left - 1);
    }
  }
  return shared / Math.max(previous.length, next.length) >= REPEAT_SIMILARITY;
}

export function storedResultSignature(args: unknown): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const value = (args as Record<string, unknown>)[INCOMPLETE_LAST_SIGNATURE_KEY];
  return Array.isArray(value)
    ? value.filter((part): part is string => typeof part === "string")
    : [];
}
