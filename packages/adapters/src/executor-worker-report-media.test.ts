import { createHash } from "node:crypto";
import type { AgentRunRequest, ComputerRef } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { AppendEventInput, Prisma } from "@rakazo/db";
import { appendEventInTransaction } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBotMessageContext } from "./bot-messages.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { resolveBotWorkspacePath } from "./computer-support.js";
import { createRunExecutor } from "./executor.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";

const COMPUTER: ComputerRef = {
  id: "sandbox-1",
  botId: "home-1",
  kind: "e2b",
  providerRef: "sandbox-1",
};

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer: vi.fn(async () => COMPUTER),
}));

vi.mock("./bot-messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-messages.js")>()),
  loadBotMessageContext: vi.fn(async () => undefined),
  returnBotMessageOutcome: vi.fn(async () => undefined),
}));

vi.mock("./thread-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-artifacts.js")>()),
  attachWorkspaceFileToThread: vi.fn(),
}));

const PUPPY = new Uint8Array([9, 8, 7, 6, 5]);
const WORKER_FILE = "/home/user/rakazo-home/bots/worker-1/jobs/cute-puppy/out/cute-puppy.jpg";

/**
 * One main-bot turn in team computer mode. A bot_message run is the wake for a worker's
 * result; a user run is a plain turn. The model makes `toolCalls`, then answers.
 */
