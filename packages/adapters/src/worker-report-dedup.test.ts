import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBotWorkspacePath } from "./computer-support.js";
import {
  attachedContentKey,
  attachWorkerReportFiles,
  realWorkspacePathToRoot,
  workerFilesAttachedNote,
} from "./dispatcher-relay.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";

vi.mock("./thread-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-artifacts.js")>()),
  attachWorkspaceFileToThread: vi.fn(async (_deps: unknown, input: { filePath: string }) => ({
    artifactId: `artifact-${input.filePath}`,
    block: { kind: "image", artifactId: `artifact-${input.filePath}`, name: input.filePath },
  })),
}));

const BYTES = new Uint8Array([1, 2, 3]);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function relay(options: {
  text: string;
  postedHashes?: string[];
  files?: Record<string, Uint8Array>;
}) {
  const taskCreatedAt = new Date("2026-10-25T16:29:30Z");
  const prisma = {
    bot: { findFirst: vi.fn(async () => ({ id: "worker1" })) },
    backgroundTaskQueue: { findFirst: vi.fn(async () => ({ createdAt: taskCreatedAt })) },
    run: { findMany: vi.fn(async () => [{ id: "earlier" }]) },
    artifact: {
      findMany: vi.fn(async ({ select }: { select: Record<string, boolean> }) =>
        select.hash ? (options.postedHashes ?? []).map((hash) => ({ hash })) : [],
      ),
    },
  };
  const readFile = vi.fn(async (_computer: unknown, path: string) => {
    if (!options.files) return BYTES;
    const bytes = options.files[path];
    if (!bytes) throw new Error("not found");
    return bytes;
  });
  const published: unknown[][] = [];
  const alreadyAttached = new Set<string>();
  const attached = attachWorkerReportFiles({
    deps: {
      artifacts: {},
      prisma,
      sandbox: { readFile },
      events: { notify: vi.fn(async () => undefined) },
    } as never,
    run: {
      id: "run1",
      spaceId: "s",
      threadId: "t",
      botId: "main",
      userId: "u",
      trigger: "bot_message",
    },
    bot: { id: "main" },
    report: { fromBotId: "worker1", text: options.text },
    computerMode: "team",
    readComputer: async () => ({}) as never,
    context: {} as never,
    alreadyAttached,
    publish: async (blocks: unknown[]) => {
      published.push(blocks);
    },
  } as never);
  return { attached, prisma, readFile, published, alreadyAttached, taskCreatedAt };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("worker report content dedup", () => {
  it("skips a file whose bytes this bot already posted in the thread since the task began", async () => {
    const { attached, prisma, readFile, published, taskCreatedAt } = relay({
      text: "文件：\n- /out/puppy.jpg",
      postedHashes: [sha256(BYTES)],
    });
    expect(await attached).toEqual([]);
    expect(readFile).toHaveBeenCalledOnce();
    expect(published).toEqual([]);
    expect(attachWorkspaceFileToThread).not.toHaveBeenCalled();
    // Scoped to this bot's turns in this thread since the worker's task was queued.
    expect(prisma.backgroundTaskQueue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { botId: "main", workerBotId: "worker1", threadId: "t" },
      }),
    );
    expect(prisma.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "main",
          threadId: "t",
          createdAt: { gte: taskCreatedAt },
        }),
      }),
    );
    expect(prisma.artifact.findMany).toHaveBeenCalledWith({
      where: { spaceId: "s", botId: "main", runId: { in: ["earlier", "run1"] } },
      select: { hash: true },
    });
  });

  it("skips bytes the bot posted in the thread before this task began", async () => {
    // A report the main bot attached itself, then a new task's worker lists the same file.
    const { attached, prisma, published } = relay({ text: "文件：\n- /out/report.md" });
    prisma.artifact.findMany.mockImplementation(
      async (args: { select: Record<string, boolean>; where?: { createdAt?: unknown } }) =>
        args.where?.createdAt ? [{ hash: sha256(BYTES) }] : [],
    );
    expect(await attached).toEqual([]);
    expect(published).toEqual([]);
    expect(attachWorkspaceFileToThread).not.toHaveBeenCalled();
  });

  it("skips the .md behind a Page the report already showed, and keeps other files", async () => {
    // Prod 2026-10-26 09:21 (UTC+8): the report showed the Page "大道出海 Expo 迁移进度"; the
    // .md it was written from must not land under it as a second copy.
    const page = new TextEncoder().encode("# 进度\n");
    const { attached, prisma, published } = relay({
      text: "文件：\n- /out/大道出海 Expo 迁移进度.md\n- /out/puppy.jpg",
      files: {
        "out/大道出海 Expo 迁移进度.md": page,
        "out/puppy.jpg": BYTES,
      },
    });
    Object.assign(prisma, {
      message: {
        findMany: vi.fn(async () => [
          {
            role: "user",
            blocks: [
              { kind: "bot_message_received", fromBotName: "Main · 后台1", text: "完成" },
              { kind: "file", artifactId: "page-1" },
            ],
          },
        ]),
      },
    });
    prisma.artifact.findMany.mockImplementation(
      async (args: { select: Record<string, boolean>; where?: { id?: unknown } }) =>
        args.where?.id
          ? [{ hash: sha256(page), kind: "page", name: "大道出海 Expo 迁移进度" }]
          : [],
    );
    expect(await attached).toEqual(["/out/puppy.jpg"]);
    expect(published).toHaveLength(1);
  });

  it("still attaches a file whose bytes differ from what was posted", async () => {
    const { attached, published } = relay({
      text: "文件：\n- /out/puppy.jpg",
      postedHashes: [sha256(new Uint8Array([4, 5, 6]))],
    });
    expect(await attached).toEqual(["/out/puppy.jpg"]);
    expect(published).toHaveLength(1);
  });

  it("attaches two listed copies with identical bytes once", async () => {
    const { attached, published, alreadyAttached } = relay({
      text: "文件：\n- /shared/puppy.jpg\n- /bots/main/puppy-copy.jpg",
    });
    expect(await attached).toEqual(["/shared/puppy.jpg"]);
    expect(published).toHaveLength(1);
    expect(attachWorkspaceFileToThread).toHaveBeenCalledOnce();
    // The model's own attach_file of the same bytes is then recognised as a duplicate.
    expect(alreadyAttached.has(attachedContentKey(BYTES))).toBe(true);
  });
});

