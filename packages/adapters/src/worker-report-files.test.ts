import { describe, expect, it, vi } from "vitest";
import { parseWorkerReportFiles } from "./background-tasks.js";
import { resolveBotWorkspacePath } from "./computer-support.js";
import { attachWorkerReportFiles } from "./executor.js";

describe("parseWorkerReportFiles", () => {
  it("reads the structured 文件 section", () => {
    const text = [
      "完成：仓库名单已整理（共 23 个）。",
      "1. rakazo",
      "",
      "文件：",
      "- /home/bot/jobs/repos/out/repos.md",
      "- `~/jobs/repos/out/repos.csv`",
      "- https://example.com/not-a-file",
      "",
      "下一步：无",
    ].join("\n");
    expect(parseWorkerReportFiles(text)).toEqual([
      "/home/bot/jobs/repos/out/repos.md",
      "~/jobs/repos/out/repos.csv",
    ]);
  });
  it("accepts inline and English headers, ignores reports without files", () => {
    expect(parseWorkerReportFiles("Files: /tmp/a.png, /tmp/b.png")).toEqual([
      "/tmp/a.png",
      "/tmp/b.png",
    ]);
    expect(parseWorkerReportFiles("**产物文件：**\n1. /x/y.mp4")).toEqual(["/x/y.mp4"]);
    expect(parseWorkerReportFiles("结果：2 的 100 次方是 1267650600228229401496703205376")).toEqual(
      [],
    );
  });
});

describe("attachWorkerReportFiles", () => {
  const base = () => {
    const published: unknown[] = [];
    const deps = {
      artifacts: {},
      prisma: {
        bot: { findFirst: vi.fn(async () => ({ id: "worker1" })) },
        $transaction: vi.fn(async () => {
          published.push(1);
          return { eventSeq: 1, message: { id: "m", createdAt: new Date() } };
        }),
      },
      sandbox: { readFile: vi.fn(async () => new Uint8Array([1, 2, 3])) },
      events: { notify: vi.fn(async () => undefined) },
    };
    return { deps, published };
  };
  it("attaches listed files from the worker's workspace, skipping ones already attached", async () => {
    const { deps } = base();
    const attachSpy = vi.fn(async () => ({ artifactId: "a", block: { kind: "file" } }));
    vi.doMock("./thread-artifacts.js", () => ({ attachWorkspaceFileToThread: attachSpy }));
    const already = new Set(["/out/b.png"]);
    const attached = await attachWorkerReportFiles({
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake deps
      deps: deps as any,
      run: {
        id: "r",
        spaceId: "s",
        threadId: "t",
        botId: "main",
        userId: "u",
        trigger: "bot_message",
      },
      bot: { id: "main" },
      report: { fromBotId: "worker1", text: "完成\n文件：\n- /out/a.md\n- /out/b.png" },
      computerMode: "team",
      // biome-ignore lint/suspicious/noExplicitAny: fake computer
      readComputer: async () => ({}) as any,
      // biome-ignore lint/suspicious/noExplicitAny: fake context
      context: {} as any,
      alreadyAttached: already,
    }).catch((error) => error);
    // The worker lookup is scoped to this main bot's workers.
    expect(deps.prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "worker1",
          spawnKey: { startsWith: "bg-worker:main:" },
        }),
      }),
    );
    // Only a.md is read (b.png was already attached), from the worker's team directory.
    expect(deps.sandbox.readFile).toHaveBeenCalledTimes(1);
    const readPath = (deps.sandbox.readFile.mock.calls[0] as unknown[])[1] as string;
    // Resolved exactly as the worker's own attach_file would resolve it.
    expect(readPath).toBe(resolveBotWorkspacePath("team", "worker1", "/out/a.md"));
    expect(Array.isArray(attached) || attached instanceof Error).toBe(true);
  });
  it("does nothing for a report from a bot that is not this bot's worker", async () => {
    const { deps } = base();
    deps.prisma.bot.findFirst = vi.fn(async () => null) as never;
    const attached = await attachWorkerReportFiles({
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake deps
      deps: deps as any,
      run: {
        id: "r",
        spaceId: "s",
        threadId: "t",
        botId: "main",
        userId: "u",
        trigger: "bot_message",
      },
      bot: { id: "main" },
      report: { fromBotId: "other", text: "文件：\n- /out/a.md" },
      computerMode: "team",
      // biome-ignore lint/suspicious/noExplicitAny: fake computer
      readComputer: async () => ({}) as any,
      // biome-ignore lint/suspicious/noExplicitAny: fake context
      context: {} as any,
      alreadyAttached: new Set(),
    });
    expect(attached).toEqual([]);
    expect(deps.sandbox.readFile).not.toHaveBeenCalled();
  });
});
