import type { AgentRunRequest, StreamActivityKind } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";

// The dispatcher watchdog learns from the runtime when a model call is pending (and may think
// silently) and when output flows again; see dispatcher-model-wait.ts.

const fake = vi.hoisted(() => {
  class Agent {
    state = { messages: [], errorMessage: undefined };
    listener?: (event: unknown) => Promise<void> | void;
    abort = vi.fn();
    subscribe(listener: (event: unknown) => Promise<void> | void) {
      this.listener = listener;
    }
    async prompt() {
      for (const event of [
        { type: "agent_start" },
        { type: "turn_start" },
        { type: "message_start", message: { role: "assistant", content: [] } },
        {
          type: "message_update",
          message: { role: "assistant", content: [] },
          assistantMessageEvent: { type: "thinking_delta", delta: "…" },
        },
        { type: "tool_execution_start", toolCallId: "t", toolName: "x", args: {} },
        { type: "turn_end" },
      ]) {
        await this.listener?.(event);
      }
    }
    async waitForIdle() {}
  }
  return { Agent };
});

vi.mock("@earendil-works/pi-agent-core", () => ({ Agent: fake.Agent }));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: () => ({ provider: "test", id: "fake-model" }),
    streamSimple: () => {
      throw new Error("No model requests are allowed");
    },
  }),
}));
vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

describe("Pi runtime stream activity", () => {
  it("reports a pending model call and the output that follows it", async () => {
    const kinds: (StreamActivityKind | undefined)[] = [];
    const request: AgentRunRequest = {
      botId: "bot",
      threadId: "thread",
      runId: "run",
      prompt: "task",
      instructions: "test",
      history: [],
      tools: builtinAgentTools,
      model: { provider: "test", id: "fake-model" },
      onStreamActivity: (kind) => kinds.push(kind),
    };
    try {
      for await (const _event of new PiAgentRuntime().run(request)) {
        // drain
      }
    } catch {
      // The fake agent produces no final message; only the activity matters here.
    }
    expect(kinds.slice(0, 6)).toEqual([
      undefined,
      "model_wait",
      "model_wait",
      "output",
      "output",
      undefined,
    ]);
  });
});
