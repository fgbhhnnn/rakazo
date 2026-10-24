import { randomUUID } from "node:crypto";
import { createDb, runAsSystem } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { backgroundWorkerSpawnKey } from "./background-tasks.js";
import { listBotSecrets } from "./bot-secrets.js";
import { loadAgentScratchpadContext } from "./scratchpad-context.js";
import { listScratchpadItemsFromTool } from "./scratchpad-tools.js";
import { dataBotId, loadWorkerOwner, mcpScopeBotId } from "./worker-owner-scope.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("hidden worker uses its main bot's data (PostgreSQL)", () => {
  it("scopes secrets, MCP servers, taught skills and scratchpad to the main bot without writes", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const id = `worker-scope-${randomUUID()}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    const organizationId = `${id}-org`;
    const system = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
    const botSelect = { id: true, spawnKey: true, parentBotId: true, updatedAt: true } as const;
    try {
      const { main, worker, child } = await system(async () => {
        await prisma.user.create({
          data: { id: userId, name: "Worker scope", email: `${id}@rakazo.test` },
        });
        await prisma.organization.create({
          data: { id: organizationId, name: "Worker scope", slug: id, createdAt: new Date() },
        });
        await prisma.space.create({ data: { id: spaceId, organizationId, name: "Worker scope" } });
        const main = await prisma.bot.create({
          data: { spaceId, userId, name: "main", color: "ink", memoryScope: "shared" },
        });
        const worker = await prisma.bot.create({
          data: {
            spaceId,
            userId,
            name: "main · 后台1",
            color: "ink",
            parentBotId: main.id,
            spawnKey: backgroundWorkerSpawnKey(main.id, 1),
          },
        });
        const child = await prisma.bot.create({
          data: {
            spaceId,
            userId,
            name: "helper",
            color: "ink",
            parentBotId: main.id,
            spawnKey: `${id}:helper`,
          },
        });
        await prisma.botSecret.create({
          data: {
            id: `${id}-secret`,
            userId,
            spaceId,
            botId: main.id,
            name: "github",
            origin: "https://api.github.com",
            auth: { type: "bearer" },
            ciphertext: "not-a-real-ciphertext",
          },
        });
        const server = await prisma.mcpServer.create({
          data: { spaceId, userId, slug: `${id}-mcp`, name: "Docs", transport: "http" },
        });
        await prisma.botMcpServer.create({
          data: { spaceId, userId, botId: main.id, serverId: server.id },
        });
        await prisma.taughtSkill.create({
          data: {
            spaceId,
            userId,
            botId: main.id,
            name: "deploy",
            goal: "deploy",
            status: "saved",
          },
        });
        await prisma.scratchpadItem.create({
          data: { spaceId, userId, botId: main.id, title: "follow up on #A1" },
        });
        return { main, worker, child };
      });
      const load = (botId: string) =>
        system(() => prisma.bot.findUniqueOrThrow({ where: { id: botId }, select: botSelect }));
      const workerRow = await load(worker.id);
      const childRow = await load(child.id);
      const workerData = dataBotId(workerRow);
      expect(workerData).toBe(main.id);
      expect(dataBotId(childRow)).toBe(child.id);

      await system(async () => {
        // Saved credentials (command variables, login fills, secret_request, list_secrets).
        expect(
          (await listBotSecrets(prisma, { userId, spaceId, botId: workerData })).map((s) => s.name),
        ).toEqual(["github"]);
        expect(await listBotSecrets(prisma, { userId, spaceId, botId: child.id })).toEqual([]);

        // MCP servers: the connector looks up assignments by the scoped id.
        expect(await mcpScopeBotId(prisma, worker.id)).toBe(main.id);
        expect(await mcpScopeBotId(prisma, child.id)).toBe(child.id);
        expect(await mcpScopeBotId(prisma, main.id)).toBe(main.id);
        expect(await mcpScopeBotId(prisma, `${id}-missing`)).toBe(`${id}-missing`);
        const assigned = await prisma.botMcpServer.count({
          where: { botId: await mcpScopeBotId(prisma, worker.id), spaceId, userId },
        });
        expect(assigned).toBe(1);
        expect(
          await prisma.botMcpServer.count({
            where: { botId: await mcpScopeBotId(prisma, child.id), spaceId, userId },
          }),
        ).toBe(0);

        // Taught skills.
        expect(
          await prisma.taughtSkill.count({
            where: { botId: workerData, spaceId, status: "saved" },
          }),
        ).toBe(1);

        // Scratchpad context and tools.
        const context = await loadAgentScratchpadContext(
          { prisma },
          { spaceId, botId: workerData },
        );
        expect(context).toContain("follow up on #A1");
        expect(
          await loadAgentScratchpadContext({ prisma }, { spaceId, botId: child.id }),
        ).toBeUndefined();
        const listed = await listScratchpadItemsFromTool({ prisma } as never, {
          spaceId,
          botId: workerData,
        });
        expect(listed.items.map((item) => item.title)).toEqual(["follow up on #A1"]);

        // Memory: the worker uses the main bot's id and memory scope.
        expect(await loadWorkerOwner(prisma, workerRow)).toEqual({
          id: main.id,
          memoryScope: "shared",
        });
        expect(await loadWorkerOwner(prisma, childRow)).toBeNull();
      });

      // Nothing was copied to or written on the worker.
      await system(async () => {
        expect(await prisma.botSecret.count({ where: { botId: worker.id } })).toBe(0);
        expect(await prisma.botMcpServer.count({ where: { botId: worker.id } })).toBe(0);
        expect(await prisma.taughtSkill.count({ where: { botId: worker.id } })).toBe(0);
        expect(await prisma.scratchpadItem.count({ where: { botId: worker.id } })).toBe(0);
      });
      expect((await load(worker.id)).updatedAt).toEqual(workerRow.updatedAt);
    } finally {
      await system(async () => {
        await prisma.bot.deleteMany({ where: { spaceId } });
        await prisma.mcpServer.deleteMany({ where: { spaceId } });
        await prisma.space.deleteMany({ where: { id: spaceId } });
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }).catch(() => undefined);
      await pool.end();
    }
  });
});
