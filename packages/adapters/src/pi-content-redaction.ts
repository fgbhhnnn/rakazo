import { AsyncLocalStorage } from "node:async_hooks";

const redaction = new AsyncLocalStorage<(value: unknown) => unknown>();

export function withPiContentRedaction<T>(
  redact: ((value: unknown) => unknown) | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return redact ? redaction.run(redact, work) : work();
}

export function redactPiContent(value: unknown): unknown {
  const redact = redaction.getStore();
  return redact ? redact(value) : value;
}
