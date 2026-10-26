import { describe, expect, it, vi } from "vitest";
import { POSTED_ATTACHMENT_WINDOW_MS, postedAttachmentHashes } from "./thread-artifacts.js";

const NOW = new Date("2026-10-26T00:41:00Z");
const at = (time: string) => new Date(`2026-10-26T${time}Z`);

function prismaWith(messages: { createdAt: Date; kinds: string[] }[]) {
  return {
    message: {
      findMany: vi.fn(async () =>
        messages.map((message) => ({
          createdAt: message.createdAt,
          blocks: message.kinds.map((kind) => ({ kind })),
        })),
      ),
    },
    run: { findMany: vi.fn(async () => [{ id: "timed-out" }, { id: "retry" }]) },
    artifact: { findMany: vi.fn(async () => [{ hash: "1ff09a4f" }]) },
  };
}

const input = { spaceId: "s", threadId: "t", botId: "main" };

describe("postedAttachmentHashes", () => {
  it("counts files posted since the user's latest own message, skipping relayed worker messages", async () => {
    // 你把报告发给我看看 (00:38:34), 我就是只重写mobile移动端的 (00:39:03), then a worker relay.
    const prisma = prismaWith([
      { createdAt: at("00:40:30"), kinds: ["bot_message_received", "file"] },
      { createdAt: at("00:39:03"), kinds: ["text"] },
      { createdAt: at("00:38:34"), kinds: ["text"] },
    ]);
    const hashes = await postedAttachmentHashes(
      prisma as never,
      { ...input, sinceUserTurn: true },
      NOW,
    );
    expect(hashes).toEqual(new Set(["sha256:1ff09a4f"]));
    expect(prisma.artifact.findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "s",
        botId: "main",
        runId: { in: ["timed-out", "retry"] },
        createdAt: { gte: at("00:39:03") },
      },
      select: { hash: true },
    });
    expect(prisma.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "t", botId: "main" }),
      }),
    );
  });

  it("looks back over the whole window for automatic posts and when the user has not written", async () => {
    const windowStart = new Date(NOW.getTime() - POSTED_ATTACHMENT_WINDOW_MS);
    for (const sinceUserTurn of [false, true]) {
      const prisma = prismaWith([]);
      await postedAttachmentHashes(prisma as never, { ...input, sinceUserTurn }, NOW);
      expect(prisma.artifact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ createdAt: { gte: windowStart } }),
        }),
      );
      expect(prisma.message.findMany).toHaveBeenCalledTimes(sinceUserTurn ? 1 : 0);
    }
  });

  it("treats a failed lookup as nothing posted", async () => {
    const prisma = prismaWith([]);
    prisma.run.findMany.mockRejectedValueOnce(new Error("db down"));
    expect(await postedAttachmentHashes(prisma as never, input, NOW)).toEqual(new Set());
  });
});
