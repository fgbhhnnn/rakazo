import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type * as Core from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  stream: vi.fn(),
  delay: vi.fn<(delayMs: number, signal?: AbortSignal) => Promise<void>>(),
}));

vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  abortableDelay: providerState.delay,
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
    streamSimple: (...args: unknown[]) => providerState.stream(...args),
  }),
}));

vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";
import { LENGTH_CUT_CONTINUATION_PROMPT } from "./turn-length-cut.js";

// Cards with their own output ceilings: a plain model, a small one, a reasoning model above
// its 32k default, and one whose ceiling is larger than a quarter of its window.
const plain = model("provider-a", "plain", { reasoning: false, maxTokens: 65_536 });
const windowed = model("provider-a", "windowed", {
  reasoning: false,
  maxTokens: 500_000,
  contextWindow: 200_000,
});
const small = model("provider-a", "small", { reasoning: false, maxTokens: 8_192 });
const reasoner = model("provider-a", "reasoner", { reasoning: true, maxTokens: 65_536 });
const backup = model("provider-b", "backup", { reasoning: false, maxTokens: 65_536 });

function model(
  provider: string,
  id: string,
  { reasoning, maxTokens, contextWindow = 1_000_000 }: Partial<Model<"openai-completions">>,
): Model<"openai-completions"> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://models.invalid/v1",
    reasoning: reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: maxTokens ?? 4_096,
  };
}

function message(
  target: Model<"openai-completions">,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: target.api,
    provider: target.provider,
    model: target.id,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

/**
 * Streams thinking deltas first, as a reasoning model does, then any reply text as it would
 * arrive live, then the terminal event.
 */
function stream(response: AssistantMessage, thinking?: string, text?: string) {
  const result = new AssistantMessageEventStream();
  const empty = { ...response, content: [], stopReason: "stop" as const };
  result.push({ type: "start", partial: empty });
  if (thinking) {
    const partial = { ...empty, content: [{ type: "thinking" as const, thinking }] };
    result.push({ type: "thinking_start", contentIndex: 0, partial: empty });
    result.push({ type: "thinking_delta", contentIndex: 0, delta: thinking, partial });
    result.push({ type: "thinking_end", contentIndex: 0, content: thinking, partial });
  }
  if (text) {
    const partial = { ...empty, content: [{ type: "text" as const, text }] };
    result.push({ type: "text_start", contentIndex: 0, partial: empty });
    result.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
  }
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    result.push({ type: "error", reason: response.stopReason, error: response });
  } else {
    const call = response.content.find((part) => part.type === "toolCall");
    if (call?.type === "toolCall") {
      result.push({ type: "toolcall_start", contentIndex: 0, partial: { ...empty } });
      result.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: response });
    }
    const reason =
      response.stopReason === "length" ? "length" : call ? ("toolUse" as const) : "stop";
    result.push({ type: "done", reason, message: response });
  }
  result.end(response);
  return result;
}

const reply = (target: Model<"openai-completions">, text = "Done.") =>
  stream(message(target, [{ type: "text", text }], "stop"), undefined, text);
const cutReply = (target: Model<"openai-completions">, text: string) =>
  stream(message(target, [{ type: "text", text }], "length"), undefined, text);

function request(
  target: Model<"openai-completions">,
  extra: Partial<AgentRunRequest["model"]> = {},
  lane?: AgentRunRequest["lane"],
  fallbackModels: AgentRunRequest["model"][] = [],
): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Write the report",
    instructions: "Answer.",
    history: [],
    tools: [],
    model: { provider: target.provider, id: target.id, apiKey: "fake-key", ...extra },
    ...(lane ? { lane } : {}),
    fallbackModels,
    executeTool: vi.fn(async () => ({ ok: true })),
  } as unknown as AgentRunRequest;
}

