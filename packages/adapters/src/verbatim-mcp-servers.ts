import type { PrismaClient } from "@rakazo/db";
import { availableInSpace } from "@rakazo/db";
import { mcpScopeBotId } from "./worker-owner-scope.js";

/** Same reach as the MCP connector: usable servers assigned to the bot or shared with every bot. */
export async function verbatimMcpServersForRun(
  prisma: PrismaClient,
  scope: { botId: string; spaceId: string; userId: string },
) {
  if (!prisma.mcpServer?.findMany) return undefined;
  const botId = await mcpScopeBotId(prisma, scope.botId);
  const servers = await prisma.mcpServer.findMany({
    where: {
      verbatimResults: true,
      enabled: true,
      ...availableInSpace(scope),
      AND: [{ OR: [{ allBots: true }, { assignments: { some: { botId } } }] }],
    },
    select: { id: true, slug: true },
  });
  if (!servers?.length) return undefined;
  return { ids: servers.map((server) => server.id), slugs: servers.map((server) => server.slug) };
}
