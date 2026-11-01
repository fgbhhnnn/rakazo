import { redactConnectorPayload } from "./connector-safety.js";
import type { RunContext } from "./run-context.js";

// Only runs which deliberately revealed a value need their internal transcript scrubbed.
export const revealedRuns = new WeakSet<RunContext>();
export function redactRevealedContent(ctx: RunContext, checkpoint: unknown): unknown {
  return revealedRuns.has(ctx) ? redactConnectorPayload(checkpoint, ctx.secrets) : checkpoint;
}