async function run(input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input, {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

const sentMaxTokens = () =>
  providerState.stream.mock.calls.map(
    ([, , options]) => (options as { maxTokens?: number }).maxTokens,
  );

beforeEach(() => {
  providerState.models.clear();
  for (const candidate of [plain, windowed, small, reasoner, backup]) {
    providerState.models.set(
      `${candidate.provider}/${candidate.id}`,
      candidate as unknown as Record<string, unknown>,
    );
  }
  providerState.stream.mockReset();
  providerState.delay.mockReset().mockResolvedValue(undefined);
});

const sentContexts = () =>
  providerState.stream.mock.calls.map(([, context]) => JSON.stringify(context));
const texts = (events: AgentRuntimeEvent[]) =>
  events.flatMap((event) => (event.type === "text" ? [event.text] : []));
const doneEvents = (events: AgentRuntimeEvent[]) => events.filter((event) => event.type === "done");

describe("bot-turn output budget", () => {
  it("a background run with no configured cap sends the model's own ceiling", async () => {
    providerState.stream.mockImplementation(() => reply(plain));
    await run(request(plain, {}, "background"));
    expect(sentMaxTokens()).toEqual([65_536]);
  });

  it("the main bot's own reply with no configured cap also sends the model's ceiling", async () => {
    providerState.stream.mockImplementation(() => reply(plain));
    await run(request(plain, {}, "main"));
    expect(sentMaxTokens()).toEqual([65_536]);
  });

  it("keeps three quarters of the context window for input", async () => {
    providerState.stream.mockImplementation(() => reply(windowed));
    await run(request(windowed, {}, "main"));
    expect(sentMaxTokens()).toEqual([50_000]);
  });

  it("an unlaned internal call keeps the 4096 default", async () => {
    providerState.stream.mockImplementation(() => reply(plain));
    await run(request(plain));
    expect(sentMaxTokens()).toEqual([4_096]);
  });

  it("a configured maxTokens wins on main and background runs, lower or higher", async () => {
    providerState.stream.mockImplementation(() => reply(plain));
    await run(request(plain, { maxTokens: 4_096 }, "background"));
    await run(request(plain, { maxTokens: 2_000 }, "background"));
    await run(request(plain, { maxTokens: 40_000 }, "background"));
    await run(request(plain, { maxTokens: 4_096 }, "main"));
    await run(request(plain, { maxTokens: 40_000 }, "main"));
    expect(sentMaxTokens()).toEqual([4_096, 2_000, 40_000, 4_096, 40_000]);
  });

  it("clamps to the model card's ceiling", async () => {
    providerState.stream.mockImplementation(() => reply(small));
    await run(request(small, {}, "background"));
    await run(request(small, {}, "main"));
    expect(sentMaxTokens()).toEqual([8_192, 8_192]);
  });

  it("raises a reasoning model past its 32k default to its own ceiling", async () => {
    providerState.stream.mockImplementation(() => reply(reasoner));
    await run(request(reasoner, {}, "background"));
    await run(request(reasoner, {}, "main"));
    await run(request(reasoner));
    expect(sentMaxTokens()).toEqual([65_536, 65_536, 32_768]);
  });

  it("applies to a background run's backup model too", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === plain.provider
        ? stream(message(plain, [], "error", "HTTP 503 unavailable"))
        : reply(target, "From the backup."),
    );
    await run(
      request(plain, {}, "background", [
        { provider: backup.provider, id: backup.id, apiKey: "backup-key" },
      ]),
    );
    expect(providerState.stream.mock.calls.at(-1)?.[0]).toMatchObject({ id: backup.id });
    expect(sentMaxTokens().at(-1)).toBe(65_536);
  });
});

describe("a reply cut at the output limit", () => {
  it.each(["main", "background"] as const)(
    "a %s turn continues in the same reply and ends normally",
    async (lane) => {
      providerState.stream
        .mockImplementationOnce(() => cutReply(plain, "第一部分写到这里，接着写第二"))
        .mockImplementation(() => reply(plain, "接着写第二部分，全文完。"));
      const events = await run(request(plain, {}, lane));
      expect(providerState.stream).toHaveBeenCalledTimes(2);
      expect(sentContexts()[1]).toContain(
        JSON.stringify(LENGTH_CUT_CONTINUATION_PROMPT).slice(1, -1),
      );
      // No turn break, and the restated words are not repeated.
      expect(events.some((event) => event.type === "turn")).toBe(false);
      expect(texts(events).join("")).toBe("第一部分写到这里，接着写第二部分，全文完。");
      expect(doneEvents(events)).toEqual([
        { type: "done", text: "第一部分写到这里，接着写第二部分，全文完。" },
      ]);
    },
  );

  it("a main reply still cut after two continues ends with a notice, flagged", async () => {
    providerState.stream
      .mockImplementationOnce(() => cutReply(plain, "第一段。"))
      .mockImplementationOnce(() => cutReply(plain, "第二段。"))
      .mockImplementation(() => cutReply(plain, "第三段写到一半"));
    const events = await run(request(plain, {}, "main"));
    expect(providerState.stream).toHaveBeenCalledTimes(3);
    const done = events.at(-1) as { type: "done"; text: string; truncated?: true };
    expect(done.truncated).toBe(true);
    expect(done.text.startsWith("第一段。第二段。第三段写到一半")).toBe(true);
    expect(done.text).toContain("输出长度上限");
    expect(texts(events).join("")).toBe(done.text);
  });

  it("an English main reply gets the notice in English", async () => {
    providerState.stream.mockImplementation(() => cutReply(plain, "The report so far"));
    const events = await run(request(plain, {}, "main"));
    const done = events.at(-1) as { type: "done"; text: string };
    expect(done.text).toMatch(/output length limit/);
    expect(done.text).not.toMatch(/输出长度上限/);
  });

  it("a background reply still cut is flagged for the dispatcher, without a notice", async () => {
    providerState.stream.mockImplementation(() => cutReply(plain, "当前测试服版本为 v1."));
    const events = await run(request(plain, {}, "background"));
    expect(providerState.stream).toHaveBeenCalledTimes(3);
    expect(events.at(-1)).toEqual({ type: "done", text: "当前测试服版本为 v1.", truncated: true });
  });

  it("an unlaned call does not continue or add a notice", async () => {
    providerState.stream.mockImplementation(() => cutReply(plain, "A long reply that"));
    const events = await run(request(plain));
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({ type: "done", text: "A long reply that", truncated: true });
  });

  it("is not reported for a normal stop", async () => {
    providerState.stream.mockImplementation(() => reply(plain, "全文完。"));
    const events = await run(request(plain, {}, "main"));
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({ type: "done", text: "全文完。" });
  });
});
