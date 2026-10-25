import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { withoutBackgroundTaskCards } from "./background-task-display.js";
import { projectBotMentions } from "./bot-mentions.js";

// A started task's card is a child_bot "created" block naming the hidden worker. Chats drop it
// before naming created bots inline, so the hidden worker is never shown as a mention.
const taskCard: MessageBlock = {
  kind: "child_bot",
  botId: "hidden-worker",
  name: "后台任务：整理报表 #TAB12CD3",
  title: "任务 #TAB12CD3 · 点开看实时进度",
  status: "created",
};
const createdBot: MessageBlock = {
  kind: "child_bot",
  botId: "planner",
  name: "Planner",
  status: "created",
};
const bot = (id: string, blocks: MessageBlock[]) => ({ id, role: "bot", botId: "chief", blocks });
const text = (value: string): MessageBlock => ({ kind: "text", text: value });

describe("background task cards and inline bot mentions", () => {
  it("never names a hidden worker inline", () => {
    const view = projectBotMentions(
      withoutBackgroundTaskCards([bot("a", [taskCard]), bot("b", [text("已派出 #TAB12CD3。")])]),
    );
    expect(view.visibleMessages.map((message) => message.id)).toEqual(["b"]);
    expect(view.mentions.size).toBe(0);
    expect(view.foldedInto.size).toBe(0);
  });

  it("still names a bot the reply created next to a task card", () => {
    const view = projectBotMentions(
      withoutBackgroundTaskCards([
        bot("a", [createdBot]),
        bot("b", [taskCard]),
        bot("c", [text("Planner is ready.")]),
      ]),
    );
    expect(view.visibleMessages.map((message) => message.id)).toEqual(["c"]);
    expect(view.mentions.get("c")).toEqual([createdBot]);
    expect(view.foldedInto.get("a")).toBe("c");
  });
});