async function runMainTurn(options: {
  trigger: "bot_message" | "user";
  reportText?: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  files?: Record<string, Uint8Array>;
  /** Hashes of artifacts this bot already posted in the thread for the task. */
  postedHashes?: string[];
}) {
  vi.mocked(loadBotMessageContext).mockResolvedValue(
    options.reportText
      ? {
          kind: "bot_message_received",
          fromBotId: "worker-1",
          fromBotName: "Assistant · 后台1",
          text: options.reportText,
          intent: "result",
          hop: 2,
          repliesToRequest: true,
        }
      : undefined,
  );
  let artifactCount = 0;
  vi.mocked(attachWorkspaceFileToThread).mockImplementation(async (_deps, input) => {
    artifactCount += 1;
    const name = input.filePath.split("/").at(-1)!;
    return {
      artifactId: `artifact-${artifactCount}`,
      block: {
        kind: "image",
        artifactId: `artifact-${artifactCount}`,
        mimeType: "image/jpeg",
        name,
      },
    } as Awaited<ReturnType<typeof attachWorkspaceFileToThread>>;
  });
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: options.trigger,
    sourceMessageId: "source-1",
    retryOfRunId: null,
    leaseFence: 0,
    createdAt: new Date(),
  };
  const messages: { blocks: MessageBlock[] }[] = [];
  const savedEvents: AppendEventInput[] = [];
  const toolResults: unknown[] = [];
  let imagesBeforeModel = -1;
  let prompt = "";
  const images = () =>
    messages.flatMap((message) => message.blocks.filter((block) => block.kind === "image"));
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    imagesBeforeModel = images().length;
    prompt = request.prompt;
    for (const [index, call] of options.toolCalls.entries())
      toolResults.push(await request.executeTool?.(call.name, call.args, `exec-${index}`));
    yield { type: "text" as const, text: "小狗图片好了，已经发在上面。" };
    yield { type: "done" as const, text: "小狗图片好了，已经发在上面。" };
  });
  const files = options.files ?? {};
  const readFile = vi.fn(async (_computer: unknown, filePath: string) => {
    const bytes = files[filePath];
    if (!bytes) throw new Error("not found");
    return bytes;
  });
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => [{ id: "earlier-run" }, { id: run.id }]),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        spawnKey: null,
        disabledBuiltinTools: [],
        computer: { id: "computer-1", scope: "team", kind: "e2b", homeKey: "home-1" },
      })),
      findUnique: vi.fn(async () => ({ name: "Assistant" })),
      // The report's sender is this bot's (computer-lane) background worker.
      findFirst: vi.fn(async () => ({ id: "worker-1", spawnKey: "bg-worker:bot-1:1" })),
      findMany: vi.fn(async () => []),
    },
    backgroundTaskQueue: {
      findFirst: vi.fn(async () => ({ createdAt: new Date("2026-10-25T16:29:30Z") })),
      findMany: vi.fn(async () => []),
    },
    artifact: {
      findMany: vi.fn(async ({ select }: { select: Record<string, boolean> }) =>
        select.hash ? (options.postedHashes ?? []).map((hash) => ({ hash })) : [],
      ),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      findMany: vi.fn(async () => []),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      update: vi.fn(async () => ({
        nextMessageSeq: messages.length + 1,
        nextEventSeq: savedEvents.length + 1,
      })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 3,
      })),
    },
    event: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: AppendEventInput }) => {
        savedEvents.push(data);
        return { ...data, seq: savedEvents.length };
      }),
    },
    message: {
      create: vi.fn(async ({ data }: { data: { blocks: MessageBlock[] } }) => {
        messages.push(data);
        return { ...data, id: `message-${messages.length}`, createdAt: new Date() };
      }),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Relay" })) },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    externalEffect: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `effect-${String(data.idempotencyKey)}`,
        ...data,
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    connection: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "fixture-model",
      })),
    },
    computerExecutionLease: {
      updateManyAndReturn: vi.fn(async () => [{ fence: 1 }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $queryRaw: vi.fn(async () => [{ id: "row-1", scope: "team" }]),
    $transaction: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prismaProxy),
    ),
  };
  const prismaProxy = withEmptyModels(prisma);
  const finalizeRun = vi.fn(async (_input: { blocks: MessageBlock[] }) => ({
    continuationRunId: null,
  }));
  const executor = createRunExecutor({
    deploymentModelKey: "fixture-model-key",
    prisma: prismaProxy,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ id: "e2b", capabilities: { graphical: false } }),
      readFile,
      writeFile: vi.fn(async () => undefined),
      listFiles: vi.fn(async () => []),
      releaseScreen: vi.fn(async () => undefined),
      async *exportWorkspace() {
        yield* [];
      },
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get: vi.fn(async () => new Uint8Array()), put: vi.fn(), remove: vi.fn() },
    events: {
      append: vi.fn(async (event: AppendEventInput) =>
        appendEventInTransaction(prismaProxy as unknown as Prisma.TransactionClient, event),
      ),
      finalizeRun,
      pauseRunForInput: vi.fn(async () => ({ continuationRunId: null })),
      pauseRunForTakeover: vi.fn(async () => false),
      notify: vi.fn(async () => undefined),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
    dispatcherMode: true,
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalled();
  expect(toolResults).toHaveLength(options.toolCalls.length);
  expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  const finalBlocks = finalizeRun.mock.calls.flatMap(([input]) => input.blocks ?? []);
  return {
    images: [...images(), ...finalBlocks.filter((block) => block.kind === "image")],
    imagesBeforeModel,
    prompt,
    readFile,
    toolResults,
    finalizeRun,
  };
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Models the run reads but these tests do not care about behave as empty tables. */
function withEmptyModels<T extends object>(prisma: T): T {
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  return new Proxy(prisma, {
    get: (target, key) => (key in target ? target[key as keyof T] : empty),
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

const workerPath = (file: string) =>
  resolveBotWorkspacePath("team", "worker-1", file.replace(/^\/home\/user\/rakazo-home/, ""));

describe("a worker's image relayed to the main chat", () => {
  it("posts the image once, before the model's turn, when the model also attaches it", async () => {
    const { images, imagesBeforeModel, prompt, toolResults } = await runMainTurn({
      trigger: "bot_message",
      reportText: `【后台任务：生成小狗图片 #TMAGKGNI】\n已生成。\n\n文件：\n- ${WORKER_FILE}`,
      // The model ignores the note and attaches the reported file itself anyway.
      toolCalls: [{ name: "attach_file", args: { path: WORKER_FILE } }],
      files: { [workerPath(WORKER_FILE)]: PUPPY },
    });
    expect(images).toHaveLength(1);
    expect(imagesBeforeModel).toBe(1);
    expect(prompt).toContain("已自动附上：cute-puppy.jpg");
    expect(toolResults[0]).toEqual(
      expect.objectContaining({ ok: true, alreadyAttached: true, path: WORKER_FILE }),
    );
  });

  it("posts one image when the report lists two copies with the same bytes", async () => {
    const shared = "/home/user/rakazo-home/shared/cute-puppy.jpg";
    const mine = "/home/user/rakazo-home/bots/bot-1/cute-puppy.jpg";
    const { images, prompt } = await runMainTurn({
      trigger: "bot_message",
      reportText: `复制成功。\n\n文件：\n- ${shared}\n- ${mine}`,
      toolCalls: [],
      files: { [workerPath(shared)]: PUPPY, [workerPath(mine)]: PUPPY },
    });
    expect(images).toHaveLength(1);
    expect(prompt).toContain("已自动附上：cute-puppy.jpg");
  });

  it("posts nothing again for bytes an earlier turn of this task already posted", async () => {
    const { images, prompt } = await runMainTurn({
      trigger: "bot_message",
      reportText: `文件：\n- ${WORKER_FILE}`,
      toolCalls: [],
      files: { [workerPath(WORKER_FILE)]: PUPPY },
      postedHashes: [sha256(PUPPY)],
    });
    expect(images).toHaveLength(0);
    expect(prompt).not.toContain("已自动附上");
  });

  it("adds no note to a wake whose report lists no files", async () => {
    const { images, prompt, readFile } = await runMainTurn({
      trigger: "bot_message",
      reportText: "完成：答案是 42。",
      toolCalls: [],
    });
    expect(images).toHaveLength(0);
    expect(readFile).not.toHaveBeenCalled();
    expect(prompt).not.toContain("已自动附上");
  });
});

describe("attach_file paths in team mode", () => {
  it("maps the computer's real workspace path onto the workspace root", async () => {
    const real = "/home/user/rakazo-home/bots/worker-1/jobs/p/out/a.jpg";
    const { readFile, toolResults, images } = await runMainTurn({
      trigger: "user",
      toolCalls: [{ name: "attach_file", args: { path: real } }],
      files: { "bots/worker-1/jobs/p/out/a.jpg": PUPPY },
    });
    expect(readFile.mock.calls.map((call) => call[1])).toEqual(["bots/worker-1/jobs/p/out/a.jpg"]);
    expect(toolResults[0]).toEqual(expect.objectContaining({ ok: true, path: real }));
    expect(images).toHaveLength(1);
  });

  it("keeps relative, ~/ and workspace-rooted paths resolving as before", async () => {
    const paths = ["out/b.jpg", "~/shared/c.jpg", "/shared/d.jpg"];
    const resolved = paths.map((file) => resolveBotWorkspacePath("team", "bot-1", file));
    expect(resolved).toEqual(["bots/bot-1/out/b.jpg", "shared/c.jpg", "shared/d.jpg"]);
    const { readFile, toolResults } = await runMainTurn({
      trigger: "user",
      toolCalls: paths.map((path) => ({ name: "attach_file", args: { path } })),
      files: Object.fromEntries(resolved.map((file, index) => [file, new Uint8Array([index])])),
    });
    expect(readFile.mock.calls.map((call) => call[1])).toEqual(resolved);
    for (const result of toolResults) expect(result).toEqual(expect.objectContaining({ ok: true }));
  });
});
