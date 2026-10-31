import { PAGE_TOOL_NAMES, runPageTool } from "./page-tools.js";
import type { RunContext } from "./run-context.js";
import { publishMessage } from "./run-messages.js";
import type { ToolCall, ToolHandler, ToolHandlers } from "./run-tool-gate.js";

/** write_page / edit_page / read_page: Pages are attributed to the memory bot (a worker's owner). */
const pageTool: ToolHandler = async (ctx: RunContext, call: ToolCall) => {
  const { deps, run, thread } = ctx;
  if (!deps.artifacts) return call.finish({ error: "page storage unavailable" });
  const outcome = await runPageTool(
    { prisma: deps.prisma, artifacts: deps.artifacts },
    {
      spaceId: run.spaceId,
      userId: run.userId,
      botId: ctx.memoryBotId,
      groupId: thread.groupId,
      runId: run.id,
      operationId: call.executionId,
      secrets: ctx.secrets,
    },
    call.name,
    call.args,
  );
  if (outcome.block) await publishMessage(deps, run, "bot", [outcome.block]);
  return call.finish(outcome.result);
};

export const pageTools: ToolHandlers = Object.fromEntries(
  [...PAGE_TOOL_NAMES].map((name) => [name, pageTool]),
);
