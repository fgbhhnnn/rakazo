import { describe, expect, it } from "vitest";
import { groupSendTargetBotIds } from "./group-send-targets.js";

const members = [
  { id: "plan", name: "策划" },
  { id: "write", name: "撰稿" },
];

describe("group send targets", () => {
  it("admits and starts only the first bot in a requested handoff", () => {
    expect(
      groupSendTargetBotIds({
        text: "@策划 写大纲，然后交给@撰稿",
        members,
        explicitMentions: ["plan", "write"],
      }),
    ).toEqual(["plan"]);
  });

  it("starts both bots when both are directly addressed", () => {
    expect(
      groupSendTargetBotIds({
        text: "@策划 @撰稿 一起看看",
        members,
        explicitMentions: ["plan", "write"],
      }),
    ).toEqual(["plan", "write"]);
  });

  it("keeps the default group target and structured mentions", () => {
    expect(groupSendTargetBotIds({ text: "Hello", members, explicitMentions: [] })).toEqual([
      "plan",
    ]);
    expect(groupSendTargetBotIds({ text: "Hello", members, explicitMentions: ["write"] })).toEqual([
      "write",
    ]);
  });
});
