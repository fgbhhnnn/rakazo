import { describe, expect, it } from "vitest";
import { WORKER_INSTRUCTIONS } from "./background-tasks.js";
import { WORKER_TRANSFER_GUIDANCE } from "./worker-transfer-guidance.js";

describe("worker transfer guidance", () => {
  it("includes the shared transfer and desktop guard guidance in worker instructions", () => {
    expect(WORKER_INSTRUCTIONS.split(WORKER_TRANSFER_GUIDANCE)).toHaveLength(2);
  });
});
