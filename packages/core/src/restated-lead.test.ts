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

describe("dropSupersededParagraphs", () => {
  it("keeps only the latest of three reworded answers in one bubble", async () => {
    const { withoutRestatedLeadSentences } = await import("./events.js");
    const text = [
      "可以，但只收官网自己公开的商务邮箱，个人邮箱和第三方数据库里的不收。我让正在整理的名单按这个标准补。",
      "可以，只收官网自己公开的商务邮箱，个人邮箱和第三方库里的都不收。正在整理的名单按这个标准补。",
      "可以。只收官网自己公开的商务邮箱，个人邮箱和第三方数据库的不收。名单正在按这个标准补，好了就发你。",
    ].join("\n\n");
    const [block] = withoutRestatedLeadSentences([{ kind: "text", text }] as never);
    expect(block).toEqual({
      kind: "text",
      text: "可以。只收官网自己公开的商务邮箱，个人邮箱和第三方数据库的不收。名单正在按这个标准补，好了就发你。",
    });
  });
  it("keeps different paragraphs, lists and short lines", async () => {
    const { dropSupersededParagraphs } = await import("./events.js");
    for (const text of [
      "上海明天有中雨，气温二十到二十三度，出门带伞。\n\n后台现在还有两个任务在跑，大约两分钟后回来。",
      "- **r1**：sleep 60，结束后回「r1好了」\n\n- **r2**：sleep 60，结束后回「r2好了」",
      "好的，已开始。\n\n好的，已开始。",
      "| a | b |\n\n| a | b |",
    ])
      expect(dropSupersededParagraphs(text)).toBe(text);
  });
});
