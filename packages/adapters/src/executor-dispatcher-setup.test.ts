import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { TransientModelError } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { AppendEventInput, Prisma } from "@rakazo/db";
import { appendEventInTransaction } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import type * as DispatcherModeModule from "./dispatcher-mode.js";
import {
  createRunExecutor,
  DISPATCHER_PLUGIN_LISTING_MAX_MS,
  loadLivePluginSlugs,
} from "./executor.js";

// Dispatcher setup must never strand a reply: a slow connector provider or Composio listing
// used to run the 90 s reply budget out before the model opened, and the executor then
// returned quietly with the run still "running" until its 5 min lease expired.

const watchdog = vi.hoisted(() => ({ ms: 60_000 }));

vi.mock("./dispatcher-mode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof DispatcherModeModule>();
  return {
    ...actual,
    startDispatcherWatchdog: (controller: AbortController, onFire: () => void) =>
      actual.startDispatcherWatchdog(controller, onFire, watchdog.ms),
  };
});

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

afterEach(() => {
  watchdog.ms = 60_000;
});

const pendingComposio = {
  id: "connection-1",
  connectorId: "composio",
  provider: "gmail",
  providerRef: null,
  displayName: "Gmail",
  status: "pending",
};

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

async function runDispatcherTurn(options: {
  dispatcherMode?: boolean;
  connections?: unknown[];
  discoverTools?: () => Promise<unknown[]>;
  listConnectedPluginSlugs?: (userId: string) => Promise<string[]>;
  runtime?: (
    request: AgentRunRequest,
    context: { signal?: AbortSignal },
  ) => AsyncGenerator<AgentRuntimeEvent>;
  /** Thread messages, newest first, as loadRunHistoryMessages returns them. */
  threadMessages?: Record<string, unknown>[];
  /** Image artifacts the thread's messages point at; enables the artifact store. */
  imageArtifacts?: { id: string; name: string }[];
  retryOfRunId?: string;
  /** Error the retried run failed with. */
  retriedRunError?: string;
}) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    sourceMessageId: "source-1",
    retryOfRunId: options.retryOfRunId ?? null,
    leaseFence: 0,
  };
  const restartRuns: string[] = [];
  const runtimeRun = vi.fn(
    options.runtime ??
      async function* () {
        yield { type: "text" as const, text: "Hi there." };
        yield { type: "done" as const, text: "Hi there." };
      },
  );
  const messages: { blocks: MessageBlock[] }[] = [];
  const savedEvents: AppendEventInput[] = [];
  let failMessage = false;
  const prisma = {
    user: { findUnique: vi.fn(async () => null) },
    run: {
      findUnique: vi.fn(async (args?: { where?: { id?: string } }) =>
        options.retryOfRunId && args?.where?.id === options.retryOfRunId
          ? { id: options.retryOfRunId, error: options.retriedRunError ?? null }
          : run,
      ),
      create: vi.fn(async () => {
        restartRuns.push("retry-run-1");
        return { id: "retry-run-1" };
      }),
      findUniqueOrThrow: vi.fn(async () => run),
      // restartDispatcherTurn: the failed turn must be settled, and is retried only once.
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { id?: string; status?: { in: string[] }; retryOfRunId?: string };
        }) => {
          if (where.retryOfRunId !== undefined)
            return restartRuns.length > 0 ? { id: restartRuns[0] } : null;
          return where.id === run.id && where.status?.in.includes(String(run.status))
            ? { id: run.id }
            : null;
        },
      ),
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
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
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
      create: vi.fn(async ({ data }: { data: AppendEventInput }) => {
        if (
          data.type === "thread.subagent" &&
          (data.payload as { status?: string; agentId?: string }).status === "failed" &&
          (data.payload as { agentId?: string }).agentId === "never"
        )
          throw new Error("fixture settlement unavailable");
        savedEvents.push(data);
        return { ...data, seq: savedEvents.length };
      }),
    },
    message: {
      create: vi.fn(async ({ data }: { data: { blocks: MessageBlock[] } }) => {
        if (failMessage) {
          failMessage = false;
          throw new Error("fixture message unavailable");
        }
        messages.push(data);
        return { ...data, id: `message-${messages.length}` };
      }),
      findMany: vi.fn(async ({ where }: { where: { runId?: string; threadId?: string } }) =>
        where.runId === undefined && where.threadId === run.threadId
          ? (options.threadMessages ?? [])
          : [],
      ),
      findUnique: vi.fn(async () =>
        run.trigger === "messaging"
          ? { blocks: [{ kind: "channel_message", channelId: "channel-1" }] }
          : null,
      ),
      findFirst: vi.fn(async () => null),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Look again" })),
      findUnique: vi.fn(async () => ({ prompt: "Look again" })),
      create: vi.fn(async () => ({ id: "retry-task-1" })),
    },
    steeringMessage: { updateMany: vi.fn(async () => ({ count: 0 })) },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: {
      findMany: vi.fn(async () => options.connections ?? []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    spaceModelPreference: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
        async () => null,
      ),
    },
    secret: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceModelRoleChoice: { findMany: vi.fn(async () => []) },
    // Models are account-wide now: no Space override, and no account choices either.
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    userModelRoleChoice: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "fixture-model",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    vaultCredential: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    chatGroup: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    artifact: {
      findMany: vi.fn(async () =>
        (options.imageArtifacts ?? []).map((artifact) => ({
          id: artifact.id,
          name: artifact.name,
          storageKey: `key/${artifact.id}`,
          mimeType: "image/png",
          size: 4,
          spaceId: run.spaceId,
          userId: run.userId,
          sha256: "0".repeat(64),
          createdAt: new Date(0),
        })),
      ),
    },
    computerExecutionLease: {
      updateManyAndReturn: vi.fn(async () => [{ fence: 1 }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $queryRaw: vi.fn(async () => [{ id: "row-1", scope: "dedicated" }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const messageCount = messages.length;
      const eventCount = savedEvents.length;
      try {
        return await fn(prisma);
      } catch (error) {
        messages.length = messageCount;
        savedEvents.length = eventCount;
        throw error;
      }
    }),
  };
  const finalizeRun = vi.fn(
    async (input: { outcome: string; error?: string; blocks?: MessageBlock[] }) => {
      // Like the real finalizeRun, the run row is terminal once this returns.
      Object.assign(run, { status: input.outcome });
      return { continuationRunId: null };
    },
  );
  const append = vi.fn(async (event: AppendEventInput) =>
    appendEventInTransaction(prisma as unknown as Prisma.TransactionClient, event),
  );
  const discoverTools = vi.fn(options.discoverTools ?? (async () => []));
  const enqueue = vi.fn(async (_job: unknown) => undefined);
  const executor = createRunExecutor({
    deploymentModelKey: "fixture-model-key",
    prisma,
    runtime: {
      describe: () => ({ capabilities: { scripted: false } }),
      run: runtimeRun,
    },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      writeFile: vi.fn(async () => undefined),
      async *exportWorkspace() {
        yield* [];
      },
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    connector: { discoverTools, callTool: vi.fn() },
    ...(options.listConnectedPluginSlugs
      ? { listConnectedPluginSlugs: options.listConnectedPluginSlugs }
      : {}),
    events: {
      append,
      finalizeRun,
      pauseRunForInput: vi.fn(async () => ({ continuationRunId: null })),
      notify: vi.fn(async () => undefined),
    },
    jobs: { enqueue },
    ...(options.imageArtifacts
      ? { artifacts: { get: vi.fn(async () => new Uint8Array([137, 80, 78, 71])) } }
      : {}),
    secrets: [],
    ...(options.dispatcherMode === false ? {} : { dispatcherMode: true }),
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  const started = Date.now();
  await executor.continueRun(run.id, "worker-1");
  return {
    elapsedMs: Date.now() - started,
    run,
    runtimeRun,
    discoverTools,
    finalizeRun,
    messages,
    restartRuns,
    enqueue,
  };
}

function texts(messages: { blocks: MessageBlock[] }[]) {
  return messages.flatMap((message) =>
    message.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])),
  );
}

