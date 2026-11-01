import { userRunError } from "@rakazo/core";

export const WORKER_TEMPORARY_FAILURE = "服务暂时繁忙，这次任务未能完成，请稍后重试。";

/** Historical failures can still be waiting in the delivery reconciler or a task card. */
export function workerReportText(text: string): string {
  return text.replaceAll("Internal server error", WORKER_TEMPORARY_FAILURE);
}

/** Structured database codes and the runtime's transport timeout, including wrapped causes. */
export function isTransientWorkerTurnError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (value.code === "P2028" || value.code === "P2024") return true;
    if (
      typeof value.message === "string" &&
      /\b(?:model )?stream idle timeout\b/i.test(value.message)
    )
      return true;
    current = value.cause;
  }
  return false;
}

export function workerFailureMessage(error: unknown): string {
  return isTransientWorkerTurnError(error)
    ? WORKER_TEMPORARY_FAILURE
    : workerReportText(userRunError(error));
}
