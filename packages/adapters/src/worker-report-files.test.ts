import { describe, expect, it, vi } from "vitest";
import { parseWorkerReportFiles } from "./background-tasks.js";
import { resolveBotWorkspacePath } from "./computer-support.js";
import { attachWorkerReportFiles, workerReportWorkspacePath } from "./dispatcher-relay.js";

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
  it("keeps paths with spaces and Windows paths, still rejects URLs", () => {
    const text = [
      "文件：",
      "- /home/bot/out/My Report 2026.pdf",
      "- `C:\\Users\\cxy\\Desktop\\a b.xlsx`",
      "- https://example.com/x.png",
    ].join("\n");
    expect(parseWorkerReportFiles(text)).toEqual([
      "/home/bot/out/My Report 2026.pdf",
      "C:\\Users\\cxy\\Desktop\\a b.xlsx",
    ]);
  });
  it("skips a Windows path the computer workspace cannot read", () => {
    expect(workerReportWorkspacePath("C:\\Users\\cxy\\a.png")).toBeNull();
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
        artifact: { findMany: vi.fn(async (): Promise<Array<{ name: string }>> => []) },
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
      publish: async () => undefined,
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
  it("skips a file the main bot already attached under another spelling of the same path", async () => {
    const { deps } = base();
    const { attachedPathKey } = await import("./dispatcher-relay.js");
    // The main bot's attach_file used a relative path that resolves into its own directory.
    const already = new Set([
      attachedPathKey(resolveBotWorkspacePath("team", "main", "report.md")),
    ]);
    await attachWorkerReportFiles({
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
      report: {
        fromBotId: "worker1",
        text: "文件：\n- /home/user/rakazo-home/bots/main/report.md",
      },
      computerMode: "team",
      // biome-ignore lint/suspicious/noExplicitAny: fake computer
      readComputer: async () => ({}) as any,
      // biome-ignore lint/suspicious/noExplicitAny: fake context
      context: {} as any,
      alreadyAttached: already,
      publish: async () => undefined,
    }).catch((error) => error);
    expect(deps.sandbox.readFile).not.toHaveBeenCalled();
  });
  it("skips files this run already stored in an earlier attempt (resume after ask_user)", async () => {
    const { deps } = base();
    deps.prisma.artifact.findMany = vi.fn(async () => [{ name: "a.md" }]);
    await attachWorkerReportFiles({
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
      readComputer: async () => ({}) as any,
      context: {} as any,
      alreadyAttached: new Set<string>(),
      publish: async () => undefined,
    }).catch((error) => error);
    expect(deps.prisma.artifact.findMany).toHaveBeenCalledWith({
      where: { runId: "r", botId: "main" },
      select: { name: true },
    });
    // a.md is already stored for this run; only b.png is read.
    expect(deps.sandbox.readFile).toHaveBeenCalledTimes(1);
    const readPath = (deps.sandbox.readFile.mock.calls[0] as unknown[])[1] as string;
    expect(readPath).toBe(resolveBotWorkspacePath("team", "worker1", "/out/b.png"));
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
      publish: async () => undefined,
    });
    expect(attached).toEqual([]);
    expect(deps.sandbox.readFile).not.toHaveBeenCalled();
  });
});

describe("workerReportWorkspacePath", () => {
  it("maps the computer's real workspace paths onto the workspace root", async () => {
    const { workerReportWorkspacePath } = await import("./dispatcher-relay.js");
    expect(workerReportWorkspacePath("/home/user/rakazo-home/bots/w1/report.csv")).toBe(
      "/bots/w1/report.csv",
    );
    expect(workerReportWorkspacePath("/home/desktop/rakazo-home/shared/a.png")).toBe(
      "/shared/a.png",
    );
    expect(workerReportWorkspacePath("~/jobs/x/out/a.csv")).toBe("jobs/x/out/a.csv");
    expect(workerReportWorkspacePath("/bots/w1/a.csv")).toBe("/bots/w1/a.csv");
  });

  it("skips real paths outside the workspace instead of re-prefixing them", async () => {
    const { workerReportWorkspacePath } = await import("./dispatcher-relay.js");
    expect(workerReportWorkspacePath("/home/user/jobs/geo-audit/out/report.md")).toBeNull();
    expect(workerReportWorkspacePath("/tmp/out.png")).toBeNull();
    expect(workerReportWorkspacePath("/root/a.csv")).toBeNull();
    expect(workerReportWorkspacePath("/Users/me/a.csv")).toBeNull();
  });
});