describe("dispatcher turn setup", () => {
  it("answers without waiting on connector tool discovery it never uses", async () => {
    const result = await runDispatcherTurn({ discoverTools: never });
    expect(result.discoverTools).not.toHaveBeenCalled();
    expect(result.runtimeRun).toHaveBeenCalledOnce();
    expect(result.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
  });

  it("offers the main turn only its talk and delegate tools, and no guidance for work tools", async () => {
    const result = await runDispatcherTurn({});
    const request = result.runtimeRun.mock.calls[0]![0] as AgentRunRequest;
    const offered = request.tools.map((tool) => tool.name);
    // Clauses follow the whole catalog, not only this trigger's offer.
    expect(request.instructions).not.toContain("run_subagent is a short helper");
    expect(request.instructions).not.toContain("use the render_plot tool");
    expect(request.instructions).not.toContain("call write_page");
    expect(offered).toContain("background_task");
    for (const work of ["shell", "web_search", "web_fetch", "write_file", "read_file"]) {
      expect(offered).not.toContain(work);
    }
  });

  it("still discovers connector tools for runs outside dispatcher mode", async () => {
    const result = await runDispatcherTurn({ dispatcherMode: false });
    expect(result.discoverTools).toHaveBeenCalledOnce();
    expect(result.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
  });

  it("falls back to stored connections when the live plugin listing hangs", async () => {
    const listConnectedPluginSlugs = vi.fn(never<string[]>);
    const result = await runDispatcherTurn({
      connections: [pendingComposio],
      listConnectedPluginSlugs,
    });
    expect(listConnectedPluginSlugs).toHaveBeenCalledWith("user-1");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(DISPATCHER_PLUGIN_LISTING_MAX_MS - 50);
    expect(result.elapsedMs).toBeLessThan(DISPATCHER_PLUGIN_LISTING_MAX_MS + 4_000);
    expect(result.runtimeRun).toHaveBeenCalledOnce();
    expect(result.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
  }, 15_000);

  it("restarts the turn instead of stranding it when the reply budget ends during setup", async () => {
    watchdog.ms = 50;
    const result = await runDispatcherTurn({
      connections: [pendingComposio],
      listConnectedPluginSlugs: () =>
        new Promise((resolve) => setTimeout(() => resolve(["gmail"]), 300)),
    });
    expect(result.runtimeRun).not.toHaveBeenCalled();
    expect(result.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error: expect.stringMatching(/took longer than \d+ s and was stopped/),
      }),
    );
    expect(result.restartRuns).toEqual(["retry-run-1"]);
    expect(result.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ runId: "retry-run-1" }) }),
    );
  });

  it("records a reply-budget abort mid-stream as a timeout, not a generic abort", async () => {
    watchdog.ms = 50;
    const result = await runDispatcherTurn({
      runtime: async function* (_request, context) {
        yield { type: "text" as const, text: "Working on it" };
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted) resolve();
          context.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        // pi-agent-core reports any signal abort this way.
        throw new Error("Request was aborted");
      },
    });
    const failed = result.finalizeRun.mock.calls.find(([input]) => input.outcome === "failed");
    expect(failed?.[0].error).toMatch(/took longer than \d+ s and was stopped/);
    expect(failed?.[0].error).not.toContain("Request was aborted");
    expect(result.restartRuns).toEqual(["retry-run-1"]);
    expect(texts(result.messages).join("\n")).not.toContain("Request was aborted");
  });
});