describe("attach_file path mapping (team mode)", () => {
  it("maps the computer's real workspace path onto the workspace root", () => {
    const real = "/home/user/rakazo-home/bots/worker1/jobs/p/out/a.jpg";
    expect(realWorkspacePathToRoot(real)).toBe("/bots/worker1/jobs/p/out/a.jpg");
    expect(resolveBotWorkspacePath("team", "main", realWorkspacePathToRoot(real) ?? real)).toBe(
      "bots/worker1/jobs/p/out/a.jpg",
    );
    expect(realWorkspacePathToRoot("/home/desktop/rakazo-home")).toBe("/");
  });

  it("leaves relative, ~/ and other paths to resolve as before", () => {
    for (const path of ["out/a.jpg", "~/shared/a.jpg", "/shared/a.jpg", "/tmp/a.jpg"]) {
      expect(realWorkspacePathToRoot(path)).toBeNull();
    }
  });
});

describe("workerFilesAttachedNote", () => {
  it("names the attached files and tells the model not to resend or promise them", () => {
    const note = workerFilesAttachedNote(["/out/cute-puppy.jpg", "/out/report.md"]);
    expect(note).toMatch(/^已自动附上：cute-puppy\.jpg、report\.md\n/);
    expect(note).toContain("不要再用 attach_file");
    expect(note).toContain("预览还在补");
  });

  it("is absent when nothing was attached", () => {
    expect(workerFilesAttachedNote([])).toBeUndefined();
  });
});
