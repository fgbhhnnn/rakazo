import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { planGroupReply } from "./group-reply-routing.js";
import { persistMessageInTransaction } from "./run-messages.js";
import { createVisibleBotRedactor, visibleBotBlocks, visibleBotText } from "./visible-bot-text.js";

describe("internal handoff annotations at the visible boundary", () => {
  it.each(["（未实际交接）", "（未实际交接给 团队-前端）", "(未实际交接给 前端)"])(
    "removes a routing annotation from final text and every stream split (%#)",
    (annotation) => {
      const text = `已处理。${annotation}继续。`;
      expect(visibleBotText(text)).toBe("已处理。继续。");
      for (let split = 0; split <= text.length; split++) {
        const redactor = createVisibleBotRedactor([]);
        expect(
          redactor.push(text.slice(0, split)) +
            redactor.push(text.slice(split)) +
            redactor.finish(),
        ).toBe("已处理。继续。");
      }
    },
  );

  it("preserves normal parentheses, emoji, prose and secret redaction", () => {
    const text = "进度（未完成） (pending) 😀 fake-password";
    expect(visibleBotText(text)).toBe(text);
    const redactor = createVisibleBotRedactor(["fake-password"]);
    const output = [...text].map((char) => redactor.push(char)).join("") + redactor.finish();
    expect(output).toBe("进度（未完成） (pending) 😀 [redacted]");
  });

  it("hides an unterminated annotation and bounds it at the next line", () => {
    expect(visibleBotText("答复（未实际交接给 前端")).toBe("答复");
    expect(visibleBotText("答复（未实际交接给 前端\n下一行")).toBe("答复\n下一行");
    expect(visibleBotText("普通（未")).toBe("普通（未");
  });

  it("can discard narration without leaking a partial annotation or secret", () => {
    const redactor = createVisibleBotRedactor(["fake-password"]);
    redactor.push("（未实际交接给 前端 fake-pass");
    redactor.skip();
    expect(redactor.push("word）下一步") + redactor.finish()).toBe("下一步");
  });

  it("keeps internal routing diagnostics while stripping durable chat and its realtime event", async () => {
    const blocks: MessageBlock[] = [{ kind: "text", text: "已交给前端。" }];
    const planned = await planGroupReply(
      {
        prisma: {
          chatGroup: {
            findFirst: async () => ({
              members: [{ bot: { id: "fe", name: "前端" } }],
            }),
          },
        },
      } as never,
      { groupId: "g", bot: { id: "be" }, handedOff: false, handoffTargets: [], blocks },
    );
    expect(JSON.stringify(planned.blocks)).toContain("未实际交接");
    const tx = {
      thread: { update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 2 })) },
      run: { findUnique: vi.fn(async () => ({ status: "running", firstResponseAt: new Date() })) },
      message: { create: vi.fn(async () => ({ id: "m" })) },
      event: { create: vi.fn(async () => ({ seq: 1 })) },
    };
    const run = { id: "r", spaceId: "s", threadId: "t", botId: "be" };
    await persistMessageInTransaction(tx as never, run, "bot", planned.blocks);
    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ blocks }) }),
    );
    expect(JSON.stringify(tx.event.create.mock.calls)).not.toContain("未实际交接");
    expect(JSON.stringify(planned.blocks)).toContain("未实际交接");
    await persistMessageInTransaction(tx as never, run, "user", planned.blocks);
    expect(JSON.stringify(tx.message.create.mock.calls.at(-1))).toContain("未实际交接");
  });

  it("strips annotations split over adjacent blocks without mutating the internal blocks", () => {
    const blocks: MessageBlock[] = [
      { kind: "text", text: "Done（未实" },
      { kind: "text", text: "际交接）" },
    ];
    expect(visibleBotBlocks(blocks)).toEqual([{ kind: "text", text: "Done" }]);
    expect(blocks[0]).toEqual({ kind: "text", text: "Done（未实" });
  });
});
