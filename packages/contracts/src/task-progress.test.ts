import { describe, expect, it } from "vitest";
import { taskProgressDetailStep } from "./task-progress.js";

describe("taskProgressDetailStep", () => {
  it("omits empty or status-duplicate steps", () => {
    expect(taskProgressDetailStep("continuing", undefined)).toBeUndefined();
    expect(taskProgressDetailStep("continuing", "")).toBeUndefined();
    expect(taskProgressDetailStep("continuing", "  ")).toBeUndefined();
    expect(taskProgressDetailStep("continuing", "继续中")).toBeUndefined();
    expect(taskProgressDetailStep("continuing", "continuing")).toBeUndefined();
    expect(taskProgressDetailStep("running", "running")).toBeUndefined();
    expect(taskProgressDetailStep("stuck", "没有进展")).toBeUndefined();
    expect(taskProgressDetailStep("running", "running", "运行中")).toBeUndefined();
  });

  it("keeps a real distinct step", () => {
    expect(taskProgressDetailStep("continuing", "Reading layout screenshot")).toBe(
      "Reading layout screenshot",
    );
    expect(taskProgressDetailStep("running", "  shell: npm test  ")).toBe("shell: npm test");
    expect(taskProgressDetailStep("running", "shell: npm test", "运行中")).toBe("shell: npm test");
  });
});
