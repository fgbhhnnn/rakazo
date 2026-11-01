import { describe, expect, it } from "vitest";
import { isHumanAuthoredMessage } from "./human-message.js";

describe("isHumanAuthoredMessage", () => {
  const text = { kind: "text", text: "Please continue" };
  const file = { kind: "file", artifactId: "artifact", name: "result.html" };
  const receipt = {
    kind: "bot_message_received",
    fromBotId: "worker",
    fromBotName: "团队-前端 worker",
    text: "Finished",
    intent: "result",
  };

  it.each([
    { role: "user", blocks: [text] },
    { role: "user", botId: null, blocks: [text] },
    { role: "user", blocks: [file] },
    // Human steering and voice messages can belong to a run too.
    { role: "user", runId: "run", blocks: [text] },
    { role: "user", blocks: [{ ...text, text: "bot_message_received" }] },
  ])("accepts human authorship: %j", (message) => {
    expect(isHumanAuthoredMessage(message)).toBe(true);
  });

  it.each([
    null,
    undefined,
    { role: "bot", blocks: [text] },
    { role: "system", blocks: [text] },
    { role: "assistant", blocks: [text] },
    { role: "user", botId: "bot", blocks: [text] },
    { role: "user", botId: null, blocks: [receipt] },
    { role: "user", botId: null, blocks: [receipt, file] },
    { role: "user", blocks: [file, text, receipt] },
    { role: "user", blocks: [{ kind: "bot_message_sent" }] },
    { role: "user", blocks: [{ kind: "handoff" }] },
  ])("rejects non-human authorship: %j", (message) => {
    expect(isHumanAuthoredMessage(message)).toBe(false);
  });

  it("handles historical JSON without assuming every block is an object", () => {
    expect(isHumanAuthoredMessage({ role: "user", blocks: [null, 1, "text"] })).toBe(true);
  });
});
