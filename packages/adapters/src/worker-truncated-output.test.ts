import { describe, expect, it } from "vitest";
import {
  buildIncompleteContinueMessage,
  incompleteResultReason,
} from "./worker-incomplete-result.js";
import {
  boundedTruncatedPrefix,
  finalCutAtOutputLimit,
  INCOMPLETE_TRUNCATED_PREFIX_KEY,
  joinTruncatedContinuation,
  MAX_TRUNCATED_PREFIX_CHARS,
  storedTruncatedPrefix,
} from "./worker-truncated-output.js";

/** Anonymized end of the #T7PMBWRF final: 4096 output tokens, cut mid-word. */
const T7PMBWRF_CUT = "## 4. 版本计划\n- 当前测试服版本为 v1.";

describe("truncated_output", () => {
  it("a length stop with text gives truncated_output", () => {
    expect(incompleteResultReason(T7PMBWRF_CUT, { cutAtOutputLimit: true })).toBe(
      "truncated_output",
    );
  });

  it("is not reported without the runtime's length stop", () => {
    expect(incompleteResultReason(T7PMBWRF_CUT)).toBeNull();
    expect(incompleteResultReason(T7PMBWRF_CUT, { cutAtOutputLimit: false })).toBeNull();
  });

  it("needs text: an empty length stop is a runtime failure, not a cut-off result", () => {
    expect(incompleteResultReason("  ", { cutAtOutputLimit: true })).toBeNull();
  });

  it("a leaked tool call still wins over a length stop", () => {
    expect(incompleteResultReason("写到一半\n<tool_call>\nShell", { cutAtOutputLimit: true })).toBe(
      "truncated_tool_call",
    );
  });

  it("asks the worker to pick up exactly where it stopped", () => {
    const msg = buildIncompleteContinueMessage({
      reason: "truncated_output",
      priorText: `${"前文".repeat(2_000)}${T7PMBWRF_CUT}`,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(msg).toContain("原样接着往下写");
    expect(msg).toContain("不要重复已经写出的内容");
    expect(msg).toContain("第 1/3 次");
    expect(msg.endsWith(T7PMBWRF_CUT)).toBe(true);
  });
});

describe("finalCutAtOutputLimit", () => {
  const cut = {
    role: "assistant",
    stopReason: "length",
    content: [{ type: "text", text: "v1." }],
  };

  it("detects a length stop with visible text", () => {
    expect(finalCutAtOutputLimit(cut, true)).toBe(true);
  });

  it.each([
    ["no text", cut, false],
    ["a normal stop", { ...cut, stopReason: "stop" }, true],
    ["an error stop", { ...cut, stopReason: "error" }, true],
    ["an error message", { ...cut, errorMessage: "boom" }, true],
    ["a user message", { ...cut, role: "user" }, true],
    [
      "a cut tool call",
      { ...cut, content: [{ type: "toolCall", id: "1", name: "Shell", arguments: {} }] },
      true,
    ],
  ])("ignores %s", (_label, message, hasText) => {
    expect(finalCutAtOutputLimit(message, hasText)).toBe(false);
  });

  it("ignores a missing message", () => {
    expect(finalCutAtOutputLimit(undefined, true)).toBe(false);
  });
});

describe("joining a cut-off result", () => {
  it("joins the continuation straight after the cut", () => {
    expect(joinTruncatedContinuation("当前版本为 v1.", "2.0，下周上线。")).toBe(
      "当前版本为 v1.2.0，下周上线。",
    );
  });

  it("drops a restated overlap of at least 12 characters", () => {
    const prefix = "第一部分内容。当前测试服版本为 v1.";
    expect(joinTruncatedContinuation(prefix, "当前测试服版本为 v1.2.0，已部署。")).toBe(
      "第一部分内容。当前测试服版本为 v1.2.0，已部署。",
    );
  });

  it("keeps short coincidental overlaps", () => {
    expect(joinTruncatedContinuation("abc", "c def")).toBe("abcc def");
  });

  it("passes through when either side is empty", () => {
    expect(joinTruncatedContinuation("", "全文")).toBe("全文");
    expect(joinTruncatedContinuation("全文", "")).toBe("全文");
  });

  it("reads and bounds the stored prefix", () => {
    expect(storedTruncatedPrefix({ [INCOMPLETE_TRUNCATED_PREFIX_KEY]: "前文" })).toBe("前文");
    expect(storedTruncatedPrefix(null)).toBe("");
    expect(boundedTruncatedPrefix("短")).toBe("短");
    const long = "x".repeat(MAX_TRUNCATED_PREFIX_CHARS + 10);
    const bounded = boundedTruncatedPrefix(long);
    expect(bounded.length).toBeLessThanOrEqual(MAX_TRUNCATED_PREFIX_CHARS + 20);
    expect(bounded).toContain("已省略");
  });
});
