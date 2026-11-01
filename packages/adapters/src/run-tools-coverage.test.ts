import { describe, expect, it } from "vitest";
import { agentConnectionTools, builtinAgentTools } from "./builtin-tools.js";
import { PAGE_TOOL_NAMES } from "./page-tools.js";
import { TOOL_HANDLERS } from "./run-tools.js";

// Tools answered inside the runtime or routed by prefix, not through TOOL_HANDLERS.
const RUNTIME_HANDLED = new Set(["ask_user"]);

describe("run tool dispatch coverage", () => {
  it("gives every built-in tool its own handler instead of the connector fallback", () => {
    const unhandled = [...builtinAgentTools, ...agentConnectionTools]
      .map((tool) => tool.name)
      .filter(
        (name) =>
          !TOOL_HANDLERS.has(name) &&
          !RUNTIME_HANDLED.has(name) &&
          !name.startsWith("cloud_agent_"),
      );
    expect(unhandled).toEqual([]);
  });

  it("dispatches Page tools to the Page handler", () => {
    for (const name of PAGE_TOOL_NAMES) expect(TOOL_HANDLERS.has(name)).toBe(true);
  });
});
