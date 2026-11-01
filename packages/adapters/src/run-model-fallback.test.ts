import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectConfiguredModel } from "./model-roles.js";
import { createRunModelFallbackReporter } from "./run-model-fallback.js";

const configured = { modelProvider: "deepseek", modelId: "deepseek-flash", thinkingLevel: null };
const actual = { provider: "xai", id: "grok-4.7" };
const run = { id: "r", botId: "b", spaceId: "s", threadId: "t", trigger: "user" };
const sink = createTestSink();

function fixture(options: { hidden?: boolean; staleLease?: boolean; trigger?: string } = {}) {
  const notices = new Map<string, unknown>();
  const tx = {
    $queryRaw: vi.fn(async () => []),
    thread: { update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 2 })) },
    run: {
      findUnique: vi.fn(async () => ({
        status: "running",
        firstResponseAt: new Date(),
        leaseOwner: "worker",
        leaseFence: options.staleLease ? 2 : 1,
      })),
    },
    message: {
      findUnique: vi.fn(
        async ({ where }: { where: { threadId_clientNonce: { clientNonce: string } } }) =>
          notices.has(where.threadId_clientNonce.clientNonce) ? { id: "m" } : null,
      ),
      create: vi.fn(async ({ data }: { data: { clientNonce: string; blocks: unknown } }) => {
        notices.set(data.clientNonce, data);
        return { id: "m" };
      }),
    },
    event: { create: vi.fn(async () => ({ seq: 7 })) },
  };
  const deps = {
    runLease: { runId: run.id, owner: "worker", fence: 1 },
    prisma: { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)) },
    events: { notify: vi.fn(async () => undefined) },
  };
  const input = {
    configured,
    selected: actual,
    connectionAvailable: false,
    hidden: options.hidden ?? false,
    secrets: [],
  };
  const makeReporter = (
    overrides: Partial<Parameters<typeof createRunModelFallbackReporter>[2]> = {},
  ) =>
    createRunModelFallbackReporter(
      deps as never,
      { ...run, trigger: options.trigger ?? run.trigger },
      { ...input, ...overrides },
    );
  return { tx, deps, notices, makeReporter };
}

describe("model fallback visibility", () => {
  beforeEach(() => {
    sink.events.length = 0;
    installLogger(createLogger({ service: "test", sinks: [sink] }));
  });
  afterEach(() => installLogger(createLogger({ service: "test", level: "off", sinks: [] })));

  it("reports a disconnected bot override resolved to the deployment default in both languages", async () => {
    const f = fixture();
    const selected = selectConfiguredModel({
      override: configured,
      overrideCredential: null,
      main: null,
      defaults: { deployment: { provider: actual.provider, model: actual.id } },
    });
    expect(selected).toMatchObject(actual);
    await f.makeReporter()(selected.provider!, selected.id!);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "model.fallback.used",
        botId: run.botId,
        runId: run.id,
        configuredModel: { provider: configured.modelProvider, id: configured.modelId },
        actualModel: actual,
        reason: "connection_unavailable",
      }),
    );
    const stored = [...f.notices.values()][0];
    expect(stored).toMatchObject({ role: "system", botId: run.botId, runId: run.id });
    expect(JSON.stringify(stored)).toContain("本轮使用 xai/grok-4.7");
    expect(JSON.stringify(stored)).toContain("This turn uses xai/grok-4.7");
    expect(JSON.stringify(stored)).toContain("deepseek/deepseek-flash");
    expect(f.deps.events.notify).toHaveBeenCalledWith(run.threadId, 7);
    expect(JSON.stringify(f.tx.event.create.mock.calls)).toContain("thread.message.created");
  });

  it("deduplicates repeated notifications and a resumed attempt against the durable nonce", async () => {
    const f = fixture();
    const report = f.makeReporter();
    await report(actual.provider, actual.id);
    await report(actual.provider, actual.id);
    await f.makeReporter()(actual.provider, actual.id);
    expect(f.tx.message.create).toHaveBeenCalledOnce();
    expect(f.deps.events.notify).toHaveBeenCalledOnce();
    expect(f.tx.$queryRaw).toHaveBeenCalled();
  });

  it("distinguishes setup failures from a runtime backup and records the actual target", async () => {
    const f = fixture();
    const report = f.makeReporter({
      connectionAvailable: true,
      selected: { provider: configured.modelProvider, id: configured.modelId },
    });
    await report(actual.provider, actual.id);
    await report("anthropic", "fixture-model", "runtime");
    expect(
      sink.events
        .filter((event) => event.message === "model.fallback.used")
        .map((event) => event.reason),
    ).toEqual(["setup_unavailable", "runtime_failure"]);
    expect(f.notices.size).toBe(2);
  });

  it("stays quiet when the configured model runs or no model was configured", async () => {
    const f = fixture();
    await f.makeReporter()(configured.modelProvider, configured.modelId);
    await f.makeReporter({
      configured: { modelProvider: null, modelId: null },
    })(actual.provider, actual.id);
    expect(sink.events).toEqual([]);
    expect(f.deps.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([{ hidden: true }, { trigger: "tickets" }])(
    "logs private worker fallbacks without posting chatter (%#)",
    async (options) => {
      const f = fixture(options);
      await f.makeReporter()(actual.provider, actual.id);
      expect(sink.events).toContainEqual(
        expect.objectContaining({ message: "model.fallback.used" }),
      );
      expect(f.tx.message.create).not.toHaveBeenCalled();
    },
  );

  it("respects a superseded lease while keeping observability failures nonfatal", async () => {
    const f = fixture({ staleLease: true });
    await expect(f.makeReporter()(actual.provider, actual.id)).resolves.toBeUndefined();
    expect(f.tx.message.create).not.toHaveBeenCalled();
    expect(f.deps.events.notify).not.toHaveBeenCalled();
    expect(sink.events).toContainEqual(
      expect.objectContaining({ message: "model.fallback.notice_unavailable" }),
    );
  });
});
