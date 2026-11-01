import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { groupHandoffVisibleText } from "./group-handoff-run.js";
import { isVisibleGroupReply, visibleGroupReplies } from "./group-visible-reply.js";

describe("visible group reply evidence", () => {
  it.each([
    ["Sources checked.", "Sources checked."],
    ["  Sources\nchecked.  ", "Sources checked"],
    ["来源核对完成。", "来源核对完成"],
  ])("dedupes formatting-only repeats: %s", (text, prior) => {
    expect(isVisibleGroupReply(text, [prior])).toBe(true);
  });

  it.each([
    ["Drafter 已完成，交回 Planner。\n\nDrafter 的结果：\n初稿完成", "初稿完成"],
    ["Initial stage complete; handed back to Planner.", "Initial stage complete."],
    ["Sources checked. Two links need replacing.", "Sources checked."],
    ["The result is not approved.", "The result is approved."],
    ["Processed 101 items.", "Processed 100 items."],
    ["Continue with Writer.", "Continue with Reviewer."],
    ["", ""],
    [" ", " "],
  ])("keeps distinct or empty text: %s", (text, prior) => {
    expect(isVisibleGroupReply(text, [prior])).toBe(false);
  });

  it("compares whole visible messages, including multipart replies and handoff briefs", async () => {
    const findMany = vi.fn(async () => [
      {
        blocks: [
          { kind: "text", text: "Sources " },
          { kind: "text", text: "checked." },
        ],
      },
      { blocks: [{ kind: "handoff", fromBotId: "bot", toBotId: "peer", text: "Please review." }] },
      { blocks: [{ kind: "handoff", fromBotId: "bot", toBotId: "peer", text: "" }] },
      { blocks: [{ kind: "steps", steps: [] }] },
      { blocks: { invalid: true } },
    ]);
    const prisma = { message: { findMany } } as unknown as Parameters<
      typeof visibleGroupReplies
    >[0];
    const run = { id: "run", threadId: "thread", botId: "bot" };
    expect(await visibleGroupReplies(prisma, run)).toEqual(["Sources checked.", "Please review."]);
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: { threadId: "thread", runId: "run", botId: "bot", role: "bot" },
      select: { blocks: true },
    });
  });

  it("requires matching text before hiding an automatic handoff", async () => {
    const brief = "Drafter 已完成，交回 Planner。\n\n初稿完成";
    const posted: { blocks: MessageBlock[] }[] = [{ blocks: [{ kind: "text", text: "初稿完成" }] }];
    const tx = { message: { findMany: vi.fn(async () => posted) } } as unknown as Parameters<
      typeof groupHandoffVisibleText
    >[0];
    const run = { id: "run", threadId: "thread", botId: "bot", userId: "user", spaceId: "space" };
    expect(await groupHandoffVisibleText(tx, run, brief)).toBe(brief);
    posted.push({ blocks: [{ kind: "text", text: brief }] });
    expect(await groupHandoffVisibleText(tx, run, brief)).toBe("");
  });
});
