import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  backgroundTasksActive,
  isBackgroundTaskStartCard,
  isBackgroundWorkerReceipt,
  withoutBackgroundTaskCards,
} from "./background-task-display.js";

const taskCard = {
  kind: "child_bot",
  botId: "worker-2",
  name: "后台任务：L1 数据分析 #THLFV7BZ",
  title: "任务 #THLFV7BZ · 点开看实时进度",
  status: "created",
} as const;
const createdBot = {
  kind: "child_bot",
  botId: "bot-9",
  name: "Researcher",
  status: "created",
} as const;

function message(id: string, blocks: unknown[]): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    blocks: blocks as ThreadMessage["blocks"],
    runId: "run-1",
    createdAt: "2026-10-24T09:00:00.000Z",
  };
}

describe("background task display", () => {
  it("recognizes only task cards, not create_bot cards", () => {
    expect(isBackgroundTaskStartCard(taskCard)).toBe(true);
    expect(isBackgroundTaskStartCard(createdBot)).toBe(false);
    expect(isBackgroundTaskStartCard({ kind: "text", text: "后台任务：x #AB12" })).toBe(false);
    expect(isBackgroundTaskStartCard(null)).toBe(false);
  });

  it("drops card-only messages and keeps text and #REF mentions beside a card", () => {
    const text = { kind: "text", text: "已开始 #THLFV7BZ，完成后告诉你。" };
    const out = withoutBackgroundTaskCards([
      message("a", [{ kind: "text", text: "hi" }]),
      message("card", [taskCard]),
      message("mixed", [text, taskCard]),
      message("bot", [createdBot]),
    ]);
    expect(out.map((m) => m.id)).toEqual(["a", "mixed", "bot"]);
    expect(out[1]!.blocks).toEqual([text]);
    expect(JSON.stringify(out)).not.toContain("后台任务：");
    expect(JSON.stringify(out)).toContain("#THLFV7BZ");
  });

  it("hides hidden workers' receipts but keeps the relay's files, shown as the bot's", () => {
    // Prod: "来自 UniApp → Expo 迁移 · 后台 1 的消息 >" above a relayed worker result.
    const worker = "UniApp → Expo 迁移 · 后台1";
    const sent = { kind: "bot_message_sent", toBotId: "w", toBotName: worker, text: "分析" };
    const received = {
      kind: "bot_message_received",
      fromBotId: "w",
      fromBotName: worker,
      text: "分析完成",
    };
    const file = { kind: "file", artifactId: "page-1", name: "autoai-next 迁移分析" };
    const peer = { ...received, fromBotId: "b2", fromBotName: "Researcher" };
    expect(isBackgroundWorkerReceipt(sent)).toBe(true);
    expect(isBackgroundWorkerReceipt(received)).toBe(true);
    expect(isBackgroundWorkerReceipt(peer)).toBe(false);
    expect(isBackgroundWorkerReceipt({ kind: "text", text: worker })).toBe(false);
    const out = withoutBackgroundTaskCards([
      message("launch", [sent]),
      { ...message("relay", [received, file]), role: "user" },
      { ...message("relay-only", [received]), role: "user" },
      { ...message("peer", [peer]), role: "user" },
      message("reply", [{ kind: "text", text: "分析完成了" }]),
    ]);
    expect(out.map((m) => [m.id, m.role])).toEqual([
      ["relay", "bot"],
      ["peer", "user"],
      ["reply", message("reply", []).role],
    ]);
    expect(out[0]!.blocks).toEqual([file]);
    expect(JSON.stringify(out)).not.toContain(worker);
  });

  it("returns the same transcript when there is nothing to hide", () => {
    const messages = [message("a", [{ kind: "text", text: "hi" }])];
    expect(withoutBackgroundTaskCards(messages)).toBe(messages);
  });

  it("reports activity without a count", () => {
    expect(backgroundTasksActive(undefined)).toBe(false);
    expect(backgroundTasksActive({ running: 0, queued: 0 })).toBe(false);
    expect(backgroundTasksActive({ running: 0, queued: 2 })).toBe(true);
    expect(backgroundTasksActive({ running: 3, queued: 0 })).toBe(true);
  });
});
