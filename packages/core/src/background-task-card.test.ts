import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { isBackgroundTaskCardBlock } from "./background-task-card.js";
import { foldPeerReplies, userVisibleMessages } from "./message-visibility.js";

function message(id: string, runId: string, blocks: ThreadMessage["blocks"]): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    blocks,
    runId,
    createdAt: "2026-10-24T06:57:12.000Z",
  };
}

const card = {
  kind: "child_bot",
  botId: "worker-2",
  name: "后台任务：斐波那契20万项 #TJ0TX4IZ",
  title: "任务 #TJ0TX4IZ · 点开看实时进度",
  status: "created",
} as ThreadMessage["blocks"][number];

// A finished task's result wakes the dispatcher (a bot_message run); the freed slot starts the
// next queued task inside that run, so its card is posted by the relay run.
const relayRun = [
  message("result", "run-relay", [
    {
      kind: "bot_message_received",
      fromBotId: "worker-1",
      fromBotName: "后台1",
      text: "【后台任务：质数前300万 #TIZP28J2】done",
      intent: "result",
    } as ThreadMessage["blocks"][number],
  ]),
  message("handoff", "run-relay", [
    { kind: "bot_message_sent", toBotId: "worker-2", toBotName: "后台2", text: "斐波那契" },
  ]),
  message("card", "run-relay", [card]),
  message("activity", "run-relay", [{ kind: "steps", steps: [{ label: "Tool", count: 1 }] }]),
  message("reply", "run-relay", [{ kind: "text", text: "质数任务已完成。" }]),
];

describe("background task cards", () => {
  it("recognises only child_bot blocks", () => {
    expect(isBackgroundTaskCardBlock(card)).toBe(true);
    expect(isBackgroundTaskCardBlock({ kind: "text", text: "x" })).toBe(false);
    expect(isBackgroundTaskCardBlock(null)).toBe(false);
  });

  it("keeps a card posted by a relay run in the transcript, with or without receipts", () => {
    expect(userVisibleMessages(relayRun).map((item) => item.id)).toEqual(["card", "reply"]);
    const transcript = foldPeerReplies(relayRun, { includePeerReceipts: true });
    expect(transcript.messages.map((item) => item.id)).toContain("card");
    expect(transcript.messages.map((item) => item.id)).not.toContain("activity");
    expect(transcript.markerOf.has("card")).toBe(false);
  });
});
