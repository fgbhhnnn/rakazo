import { afterEach, describe, expect, it, vi } from "vitest";
import { REFUSED_TOOL_STOP, refusedTool } from "./refused-tool-breaker.js";

const refusal = { error: "This tool is disabled for this bot." };

describe("refused tool breaker", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("tells a dispatcher turn to stop calling tools from the third refusal", () => {
    const state = { dispatcherTurn: true };
    expect(refusedTool(state, refusal)).toEqual(refusal);
    expect(refusedTool(state, refusal)).toEqual(refusal);
    expect(refusedTool(state, refusal)).toEqual({
      error: `This tool is disabled for this bot. ${REFUSED_TOOL_STOP}`,
      stop: true,
    });
    expect(refusedTool(state, { error: "x", reason: "one_handoff_per_turn" })).toMatchObject({
      reason: "one_handoff_per_turn",
      stop: true,
    });
  });

  it("leaves worker and ordinary turns alone", () => {
    const state: { dispatcherTurn: boolean; refusedToolCalls?: number } = {
      dispatcherTurn: false,
    };
    for (let i = 0; i < 5; i++) expect(refusedTool(state, refusal)).toBe(refusal);
    expect(state.refusedToolCalls).toBeUndefined();
  });

  it("reads a configurable limit", () => {
    vi.stubEnv("DISPATCHER_REFUSED_TOOL_LIMIT", "1");
    expect(refusedTool({ dispatcherTurn: true }, refusal)).toMatchObject({ stop: true });
    vi.stubEnv("DISPATCHER_REFUSED_TOOL_LIMIT", "nonsense");
    const state = { dispatcherTurn: true };
    refusedTool(state, refusal);
    expect(refusedTool(state, refusal)).toEqual(refusal);
  });
});
