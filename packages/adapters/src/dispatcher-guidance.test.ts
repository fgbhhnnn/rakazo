import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { DISPATCHER_ASK_GUIDANCE, dispatcherAskClause } from "./dispatcher-ask-guidance.js";
import { applyDispatcherToolPolicy, DISPATCHER_TOOL_NAMES } from "./dispatcher-mode.js";
import {
  DISPATCHER_OWNER_TOOL_NAMES,
  DISPATCHER_OWNER_TOOLS_GUIDANCE,
  dispatcherOwnerToolsClause,
} from "./dispatcher-owner-tools.js";
import { userTurnInstructions } from "./executor.js";

const parts = {
  botInstructions: "Bot instructions",
  groupContext: undefined,
  messagingContext: undefined,
  redactedMemoryContext: undefined,
  redactedScratchpadContext: undefined,
  hasHistoricalContext: false,
  computerInstruction: "computer",
  pageBrowserAllowed: false,
  workspaceInstruction: "workspace",
  agentEnvironmentInstruction: undefined,
  botDirectory: undefined,
  pluginLine: undefined,
  agentSkillsLine: undefined,
  taughtSkillsLine: undefined,
  replyGuidance: "reply",
};

describe("dispatcher ask_user guidance", () => {
  it("is given only when ask_user is offered and the bot can dispatch", () => {
    expect(dispatcherAskClause(new Set(), true)).toBe(DISPATCHER_ASK_GUIDANCE);
    expect(dispatcherAskClause(undefined, true)).toBe(DISPATCHER_ASK_GUIDANCE);
    expect(dispatcherAskClause(new Set(), false)).toBeUndefined();
    expect(dispatcherAskClause(new Set(), undefined)).toBeUndefined();
    // A worker (background_task withheld) or a bot with ask_user turned off gets none.
    expect(dispatcherAskClause(new Set(["background_task"]), true)).toBeUndefined();
    expect(dispatcherAskClause(new Set(["ask_user"]), true)).toBeUndefined();
  });

  it("tells the bot to ask real decisions with ask_user and accept typed replies", () => {
    expect(DISPATCHER_ASK_GUIDANCE).toContain("call ask_user");
    expect(DISPATCHER_ASK_GUIDANCE).toContain("If they type a reply instead of tapping");
    expect(DISPATCHER_ASK_GUIDANCE).toContain("Calling ask_user ends your turn");
    expect(DISPATCHER_ASK_GUIDANCE).toContain("Background workers cannot ask the user");
  });

  it("is part of the turn instructions exactly when offered", () => {
    const offered = userTurnInstructions({
      ...parts,
      disabledBuiltinTools: new Set(),
      askUserOffered: true,
    });
    expect(offered).toContain(DISPATCHER_ASK_GUIDANCE);
    const notOffered = userTurnInstructions({
      ...parts,
      disabledBuiltinTools: new Set(),
      askUserOffered: false,
    });
    expect(notOffered).not.toContain(DISPATCHER_ASK_GUIDANCE);
    const worker = userTurnInstructions({
      ...parts,
      disabledBuiltinTools: new Set(["background_task", "ask_user"]),
      askUserOffered: false,
    });
    expect(worker).not.toContain(DISPATCHER_ASK_GUIDANCE);
  });
});

describe("dispatcher group teamwork", () => {
  it("keeps handoff_to_bot on a dispatcher's main turn so it can hand off in a group", () => {
    const disabled = new Set<string>();
    const dispatcher = applyDispatcherToolPolicy(true, { spawnKey: null }, disabled, [
      { name: "handoff_to_bot" },
      { name: "message_bot" },
      { name: "run_command" },
    ]);
    expect(dispatcher).toBe(true);
    expect(disabled.has("handoff_to_bot")).toBe(false);
    expect(disabled.has("run_command")).toBe(true);
    expect(DISPATCHER_TOOL_NAMES.has("handoff_to_bot")).toBe(true);
  });
});

describe("dispatcher owner tools", () => {
  it("keeps the quick owner tools on the main turn, never request_takeover", () => {
    const available = new Set(builtinAgentTools.map((tool) => tool.name));
    for (const name of DISPATCHER_OWNER_TOOL_NAMES) {
      expect(available.has(name), name).toBe(true);
      expect(DISPATCHER_TOOL_NAMES.has(name)).toBe(true);
    }
    for (const name of [
      "spawn_bot",
      "update_bot",
      "archive_bot",
      "list_fleet",
      "create_group",
      "update_group",
      "organize_bot",
      "set_child_instructions",
      "set_child_bot_model",
      "create_child_routine",
      "create_space",
      "schedule_create",
      "schedule_list",
      "schedule_cancel",
      "call_user",
      "connect_app",
      "request_secret",
      "secret_request",
      "list_secrets",
      "forget_secret",
      "add_mcp_server",
    ]) {
      expect(DISPATCHER_TOOL_NAMES.has(name)).toBe(true);
    }
    // These need the computer, which a dispatcher turn never leases.
    for (const name of ["request_takeover", "run_command", "computer", "browser", "list_files"]) {
      expect(DISPATCHER_TOOL_NAMES.has(name)).toBe(false);
    }
  });

  it("survives the dispatcher tool policy for the main bot while work tools are withheld", () => {
    const offered = [...DISPATCHER_OWNER_TOOL_NAMES, "run_command", "request_takeover"].map(
      (name) => ({ name }),
    );
    const disabled = new Set<string>();
    const dispatcherRun = applyDispatcherToolPolicy(
      true,
      { spawnKey: null, disabledBuiltinTools: [] },
      disabled,
      offered,
    );
    expect(dispatcherRun).toBe(true);
    for (const name of DISPATCHER_OWNER_TOOL_NAMES) expect(disabled.has(name)).toBe(false);
    expect(disabled.has("run_command")).toBe(true);
    expect(disabled.has("request_takeover")).toBe(true);
  });

  it("adds the owner-tools guidance only to a dispatcher's main turn", () => {
    expect(dispatcherOwnerToolsClause(true)).toBe(DISPATCHER_OWNER_TOOLS_GUIDANCE);
    expect(dispatcherOwnerToolsClause(false)).toBeUndefined();
    expect(dispatcherOwnerToolsClause(undefined)).toBeUndefined();
    expect(userTurnInstructions({ ...parts, dispatcherRun: true })).toContain(
      DISPATCHER_OWNER_TOOLS_GUIDANCE,
    );
    expect(userTurnInstructions({ ...parts, dispatcherRun: false })).not.toContain(
      DISPATCHER_OWNER_TOOLS_GUIDANCE,
    );
    // spawn_bot is never a way around the worker limit, and approvals stay the user's.
    expect(DISPATCHER_OWNER_TOOLS_GUIDANCE).toContain("never a way to run more work in parallel");
    expect(DISPATCHER_OWNER_TOOLS_GUIDANCE).toContain("never approve or deny for them");
  });
});
