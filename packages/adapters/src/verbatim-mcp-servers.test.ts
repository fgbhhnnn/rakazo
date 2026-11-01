import { describe, expect, it, vi } from "vitest";
import { verbatimMcpServersForRun } from "./verbatim-mcp-servers.js";

describe("verbatim MCP server scope", () => {
  it.each([
    { id: "main", parentBotId: null, spawnKey: null, scopeBotId: "main" },
    { id: "worker", parentBotId: "main", spawnKey: "bg-worker:main:1", scopeBotId: "main" },
    { id: "child", parentBotId: "main", spawnKey: "main:helper", scopeBotId: "child" },
  ])("uses $scopeBotId's assigned and shared servers for $id", async (bot) => {
    const findMany = vi.fn(async () => [{ id: "server", slug: "demo" }]);
    const prisma = {
      bot: { findUnique: async () => bot },
      mcpServer: { findMany },
    };
    await expect(
      verbatimMcpServersForRun(prisma as never, {
        botId: bot.id,
        spaceId: "space",
        userId: "user",
      }),
    ).resolves.toEqual({ ids: ["server"], slugs: ["demo"] });
    expect(findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        verbatimResults: true,
        enabled: true,
        userId: "user",
        AND: [{ OR: [{ allBots: true }, { assignments: { some: { botId: bot.scopeBotId } } }] }],
      }),
      select: { id: true, slug: true },
    });
  });

  it("keeps the normal result policy when no server requests verbatim results", async () => {
    const prisma = { mcpServer: { findMany: async () => [] } };
    await expect(
      verbatimMcpServersForRun(prisma as never, {
        botId: "main",
        spaceId: "space",
        userId: "user",
      }),
    ).resolves.toBeUndefined();
  });
});
