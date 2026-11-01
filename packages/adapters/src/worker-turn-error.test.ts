import { describe, expect, it } from "vitest";
import {
  isTransientWorkerTurnError,
  WORKER_TEMPORARY_FAILURE,
  workerFailureMessage,
  workerReportText,
} from "./worker-turn-error.js";

describe("worker turn errors", () => {
  it.each(["P2028", "P2024", "idle"])("recognizes %s through wrapped errors", (code) => {
    const error = code === "idle" ? new Error("Model stream idle timeout") : { code };
    expect(isTransientWorkerTurnError(new Error("wrapper", { cause: error }))).toBe(true);
    expect(workerFailureMessage(error)).toBe(WORKER_TEMPORARY_FAILURE);
  });
  it("handles cause cycles and permanent failures", () => {
    const error = { code: "P2002", cause: undefined as unknown };
    error.cause = error;
    expect(isTransientWorkerTurnError(error)).toBe(false);
    expect(workerFailureMessage(new Error("Internal server error"))).toBe(WORKER_TEMPORARY_FAILURE);
    expect(workerFailureMessage(new Error("Choose another model."))).toBe("Choose another model.");
  });
  it("sanitizes historical relays and leaves successful results unchanged", () => {
    expect(workerReportText("Could not complete: Internal server error")).toBe(
      `Could not complete: ${WORKER_TEMPORARY_FAILURE}`,
    );
    expect(workerReportText("All done.")).toBe("All done.");
  });
});
