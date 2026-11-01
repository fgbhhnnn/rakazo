import { describe, expect, it } from "vitest";
import {
  buildIncompleteContinueMessage,
  hasTruncatedOrLeakedToolCall,
  incompleteContinueCount,
  incompleteExhaustedNote,
  incompleteResultReason,
  isIncompleteContinuing,
  saysWorkUnfinished,
  stripLeakedToolCallText,
  userFacingIncompleteText,
  withIncompleteContinueArgs,
} from "./worker-incomplete-result.js";

/** Regression fixture for #TIZS60WO: final assistant text ended mid tool call. */
const TIZS60WO_TRUNCATED = `【后台任务：按原版截图改布局 #TIZS60WO】
首页两段和网页样式都已上传。我先把能独立提交的文件推进分支，首页完整文件随后补上。
<tool_call>
COMPOSIO_MULTI_EXECUTE_TOOL
current_step
COMMIT_READY_FILES
session_id
trip
tools
[{"arguments":{"base_tree":"dc366fcf3e997fd1ca81e0756441e54173ba0f10","owner":"fgbhhnnn","repo":"dadao-expo","tree":[{"mode":"100644","path":"app/+html.tsx","sha":"2a088fc386c781fd40842708a77a4c98bb9d408b","type":"blob"}]},"tool_slug":"GITHUB_CREATE_A_TREE"}]`;

describe("hasTruncatedOrLeakedToolCall", () => {
  it("flags the #TIZS60WO truncated <tool_call> final text", () => {
    expect(hasTruncatedOrLeakedToolCall(TIZS60WO_TRUNCATED)).toBe(true);
    expect(incompleteResultReason(TIZS60WO_TRUNCATED)).toBe("truncated_tool_call");
  });

  it("flags an unclosed tool_call tag", () => {
    expect(hasTruncatedOrLeakedToolCall("done so far\n<tool_call>\nShell")).toBe(true);
  });

  it("flags a closed tool_call leak in a final reply", () => {
    expect(hasTruncatedOrLeakedToolCall("summary\n<tool_call>\nShell\n</tool_call>\nmore")).toBe(
      true,
    );
  });

  it("flags a leaked COMPOSIO tool dump without tags", () => {
    expect(
      hasTruncatedOrLeakedToolCall(
        'uploading\nCOMPOSIO_MULTI_EXECUTE_TOOL\ntools\n[{"tool_slug":"X"}',
      ),
    ).toBe(true);
  });

  it("does not flag a normal completion", () => {
    expect(
      hasTruncatedOrLeakedToolCall("界面已按原版重做并推到 feat/app-features，提交 a2aa728e。"),
    ).toBe(false);
  });
});

describe("stripLeakedToolCallText", () => {
  it("strips the #TIZS60WO leak and keeps the prose", () => {
    const cleaned = stripLeakedToolCallText(TIZS60WO_TRUNCATED);
    expect(cleaned).toContain("首页两段和网页样式都已上传");
    expect(cleaned).toContain("随后补上");
    expect(cleaned).not.toContain("<tool_call>");
    expect(cleaned).not.toContain("COMPOSIO_MULTI_EXECUTE_TOOL");
    expect(userFacingIncompleteText(TIZS60WO_TRUNCATED)).toBe(cleaned);
  });

  it("returns the original text when nothing leaked", () => {
    expect(stripLeakedToolCallText("全部完成。")).toBe("全部完成。");
  });
});

describe("saysWorkUnfinished", () => {
  it.each([
    "布局还在改，还没做完。",
    "首页完整文件随后补上。",
    "这部分未完成，稍后继续。",
    "还在改导航栏。",
    "The layout is not finished yet.",
    "I will continue with the remaining pages.",
    "Work is still in progress on the tabs.",
  ])("detects unfinished: %s", (text) => {
    expect(saysWorkUnfinished(text)).toBe(true);
    expect(incompleteResultReason(text)).toBe("unfinished_phrase");
  });

  it.each([
    "已完成，没有未完成项。",
    "全部完成，无未完成。",
    "All done; no unfinished items.",
    "Nothing left unfinished.",
    "界面已按原版重做，类型检查通过。",
  ])("does not false-positive on: %s", (text) => {
    expect(saysWorkUnfinished(text)).toBe(false);
  });

  it("prefers truncated_tool_call when both match (#TIZS60WO)", () => {
    expect(incompleteResultReason(TIZS60WO_TRUNCATED)).toBe("truncated_tool_call");
  });
});

describe("continue args helpers", () => {
  it("reads and writes the continue count and continuing flag", () => {
    expect(incompleteContinueCount(undefined)).toBe(0);
    expect(incompleteContinueCount({ incompleteContinues: 2 })).toBe(2);
    const next = withIncompleteContinueArgs({ lane: "computer" }, 1, true);
    expect(next).toEqual({
      lane: "computer",
      incompleteContinues: 1,
      incompleteContinuing: true,
    });
    expect(isIncompleteContinuing(next)).toBe(true);
    expect(isIncompleteContinuing(withIncompleteContinueArgs(next, 1, false))).toBe(false);
  });
});

describe("continue / exhausted copy", () => {
  it("builds a continue instruction that cites the attempt", () => {
    const msg = buildIncompleteContinueMessage({
      reason: "truncated_tool_call",
      priorText: TIZS60WO_TRUNCATED,
      attempt: 2,
      maxAttempts: 3,
    });
    expect(msg).toContain("第 2/3 次");
    expect(msg).toContain("首页两段");
    expect(msg).not.toContain("<tool_call>");
  });

  it("builds an exhausted failure note for the dispatcher", () => {
    const note = incompleteExhaustedNote({
      reason: "unfinished_phrase",
      cleanedText: "还在改。",
      continues: 3,
    });
    expect(note).toContain("未完成");
    expect(note).toContain("3 次");
    expect(note).toContain("还在改");
  });
});
