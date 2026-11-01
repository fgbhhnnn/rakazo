import { describe, expect, it, vi } from "vitest";
import { planGroupReply } from "./group-reply-routing.js";
import { handoffRequestedByHuman } from "./group-requested-handoff.js";

describe("group human priority", () => {
  const text = (value: string) => ({ kind: "text" as const, text: value });
  const relay = {
    role: "user",
    botId: null,
    seq: 3,
    blocks: [{ kind: "bot_message_received", fromBotId: "worker" }, text("@前端 请交给产品")],
  };
  const bots = [
    { id: "leader", name: "产品" },
    { id: "frontend", name: "前端" },
  ];

  it.each([relay, { ...relay, botId: "worker", blocks: [text("@前端 请交给产品")] }])(
    "never interprets a bot's user-role input as a human handoff request",
    async (source) => {
      const findFirst = vi.fn();
      const prisma = {
        message: {
          findUnique: vi.fn(async () => ({ id: "relay", threadId: "group-thread", ...source })),
        },
        chatGroup: { findFirst },
      };
      await handoffRequestedByHuman(
        { prisma } as never,
        {
          id: "run",
          spaceId: "s",
          threadId: "group-thread",
          botId: "frontend",
          userId: "u",
          trigger: "user",
          sourceMessageId: "relay",
        },
        {
          groupId: "group",
          bot: bots[1]!,
          replyText: "页面已完成",
          waitsOnUser: false,
          continued: false,
          handoffTargets: [],
        },
      );
      expect(findFirst).not.toHaveBeenCalled();
    },
  );

  it("preserves a human's addressed members across newer worker relays", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(relay)
      .mockResolvedValueOnce({ role: "user", botId: null, seq: 1, blocks: [text("@前端 做页面")] });
    const prisma = {
      message: { findFirst },
      chatGroup: { findFirst: vi.fn(async () => ({ members: bots.map((bot) => ({ bot })) })) },
    };
    const result = await planGroupReply({ prisma } as never, {
      groupId: "group",
      bot: bots[0]!,
      handedOff: false,
      handoffTargets: [],
      blocks: [text("@前端 做页面")],
      humanTurn: { threadId: "group-thread", before: new Date() },
    });
    expect(result.plan).toBeUndefined();
    expect(findFirst).toHaveBeenCalledTimes(2);
  });
});
