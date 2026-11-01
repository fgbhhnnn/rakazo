import { DEFAULT_MODEL_CONTEXT_WINDOW, DEFAULT_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";
import { REASONING_MODEL_MAX_TOKENS, resolveCompletionMaxTokens } from "./pi-runtime-limits.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";
import {
  catalogOutputCeiling,
  turnDefaultMaxTokens,
  UNKNOWN_MODEL_OUTPUT_DEFAULT,
  withTurnOutputDefault,
} from "./turn-output-budget.js";

// A catalog model whose own ceiling is below a quarter of its window.
const card = {
  provider: "anthropic",
  maxTokens: 64_000,
  reasoning: false,
  contextWindow: 1_000_000,
};
const config = { provider: "anthropic", id: "claude-x" };
const compatCard = {
  provider: OPENAI_COMPATIBLE_PROVIDER_ID,
  maxTokens: DEFAULT_MODEL_MAX_TOKENS,
  reasoning: true,
  contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
};

describe("turnDefaultMaxTokens", () => {
  it("asks for the model's own output ceiling when it fits the window", () => {
    expect(turnDefaultMaxTokens("background", config, card)).toBe(64_000);
    expect(turnDefaultMaxTokens("main", config, card)).toBe(64_000);
  });

  it("keeps three quarters of the context window for input", () => {
    expect(
      turnDefaultMaxTokens("main", config, { ...card, maxTokens: 500_000, contextWindow: 500_000 }),
    ).toBe(125_000);
    // The connection's own context window bounds it too.
    expect(turnDefaultMaxTokens("main", { ...config, contextWindow: 100_000 }, card)).toBe(25_000);
  });

  it("never changes a configured maxTokens, lower or higher", () => {
    for (const maxTokens of [2_000, 4_096, 300_000]) {
      for (const lane of ["main", "background"] as const) {
        expect(turnDefaultMaxTokens(lane, { ...config, maxTokens }, card)).toBeUndefined();
        expect(withTurnOutputDefault(lane, { ...config, maxTokens })).toEqual({
          ...config,
          maxTokens,
        });
      }
    }
  });

  it("leaves unlaned internal calls alone", () => {
    expect(turnDefaultMaxTokens(undefined, config, card)).toBeUndefined();
  });

  it("does not lower a model whose ceiling is at or below the current default", () => {
    expect(turnDefaultMaxTokens("main", config, { ...card, maxTokens: 4_096 })).toBeUndefined();
    expect(turnDefaultMaxTokens("main", config, { ...card, maxTokens: 8_192 })).toBe(8_192);
    expect(
      turnDefaultMaxTokens("main", config, { ...card, reasoning: true, maxTokens: 32_768 }),
    ).toBeUndefined();
    expect(
      turnDefaultMaxTokens("main", config, { ...card, reasoning: true, maxTokens: 128_000 }),
    ).toBe(128_000);
  });

  it("an OpenAI-compatible model uses the pi catalog's most conservative ceiling for its id", () => {
    const ceiling = catalogOutputCeiling("grok-4.7");
    // pi-ai 1.3.0: xai 500000, openrouter x-ai/grok-4.7 450000, github-copilot 128000.
    expect(ceiling).toBe(128_000);
    expect(catalogOutputCeiling("x-ai/grok-4.7")).toBe(128_000);
    const compat = { provider: OPENAI_COMPATIBLE_PROVIDER_ID, id: "grok-4.7" };
    // Fitted to the connection's window: a quarter of the default 262144.
    expect(turnDefaultMaxTokens("main", compat, compatCard)).toBe(
      Math.floor(DEFAULT_MODEL_CONTEXT_WINDOW / 4),
    );
    expect(turnDefaultMaxTokens("main", { ...compat, contextWindow: 500_000 }, compatCard)).toBe(
      125_000,
    );
    expect(turnDefaultMaxTokens("main", { ...compat, contextWindow: 1_000_000 }, compatCard)).toBe(
      128_000,
    );
  });

  it("never uses an OpenAI-compatible card's placeholder 4096 as the ceiling", () => {
    const compat = { provider: OPENAI_COMPATIBLE_PROVIDER_ID, id: "grok-4.7" };
    expect(turnDefaultMaxTokens("main", compat, { ...compatCard, reasoning: false })).toBe(
      Math.floor(DEFAULT_MODEL_CONTEXT_WINDOW / 4),
    );
    // A compatible connection is looked up by id even if its card names another provider,
    expect(
      turnDefaultMaxTokens("main", compat, {
        ...compatCard,
        provider: "anthropic",
        reasoning: false,
      }),
    ).toBe(Math.floor(DEFAULT_MODEL_CONTEXT_WINDOW / 4));
    // and a card that says compatible is treated the same, whatever the config says.
    expect(
      turnDefaultMaxTokens("main", { provider: "anthropic", id: "grok-4.7" }, compatCard),
    ).toBe(Math.floor(DEFAULT_MODEL_CONTEXT_WINDOW / 4));
  });

  it("falls back to a safe default for a model nothing knows, still fitted to the window", () => {
    expect(catalogOutputCeiling("house-model-unknown")).toBeUndefined();
    const compat = { provider: OPENAI_COMPATIBLE_PROVIDER_ID, id: "house-model-unknown" };
    expect(turnDefaultMaxTokens("main", compat, compatCard)).toBe(UNKNOWN_MODEL_OUTPUT_DEFAULT);
    // A compatible card's 4096 placeholder is what such a run sends today, reasoning or not.
    expect(turnDefaultMaxTokens("main", { ...compat, contextWindow: 64_000 }, compatCard)).toBe(
      16_000,
    );
    expect(
      turnDefaultMaxTokens("main", { ...compat, contextWindow: 16_000 }, compatCard),
    ).toBeUndefined();
    expect(
      turnDefaultMaxTokens(
        "main",
        { ...compat, contextWindow: 64_000 },
        { ...compatCard, reasoning: false },
      ),
    ).toBe(16_000);
  });

  it("leaves a model without a card alone", () => {
    expect(turnDefaultMaxTokens("background", config, undefined)).toBeUndefined();
  });

  it("a real catalog model resolves to its card ceiling, fitted to its window", () => {
    const resolved = resolveRuntimeModel({ provider: "xai", id: "grok-4.7" }).model;
    expect(resolved).toMatchObject({ contextWindow: 500_000, maxTokens: 500_000 });
    expect(withTurnOutputDefault("main", { provider: "xai", id: "grok-4.7" })).toEqual({
      provider: "xai",
      id: "grok-4.7",
      maxTokens: 125_000,
    });
  });

  it("the raised value flows through the completion cap like a configured one", () => {
    const raised = turnDefaultMaxTokens("background", config, card);
    expect(
      resolveCompletionMaxTokens(card.maxTokens, raised, undefined, false, card.contextWindow),
    ).toBe(64_000);
    // Unset, the general defaults are unchanged.
    expect(resolveCompletionMaxTokens(card.maxTokens, undefined, undefined, false)).toBe(
      DEFAULT_MODEL_MAX_TOKENS,
    );
    expect(resolveCompletionMaxTokens(card.maxTokens, undefined, undefined, true)).toBe(
      REASONING_MODEL_MAX_TOKENS,
    );
  });
});
