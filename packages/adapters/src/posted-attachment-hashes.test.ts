import { describe, expect, it, vi } from "vitest";
import {
  alreadyPostedFile,
  POSTED_ATTACHMENT_WINDOW_MS,
  pageTitleKey,
  postedAttachmentHashes,
} from "./thread-artifacts.js";

const NOW = new Date("2026-10-26T00:41:00Z");
const at = (time: string) => new Date(`2026-10-26T${time}Z`);

type ThreadArtifact = { id: string; hash: string; kind: string | null; name: string };

function prismaWith(
  messages: { createdAt: Date; kinds: string[] }[],
  thread: { role: string; blocks: unknown[] }[] = [],
  artifacts: ThreadArtifact[] = [],
) {
  return {
    message: {
      // The user-turn lookup filters on role; the thread scan reads every message.
      findMany: vi.fn(async ({ where }: { where: { role?: string } }) =>
        where.role
          ? messages.map((message) => ({
              createdAt: message.createdAt,
              blocks: message.kinds.map((kind) => ({ kind })),
            }))
          : thread,
      ),
    },
    run: { findMany: vi.fn(async () => [{ id: "timed-out" }, { id: "retry" }]) },
    artifact: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        where.id
          ? artifacts.filter((artifact) => where.id?.in.includes(artifact.id))
          : [{ hash: "1ff09a4f" }],
      ),
    },
  };
}

const userTurnLookups = (prisma: ReturnType<typeof prismaWith>) =>
  prisma.message.findMany.mock.calls.filter(([args]) => args.where.role === "user").length;

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
      expect(userTurnLookups(prisma)).toBe(sinceUserTurn ? 1 : 0);
    }
  });

  it("counts the Page a relayed worker report showed, by bytes and by title", async () => {
    // Prod 2026-10-26 09:21 (UTC+8): the worker's run (another thread) published the Page and
    // the relay put it in the main thread, so the main bot's runs never owned it.
    const relay = {
      role: "user",
      blocks: [
        { kind: "bot_message_received", fromBotName: "UniApp → Expo 迁移 · 后台1", text: "完成" },
        { kind: "file", artifactId: "page-1" },
      ],
    };
    const upload = { role: "user", blocks: [{ kind: "file", artifactId: "upload-1" }] };
    const prisma = prismaWith(
      [],
      [relay, upload],
      [
        { id: "page-1", hash: "a2debda7", kind: "page", name: "大道出海 Expo 迁移进度" },
        { id: "upload-1", hash: "u5e7", kind: null, name: "mine.md" },
      ],
    );
    const keys = await postedAttachmentHashes(prisma as never, input, NOW);
    expect(keys).toEqual(
      new Set(["sha256:1ff09a4f", "sha256:a2debda7", "page:大道出海 expo 迁移进度"]),
    );
    expect(prisma.artifact.findMany).toHaveBeenCalledWith({
      where: { spaceId: "s", id: { in: ["page-1"] } },
      select: { hash: true, kind: true, name: true },
    });
    expect(alreadyPostedFile(keys, "sha256:a2debda7", "/x/whatever.md")).toBe(true);
    expect(alreadyPostedFile(keys, "sha256:new", "/x/大道出海 Expo 迁移进度.md")).toBe(true);
    expect(alreadyPostedFile(keys, "sha256:new", "/x/大道出海 Expo 迁移进度.html")).toBe(true);
    // Only a Page's source or export matches by name: a chart named like it still goes out.
    expect(alreadyPostedFile(keys, "sha256:new", "/x/大道出海 Expo 迁移进度.png")).toBe(false);
    expect(alreadyPostedFile(keys, "sha256:new", "/x/other.md")).toBe(false);
    expect(pageTitleKey("a/B.MD")).toBe("page:b");
  });

  it("keeps the bot's own posts when the thread scan fails", async () => {
    const prisma = prismaWith([]);
    prisma.message.findMany.mockRejectedValueOnce(new Error("db down"));
    expect(await postedAttachmentHashes(prisma as never, input, NOW)).toEqual(
      new Set(["sha256:1ff09a4f"]),
    );
  });

  it("treats a failed lookup as nothing posted", async () => {
    const prisma = prismaWith([]);
    prisma.run.findMany.mockRejectedValueOnce(new Error("db down"));
    expect(await postedAttachmentHashes(prisma as never, input, NOW)).toEqual(new Set());
  });
});
