import { randomUUID } from "node:crypto";
import { createDb, runAsSystem } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { backgroundWorkerSpawnKey } from "./background-tasks.js";
import { botModelChoice } from "./worker-model.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("background worker model (PostgreSQL)", () => {
  it("reads the parent's current model at run time and never writes either bot", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const id = `worker-model-${randomUUID()}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    const organizationId = `${id}-org`;
    const system = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
    const select = {
      id: true,
      modelProvider: true,
      modelId: true,
      thinkingLevel: true,
      spawnKey: true,
      parentBotId: true,
    } as const;
    try {
      const { main, worker, child } = await system(async () => {
        await prisma.user.create({
          data: { id: userId, name: "Worker model", email: `${id}@rakazo.test` },
        });
        await prisma.organization.create({
          data: { id: organizationId, name: "Worker model", slug: id, createdAt: new Date() },
        });
        await prisma.space.create({ data: { id: spaceId, organizationId, name: "Worker model" } });
        const main = await prisma.bot.create({
          data: {
            spaceId,
            userId,
            name: "deepseek",
            color: "ink",
            modelProvider: "openai-compatible",
            modelId: "grok-4.7",
            thinkingLevel: "high",
          },
        });
        const worker = await prisma.bot.create({
          data: {
            spaceId,
            userId,
            name: "deepseek · 后台1",
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
        return { main, worker, child };
      });
      const load = (botId: string) =>
        system(() => prisma.bot.findUniqueOrThrow({ where: { id: botId }, select }));
      const resolve = (botId: string) =>
        system(async () => botModelChoice(prisma as never, await load(botId)));

      await expect(resolve(worker.id)).resolves.toMatchObject({
        modelProvider: "openai-compatible",
        modelId: "grok-4.7",
        thinkingLevel: "high",
      });
      await system(() =>
        prisma.bot.update({
          where: { id: main.id },
          data: { modelProvider: "deepseek", modelId: "deepseek-flash", thinkingLevel: null },
        }),
      );
      await expect(resolve(worker.id)).resolves.toMatchObject({
        modelProvider: "deepseek",
        modelId: "deepseek-flash",
        thinkingLevel: null,
      });
      // An ordinary child keeps its own (unset) model and so the existing default.
      await expect(resolve(child.id)).resolves.toMatchObject({
        modelProvider: null,
        modelId: null,
      });
      // A parent without a model leaves the worker on the existing default.
      await system(() =>
        prisma.bot.update({
          where: { id: main.id },
          data: { modelProvider: null, modelId: null, thinkingLevel: null },
        }),
      );
      await expect(resolve(worker.id)).resolves.toMatchObject({
        modelProvider: null,
        modelId: null,
      });
      // Nothing was written to the worker row.
      expect(await load(worker.id)).toMatchObject({
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
      });
    } finally {
      await system(async () => {
        await prisma.bot.deleteMany({ where: { spaceId } });
        await prisma.space.deleteMany({ where: { id: spaceId } });
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }).catch(() => undefined);
      await pool.end();
    }
  });
});
