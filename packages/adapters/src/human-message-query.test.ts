import { describe, expect, it, vi } from "vitest";
import { humanAnchor } from "./group-team-run-anchor.js";
import { newerHumanMessage } from "./group-team-run-gate.js";
import { findHumanAuthoredMessage } from "./human-message-query.js";

const human = {
  id: "human",
  seq: 1,
  role: "user",
  botId: null,
  blocks: [{ kind: "text", text: "go" }],
};
const relay = {
  id: "relay",
  seq: 2,
  role: "user",
  botId: null,
  blocks: [{ kind: "bot_message_received", fromBotId: "worker" }],
};

describe("human message queries", () => {
  it("keeps the original human anchor across several worker results", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({ ...relay, seq: 3 })
      .mockResolvedValueOnce(relay)
      .mockResolvedValueOnce(human);
    const at = new Date("2026-01-01T00:00:00Z");
    expect(await humanAnchor({ message: { findFirst } } as never, "thread", at)).toEqual(human);
    expect(findFirst.mock.calls.map(([args]) => args.where)).toEqual([
      { threadId: "thread", role: "user", createdAt: { lte: at } },
      { role: "user", AND: [{ threadId: "thread", createdAt: { lte: at } }, { seq: { lt: 3 } }] },
      { role: "user", AND: [{ threadId: "thread", createdAt: { lte: at } }, { seq: { lt: 2 } }] },
    ]);
  });

  it("does not interrupt for a user-role relay, but still interrupts for a human", async () => {
    const findFirst = vi.fn().mockResolvedValueOnce(relay).mockResolvedValueOnce(null);
    const prisma = { message: { findFirst } } as never;
    expect(await newerHumanMessage(prisma, "thread", 1)).toBe(false);
    expect(findFirst.mock.calls[1]?.[0].where).toEqual({
      role: "user",
      AND: [{ threadId: "thread", seq: { gt: 1 } }, { seq: { lt: 2 } }],
    });
    findFirst.mockResolvedValueOnce({ ...human, seq: 3 });
    expect(await newerHumanMessage(prisma, "thread", 1)).toBe(true);
  });

  it("preserves all query constraints while scanning and returns null with no human", async () => {
    const findFirst = vi.fn().mockResolvedValueOnce(relay).mockResolvedValueOnce(null);
    const where = { threadId: "thread", seq: { gt: 0, lt: 5 }, AND: [{ botId: null }] };
    expect(await findHumanAuthoredMessage({ message: { findFirst } } as never, where)).toBeNull();
    expect(findFirst.mock.calls[1]?.[0].where).toEqual({
      role: "user",
      AND: [where, { seq: { lt: 2 } }],
    });
  });
});