describe("dispatcher turn model outage", () => {
  it("fails fast and tells the user instead of waiting for the lease to expire", async () => {
    const result = await runDispatcherTurn({
      // pi has already spent its retries when it surfaces a TransientModelError.
      runtime: async function* () {
        yield* [];
        throw new TransientModelError(
          "Service temporarily unavailable. The model did not respond to this request.",
        );
      },
    });
    expect(result.elapsedMs).toBeLessThan(5_000);
    expect(result.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error: "Service temporarily unavailable. The model did not respond to this request.",
      }),
    );
    // An outage is not a hang: no restart loop against a provider that is down.
    expect(result.restartRuns).toEqual([]);
    expect(texts(result.messages)).toContain(
      "这次回复失败了：Service temporarily unavailable. The model did not respond to this request.",
    );
  });
});

describe("loadLivePluginSlugs", () => {
  it("returns the listing when it answers in time", async () => {
    await expect(loadLivePluginSlugs(async () => ["gmail"], "user-1", 1_000)).resolves.toEqual({
      ok: true,
      slugs: ["gmail"],
    });
  });

  it("reports a failed listing without throwing", async () => {
    await expect(
      loadLivePluginSlugs(
        async () => {
          throw new Error("Failed to fetch API key information from DB");
        },
        "user-1",
        1_000,
      ),
    ).resolves.toEqual({ ok: false });
  });

  it("gives up after the cap", async () => {
    await expect(loadLivePluginSlugs(never, "user-1", 20)).resolves.toEqual({ ok: false });
  });

  it("waits without a cap when none is given", async () => {
    await expect(
      loadLivePluginSlugs(
        () => new Promise((resolve) => setTimeout(() => resolve(["slack"]), 30)),
        "user-1",
      ),
    ).resolves.toEqual({ ok: true, slugs: ["slack"] });
  });
});

describe("dispatcher turn reply budget", () => {
  it("lets a slow reply that keeps streaming finish past the no-progress limit", async () => {
    watchdog.ms = 150;
    const result = await runDispatcherTurn({
      runtime: async function* () {
        for (let i = 0; i < 8; i++) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          yield { type: "progress" as const, text: "." } as AgentRuntimeEvent;
        }
        yield { type: "text" as const, text: "Done." };
        yield { type: "done" as const, text: "Done." };
      },
    });
    expect(result.elapsedMs).toBeGreaterThan(450);
    expect(result.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
    expect(result.restartRuns).toEqual([]);
  });

  it("counts activity the runtime reports through onStreamActivity (reasoning) as progress", async () => {
    watchdog.ms = 150;
    const result = await runDispatcherTurn({
      runtime: async function* (request) {
        for (let i = 0; i < 8; i++) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          request.onStreamActivity?.();
        }
        yield { type: "text" as const, text: "Thought it through." };
        yield { type: "done" as const, text: "Thought it through." };
      },
    });
    expect(result.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
    expect(result.restartRuns).toEqual([]);
  });
});

