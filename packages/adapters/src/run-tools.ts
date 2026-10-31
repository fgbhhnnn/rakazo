import type { AgentToolExecutionObserver } from "@rakazo/adapter-kit";
import { toolResultTaintsRun } from "@rakazo/core";
import { thinkWorkerToolRefusal } from "./background-task-lanes.js";
import { loginFailure } from "./login-failure.js";
import { IMAGE_RETURNING_COMPUTER_TOOLS, MODEL_CANNOT_SEE_MESSAGE } from "./model-vision.js";
import { refusedTool } from "./refused-tool-breaker.js";
import type { RunContext } from "./run-context.js";
import type { ToolHandler } from "./run-tool-gate.js";
import { auditToolCall, gateToolCall } from "./run-tool-gate.js";
import { prepareToolRequest, resolveToolRequest } from "./run-tool-request.js";
import { PAGE_BROWSER_TOOL_NAMES } from "./run-tool-selection.js";
import { askTools } from "./run-tools-ask.js";
import { computerTools, pageBrowserTool } from "./run-tools-computer.js";
import { fileTools } from "./run-tools-files.js";
import { fleetTools } from "./run-tools-fleet.js";
import { cloudAgentTool, connectorTool, integrationTools } from "./run-tools-integrations.js";
import { memoryTools } from "./run-tools-memory.js";
import { messagingTools } from "./run-tools-messaging.js";
import { pageTools } from "./run-tools-pages.js";
import { preferenceTools } from "./run-tools-preferences.js";
import { purchaseTools } from "./run-tools-purchases.js";
import { secretTools } from "./run-tools-secrets.js";
import { taskTools } from "./run-tools-tasks.js";
import { teamTools } from "./run-tools-team.js";
import {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_SHELL_TOOL,
  userComputerAct,
  userComputerObserve,
  userComputerShell,
} from "./run-tools-user-computer.js";
import { argumentGiven } from "./update-bot-patch.js";
import { workerNestingRefusal } from "./worker-nesting.js";
import { workerUserFacingRefusal } from "./worker-user-facing-tools.js";

/** Every tool name with its own handler; any other name runs as a connector or cloud-agent tool. */
export const TOOL_HANDLERS: ReadonlyMap<string, ToolHandler> = new Map<string, ToolHandler>([
  ...Object.entries(computerTools),
  ...Object.entries(fileTools),
  ...Object.entries(memoryTools),
  ...Object.entries(integrationTools),
  ...Object.entries(taskTools),
  ...Object.entries(messagingTools),
  ...Object.entries(secretTools),
  ...Object.entries(fleetTools),
  ...Object.entries(pageTools),
  ...Object.entries(teamTools),
  ...Object.entries(askTools),
  [USER_COMPUTER_SHELL_TOOL, userComputerShell],
  [USER_COMPUTER_OBSERVE_TOOL, userComputerObserve],
  [USER_COMPUTER_ACT_TOOL, userComputerAct],
  ...Object.entries(purchaseTools),
  ...Object.entries(preferenceTools),
  ...[...PAGE_BROWSER_TOOL_NAMES].map((name) => [name, pageBrowserTool] as const),
]);

function toolHandler(name: string): ToolHandler {
  return (
    TOOL_HANDLERS.get(name) ?? (name.startsWith("cloud_agent_") ? cloudAgentTool : connectorTool)
  );
}

/** Run one tool call of this run's model: gate it, then hand it to its tool family. */
export async function applyTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  _route?: unknown,
  observer?: AgentToolExecutionObserver,
) {
  try {
    return await dispatchTool(ctx, name, args, executionId, observer);
  } finally {
    // Editing its own profile returns only what this run wrote; a child's profile is another bot's.
    const ownProfile = name === "update_bot" && !argumentGiven(args.bot_id);
    if (toolResultTaintsRun(name) && !ownProfile) ctx.state.tainted = true;
  }
}

async function dispatchTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  observer: AgentToolExecutionObserver | undefined,
) {
  ctx.context.signal.throwIfAborted();
  if (ctx.state.handedOff) {
    return refusedTool(ctx.state, {
      error: ctx.state.askedTeammate
        ? "You asked a teammate a question. End this turn without more tool calls; you will be woken with the answer."
        : "This stage was handed off. End the turn without more tool calls.",
      ...(name === "handoff_to_bot" ? { reason: "one_handoff_per_turn" } : {}),
    });
  }
  const nestingRefusal = workerNestingRefusal(ctx.bot, name);
  if (nestingRefusal) return refusedTool(ctx.state, { error: nestingRefusal });
  const userFacingRefusal = workerUserFacingRefusal(ctx.bot, name);
  if (userFacingRefusal) return refusedTool(ctx.state, { error: userFacingRefusal });
  const thinkRefusal = thinkWorkerToolRefusal(ctx.bot, name);
  if (thinkRefusal) return refusedTool(ctx.state, { error: thinkRefusal });
  if (ctx.tools.disabled.has(name)) {
    return refusedTool(ctx.state, { error: "This tool is disabled for this bot." });
  }
  if (PAGE_BROWSER_TOOL_NAMES.has(name) && !ctx.computer.pageBrowserAllowed) {
    return loginFailure("Page browser is unavailable on this computer.", "no_page_browser");
  }
  if (IMAGE_RETURNING_COMPUTER_TOOLS.has(name) && !ctx.computer.acceptsImages) {
    return { error: MODEL_CANNOT_SEE_MESSAGE };
  }
  const request = await resolveToolRequest(ctx, name, args, executionId);
  if ("error" in request) return request;
  const refused = await prepareToolRequest(ctx, request);
  if (refused) return refused;
  const gate = await gateToolCall(ctx, request, observer);
  if ("result" in gate) return gate.result;
  if (!gate.call.applied) return toolHandler(gate.call.name)(ctx, gate.call);
  let outcome: "success" | "failure" = "failure";
  try {
    const result = await toolHandler(gate.call.name)(ctx, gate.call);
    if (!isToolError(result)) outcome = "success";
    return result;
  } finally {
    await auditToolCall(ctx, gate.call.name, outcome, {
      effectId: gate.call.applied.effect.id,
      autoApproved: gate.call.bypassApproval,
    });
  }
}

function isToolError(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}
