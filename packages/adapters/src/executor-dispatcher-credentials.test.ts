import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createRunExecutor } from "./executor.js";
import type * as RunToolsModule from "./run-tools.js";
import { applyTool } from "./run-tools.js";

vi.mock("./run-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RunToolsModule>();
  return { ...actual, applyTool: vi.fn(actual.applyTool) };
});

async function dispatcherTurn(page: boolean) {
  vi.mocked(applyTool).mockClear();
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };
  const emptyRows = () => ({ findMany: vi.fn(async () => []) });
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async ({ data }: { data: object }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        computerId: null,
        computer: null,
        spawnKey: null,
      })),
      ...emptyRows(),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ prompt: "Save a website login" })) },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        nextMessageSeq: 1,
      })),
      update: vi.fn(async () => ({ nextMessageSeq: 1, nextEventSeq: 1 })),
    },
    message: {
      ...emptyRows(),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: object }) => ({ id: "message-1", ...data })),
    },
    event: { create: vi.fn(async ({ data }: { data: object }) => ({ seq: 1, ...data })) },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    user: { findUnique: vi.fn(async () => null) },
    secret: { ...emptyRows(), findFirst: vi.fn(async () => null) },
    vaultCredential: emptyRows(),
    connection: emptyRows(),
    taughtSkill: emptyRows(),
    agentSkill: emptyRows(),
    scratchpadItem: emptyRows(),
    chatGroup: emptyRows(),
    externalEffect: emptyRows(),
    userModelRoleChoice: emptyRows(),
    spaceModelRoleChoice: emptyRows(),
    userModelCredential: { findFirst: vi.fn(async () => null) },
    userActionApprovalRule: emptyRows(),
    userActionAutoReviewPreference: {
      findUnique: vi.fn(async () => ({ enabled: false, skipApprovals: true })),
    },
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "local",
        defaultModelId: "fixture-model",
      })),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma),
    $queryRaw: vi.fn(async () => [{ locked: 1 }]),
  };
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    await request.executeTool?.("list_secrets", {}, "list-1");
    yield { type: "done" as const, text: "Ready." };
  });
  const provision = vi.fn();
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const executor = createRunExecutor({
    prisma,
    dispatcherMode: true,
    deploymentModelKey: "fixture-model-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ id: "e2b", capabilities: { graphical: true } }),
      ...(page ? { pageBrowser: vi.fn() } : {}),
      provision,
    },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(), finalizeRun, notify: vi.fn() },
    jobs: { enqueue: vi.fn() },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalledOnce();
  expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  expect(applyTool).toHaveBeenCalledOnce();
  expect(provision).not.toHaveBeenCalled();
  return { request: runtimeRun.mock.calls[0]![0], ctx: vi.mocked(applyTool).mock.calls[0]![0] };
}

describe("dispatcher credential page capability", () => {
  it.each([false, true])(
    "collects website logins only when workers have a page browser (page=%s)",
    async (page) => {
      const { request, ctx } = await dispatcherTurn(page);
      const requestSecret = request.tools.find((tool) => tool.name === "request_secret")!;
      expect(
        z.fromJSONSchema(requestSecret.inputSchema).safeParse({
          label: "Website login",
          purpose: "password",
          credential: {
            name: "site-login",
            origin: "https://example.test",
            auth: { type: "login" },
          },
        }).success,
      ).toBe(page);
      expect(request.tools.filter((tool) => tool.name.startsWith("browser_"))).toEqual([]);
      expect(ctx.tools.builtins.filter((tool) => tool.name.startsWith("browser_"))).toEqual([]);
      expect(ctx.computer.pageBrowserAllowed).toBe(false);
      expect(ctx.computer.graphical).toBe(false);
      expect(ctx.computer.graphicalToolsAllowed).toBe(false);
      expect(ctx.credentialPageBrowserAllowed).toBe(page);
      expect(request.instructions).not.toContain("Use browser_navigate");
      expect(request.instructions).not.toContain("browser_act fill_secret");
    },
  );
});
