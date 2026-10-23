import { describe, expect, it } from "vitest";
import {
  displayIdentityEvent,
  displayIdentityResult,
  isWorkerRelayBlock,
} from "./identity-display.js";

const labels = {
  bot: "Bot",
  group: "Group",
  space: "Space",
  chats: "Chats",
  routine: "Routine",
  member: "Member",
  subagent: "Subagent",
  owner: "Owner",
};
const sent = {
  kind: "bot_message_sent",
  toBotId: "w",
  toBotName: "New Bot · 后台1",
  text: "查内存",
};
const received = {
  kind: "bot_message_received",
  fromBotId: "w",
  fromBotName: "New Bot · 后台1",
  text: "内存 7.8 GiB",
};
const relay = { kind: "text", text: "这台电脑内存大约 7.8 GiB" };

describe("worker relay rows", () => {
  it("recognises only hand-offs to and reports from background workers", () => {
    expect(isWorkerRelayBlock(sent)).toBe(true);
    expect(isWorkerRelayBlock(received)).toBe(true);
    expect(isWorkerRelayBlock({ ...received, fromBotName: "Researcher" })).toBe(false);
    expect(isWorkerRelayBlock(relay)).toBe(false);
  });

  it("drops them from thread history but keeps the card and the main bot's relay", () => {
    const thread = {
      messages: [
        { id: "1", role: "bot", blocks: [sent] },
        {
          id: "2",
          role: "bot",
          blocks: [{ kind: "child_bot", botId: "w", name: "x", status: "created" }],
        },
        { id: "3", role: "user", blocks: [received] },
        { id: "4", role: "bot", blocks: [relay] },
        { id: "5", role: "user", blocks: [{ ...received, fromBotName: "Researcher" }] },
      ],
    };
    const out = displayIdentityResult(["threads/get"], thread, labels) as typeof thread;
    expect(out.messages.map((m) => m.id)).toEqual(["2", "4", "5"]);
  });

  it("turns their live events into an event clients ignore", () => {
    const event = {
      type: "thread.message.created",
      payload: { messageId: "3", role: "user", blocks: [received] },
    };
    expect(displayIdentityEvent(event, labels).type).toBe("thread.message.internal");
    const normal = { type: "thread.message.created", payload: { role: "bot", blocks: [relay] } };
    expect(displayIdentityEvent(normal, labels).type).toBe("thread.message.created");
  });
});
