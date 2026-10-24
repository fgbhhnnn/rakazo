import { describe, expect, it } from "vitest";
import {
  BACKGROUND_AGENT_PROFILES,
  workerDisabledTools,
  workerToolSurface,
} from "./background-tasks.js";
import { applyDispatcherToolPolicy } from "./dispatcher-mode.js";
import {
  WORKER_NESTED_AGENT_TOOLS,
  WORKER_NESTING_REFUSAL,
  withholdNestedAgentTools,
  workerNestingRefusal,
} from "./worker-nesting.js";
import { WORKER_USER_FACING_TOOLS } from "./worker-user-facing-tools.js";

const worker = { spawnKey: "bg-worker:main-bot:2", disabledBuiltinTools: [] };
const regular = { spawnKey: null, disabledBuiltinTools: [] };
const offered = [
  "shell",
  "read_file",
  "web_search",
  "computer_act",
  ...WORKER_NESTED_AGENT_TOOLS,
].map((name) => ({ name }));

describe("worker nesting policy", () => {
  it("covers every way a worker could start another agent", () => {
    expect([...WORKER_NESTED_AGENT_TOOLS].sort()).toEqual(
      [
        "background_task",
        "background_task_cancel",
        "background_task_message",
        "background_task_status",
        "create_child_routine",
        "handoff_to_bot",
        "message_agent",
        "message_bot",
        "run_subagent",
        "spawn_bot",
      ].sort(),
    );
  });

  it("withholds nested-agent tools from a hidden worker only", () => {
    const workerDisabled = new Set<string>();
    withholdNestedAgentTools(worker, workerDisabled);
    expect([...workerDisabled].sort()).toEqual([...WORKER_NESTED_AGENT_TOOLS].sort());

    const regularDisabled = new Set<string>();
    withholdNestedAgentTools(regular, regularDisabled);
    expect(regularDisabled.size).toBe(0);
  });

  it("refuses nested-agent calls from a worker with a clear message", () => {
    for (const name of WORKER_NESTED_AGENT_TOOLS) {
      expect(workerNestingRefusal(worker, name)).toBe(WORKER_NESTING_REFUSAL);
      expect(workerNestingRefusal(regular, name)).toBeUndefined();
    }
    expect(workerNestingRefusal(worker, "shell")).toBeUndefined();
    expect(WORKER_NESTING_REFUSAL).toContain("Do this work yourself");
  });

  it("applies through the run tool policy, whatever the worker's stored tool list says", () => {
    const disabled = new Set<string>();
    expect(applyDispatcherToolPolicy(true, worker, disabled, offered)).toBe(false);
    // Nested-agent tools plus the user-facing ones (worker-user-facing-tools.ts), nothing else.
    expect([...disabled].sort()).toEqual(
      [...new Set([...WORKER_NESTED_AGENT_TOOLS, ...WORKER_USER_FACING_TOOLS])].sort(),
    );
    for (const name of ["shell", "read_file", "web_search", "computer_act"])
      expect(disabled.has(name)).toBe(false);
  });

  it("leaves a regular bot and the dispatcher's own tools unchanged", () => {
    const regularDisabled = new Set<string>();
    expect(applyDispatcherToolPolicy(false, regular, regularDisabled, offered)).toBe(false);
    expect(regularDisabled.size).toBe(0);

    const dispatcherDisabled = new Set<string>();
    expect(applyDispatcherToolPolicy(true, regular, dispatcherDisabled, offered)).toBe(true);
    for (const name of [
      "background_task",
      "background_task_status",
      "background_task_message",
      "background_task_cancel",
    ])
      expect(dispatcherDisabled.has(name)).toBe(false);
  });

  it("never offers run_subagent in a worker's stored tool set or profiles", () => {
    const names = ["shell", "read_file", "run_subagent", "background_task", "spawn_bot"];
    expect(workerDisabledTools(names, undefined)).toContain("run_subagent");
    for (const profile of Object.values(BACKGROUND_AGENT_PROFILES)) {
      expect(workerToolSurface(names, profile.tools)).not.toContain("run_subagent");
      expect(profile.tools ?? []).not.toContain("run_subagent");
    }
  });
});
