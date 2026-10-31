import { describe, expect, it } from "vitest";
import { backgroundWorkerSpawnKey } from "./background-tasks.js";
import type { ModelChoice } from "./model-selection.js";
import { botModelChoice, isParentBackgroundWorker } from "./worker-model.js";

type Row = ModelChoice & { id: string; spawnKey: string | null; parentBotId: string | null };

function store(rows: Row[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    rows: byId,
    prisma: {
      bot: {
        async findUnique(args: { where: { id: string } }) {
          const row = byId.get(args.where.id);
          return row
            ? {
                modelProvider: row.modelProvider,
                modelId: row.modelId,
                thinkingLevel: row.thinkingLevel,
              }
            : null;
        },
      },
    },
  };
}

const unset = { modelProvider: null, modelId: null, thinkingLevel: null };

describe("background worker model", () => {
  const main: Row = {
    id: "main",
    spawnKey: null,
    parentBotId: null,
    modelProvider: "openai-compatible",
    modelId: "grok-4.7",
    thinkingLevel: "high",
  };
  const worker: Row = {
    id: "worker",
    spawnKey: backgroundWorkerSpawnKey("main", 1),
    parentBotId: "main",
    ...unset,
  };

  it("runs a hidden worker with its parent's model", async () => {
    const { prisma } = store([main, worker]);
    expect(isParentBackgroundWorker(worker)).toBe(true);
    await expect(botModelChoice(prisma, worker)).resolves.toMatchObject({
      id: "worker",
      modelProvider: "openai-compatible",
      modelId: "grok-4.7",
      thinkingLevel: "high",
    });
  });

  it("follows a change to the parent's model on the next run, without writing the worker", async () => {
    const { prisma, rows } = store([main, worker]);
    await botModelChoice(prisma, worker);
    rows.set("main", {
      ...main,
      modelProvider: "deepseek",
      modelId: "deepseek-flash",
      thinkingLevel: null,
    });
    await expect(botModelChoice(prisma, worker)).resolves.toMatchObject({
      modelProvider: "deepseek",
      modelId: "deepseek-flash",
      thinkingLevel: null,
    });
    expect(rows.get("worker")).toMatchObject(unset);
  });

  it("leaves ordinary child bots and top-level bots on their own model", async () => {
    const child: Row = {
      id: "child",
      spawnKey: "run-123:helper",
      parentBotId: "main",
      modelProvider: "anthropic",
      modelId: "claude-x",
      thinkingLevel: null,
    };
    const unsetChild: Row = { ...child, id: "child2", ...unset };
    // A worker key naming a different parent is not this bot's worker.
    const foreign: Row = {
      ...worker,
      id: "foreign",
      spawnKey: backgroundWorkerSpawnKey("other", 1),
    };
    const { prisma } = store([main, child, unsetChild, foreign]);
    for (const bot of [child, unsetChild, foreign, main]) {
      expect(isParentBackgroundWorker(bot)).toBe(false);
      await expect(botModelChoice(prisma, bot)).resolves.toBe(bot);
    }
  });

  it("keeps the existing default when the parent has no model of its own", async () => {
    const { prisma } = store([{ ...main, ...unset }, worker]);
    await expect(botModelChoice(prisma, worker)).resolves.toBe(worker);
    const gone = store([worker]);
    await expect(botModelChoice(gone.prisma, worker)).resolves.toBe(worker);
    const partial = store([{ ...main, modelId: null }, worker]);
    await expect(botModelChoice(partial.prisma, worker)).resolves.toBe(worker);
  });
});