const imageBlock = (artifactId: string, name: string) => ({
  kind: "image",
  artifactId,
  name,
  mimeType: "image/png",
  size: 4,
});

function threadWithImages() {
  return [
    {
      id: "source-1",
      threadId: "thread-1",
      seq: 3,
      role: "user",
      botId: null,
      runId: "run-1",
      blocks: [
        { kind: "text", text: "What is wrong in these?" },
        imageBlock("art-new-1", "IMG_0001.PNG"),
        imageBlock("art-new-2", "IMG_0002.PNG"),
      ],
      createdAt: new Date(2_000),
    },
    {
      id: "bot-1",
      threadId: "thread-1",
      seq: 2,
      role: "bot",
      botId: "bot-1",
      runId: "run-0",
      blocks: [{ kind: "text", text: "Looks fine." }],
      createdAt: new Date(1_500),
    },
    {
      id: "user-0",
      threadId: "thread-1",
      seq: 1,
      role: "user",
      botId: null,
      runId: "run-0",
      blocks: [{ kind: "text", text: "Check this" }, imageBlock("art-old", "old.png")],
      createdAt: new Date(1_000),
    },
  ];
}

const imageArtifacts = [
  { id: "art-new-1", name: "IMG_0001.PNG" },
  { id: "art-new-2", name: "IMG_0002.PNG" },
  { id: "art-old", name: "old.png" },
];

describe("dispatcher turn images", () => {
  it("sends the main turn a note about the images instead of their bytes", async () => {
    const result = await runDispatcherTurn({ threadMessages: threadWithImages(), imageArtifacts });
    const request = result.runtimeRun.mock.calls[0]?.[0] as AgentRunRequest;
    expect(request.currentTurnImages).toBeUndefined();
    expect(request.history.some((entry) => entry.images?.length)).toBe(false);
    expect(request.prompt).toContain(
      'The user attached 2 images to this message: "IMG_0001.PNG", "IMG_0002.PNG".',
    );
    expect(request.prompt).toContain("background_task");
    expect(result.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
  });

  it("still gives bots outside dispatcher mode the images themselves", async () => {
    const result = await runDispatcherTurn({
      dispatcherMode: false,
      threadMessages: threadWithImages(),
      imageArtifacts,
    });
    const request = result.runtimeRun.mock.calls[0]?.[0] as AgentRunRequest;
    expect(request.currentTurnImages?.map((image) => image.name)).toEqual([
      "IMG_0001.PNG",
      "IMG_0002.PNG",
    ]);
    expect(request.prompt).not.toContain("You cannot see image contents");
  });
});

describe("dispatcher turn restarted after a timeout", () => {
  function longThread() {
    return Array.from({ length: 30 }, (_, i) => ({
      id: i === 0 ? "source-1" : `m-${i}`,
      threadId: "thread-1",
      seq: 30 - i,
      role: i % 2 ? "bot" : "user",
      botId: i % 2 ? "bot-1" : null,
      runId: i === 0 ? "run-1" : `run-${i}`,
      blocks: [{ kind: "text", text: `turn ${30 - i} ${"x".repeat(i === 1 ? 6_000 : 10)}` }],
      createdAt: new Date((30 - i) * 1_000),
    }));
  }

  it("retries with a lighter history instead of the same load", async () => {
    const result = await runDispatcherTurn({
      threadMessages: longThread(),
      retryOfRunId: "run-0",
      retriedRunError: "The reply took longer than 90 s and was stopped.",
    });
    const request = result.runtimeRun.mock.calls[0]?.[0] as AgentRunRequest;
    expect(request.history.length).toBeLessThanOrEqual(12);
    expect(Math.max(...request.history.map((entry) => entry.content.length))).toBeLessThanOrEqual(
      2_000,
    );
  });

  it("keeps the full history when the retried run failed for another reason", async () => {
    const result = await runDispatcherTurn({
      threadMessages: longThread(),
      retryOfRunId: "run-0",
      retriedRunError: "The model returned no reply.",
    });
    const request = result.runtimeRun.mock.calls[0]?.[0] as AgentRunRequest;
    expect(request.history.length).toBeGreaterThan(12);
    expect(Math.max(...request.history.map((entry) => entry.content.length))).toBeGreaterThan(
      2_000,
    );
  });
});
