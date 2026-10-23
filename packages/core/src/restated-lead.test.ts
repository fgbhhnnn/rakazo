import { describe, expect, it } from "vitest";
import { dropRestatedLeadSentences, withoutRestatedLeadSentences } from "./events.js";

describe("dropRestatedLeadSentences", () => {
  it("drops a paragraph that only restates the opening sentence", () => {
    const text =
      "法国的首都是巴黎。我先看一下 s1 现在到哪一步了。\n\n法国的首都是巴黎。\n\n**s1** 正在跑。";
    expect(dropRestatedLeadSentences(text)).toBe(
      "法国的首都是巴黎。我先看一下 s1 现在到哪一步了。\n\n**s1** 正在跑。",
    );
  });
  it("drops a restated lead sentence and keeps the rest of that paragraph", () => {
    expect(
      dropRestatedLeadSentences(
        "1 英里约等于 1.61 公里。我查一下。\n\n1 英里约等于 1.61 公里。任务还在跑。",
      ),
    ).toBe("1 英里约等于 1.61 公里。我查一下。\n\n任务还在跑。");
  });
  it("keeps paraphrases, short repeats, the first paragraph and repeats mid-paragraph", () => {
    for (const text of [
      "这条命令得放到后台执行。\n\n这条命令已放到后台执行。",
      "好。\n\n好。",
      "Paris is the capital.\n\nNote: Paris is the capital.",
      "结果如下。结果如下。",
    ])
      expect(dropRestatedLeadSentences(text)).toBe(text);
  });
  it("never empties a message and only touches text blocks", () => {
    expect(dropRestatedLeadSentences("巴黎是法国首都。")).toBe("巴黎是法国首都。");
    const blocks = withoutRestatedLeadSentences([
      { kind: "text", text: "Paris is the capital.\n\nParis is the capital.\n\nDone here." },
      { kind: "steps", steps: [] },
    ] as never);
    expect(blocks[0]).toEqual({ kind: "text", text: "Paris is the capital.\n\nDone here." });
    expect(blocks[1]).toEqual({ kind: "steps", steps: [] });
  });
});
