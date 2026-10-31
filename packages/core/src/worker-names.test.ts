import { describe, expect, it } from "vitest";
import { blocksToAgentHistoryText } from "./attachments.js";
import { isWorkerRelayBlock } from "./identity-display.js";
import { isBackgroundWorkerName, withoutWorkerSlot } from "./worker-names.js";

describe("worker slot names", () => {
  it("recognises a worker by its slot suffix and hides the slot", () => {
    expect(isBackgroundWorkerName("调度测试 · 后台1")).toBe(true);
    expect(isBackgroundWorkerName("调度测试")).toBe(false);
    expect(withoutWorkerSlot("调度测试 · 后台12")).toBe("调度测试 · 后台任务");
    expect(withoutWorkerSlot("New Bot")).toBe("New Bot");
  });

  it("keeps the slot out of the dispatcher's history but still hides relay rows from the user", () => {
    const received = {
      kind: "bot_message_received" as const,
      fromBotId: "w1",
      fromBotName: "调度测试 · 后台1",
      text: "【后台任务：echo #TJWZVVJK】\nok",
      hop: 1,
    };
    const sent = {
      kind: "bot_message_sent" as const,
      toBotId: "w1",
      toBotName: "调度测试 · 后台1",
      text: "【后台任务】echo",
      hop: 1,
    };
    const text = blocksToAgentHistoryText([received, sent]);
    expect(text).not.toMatch(/后台\d/);
    expect(text).toContain("[from 调度测试 · 后台任务] 【后台任务：echo #TJWZVVJK】");
    expect(isWorkerRelayBlock(received)).toBe(true);
    expect(isWorkerRelayBlock(sent)).toBe(true);
  });
});
