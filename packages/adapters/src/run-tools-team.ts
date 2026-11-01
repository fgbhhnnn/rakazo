import type { ConnectorTool } from "@rakazo/adapter-kit";
import { COMPLETE_TEAM_RUN_TOOL_NAME } from "@rakazo/core";
import { completeTeamRun } from "./group-team-run.js";
import type { ToolHandler } from "./run-tool-gate.js";

/** Offered only to the leader of an active group team run (see executor). */
export const completeTeamRunTool: ConnectorTool = {
  name: COMPLETE_TEAM_RUN_TOOL_NAME,
  description:
    'Close the group team task you lead once every stage is done and checked against the acceptance criteria, or with outcome "stopped" when the user asked to stop or cancel it. Posts the closing message for the user in the group. Only this closes the task; saying it is done does not.',
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "What the team delivered, for the user, in a few sentences.",
      },
      deliverables: {
        type: "array",
        items: { type: "string" },
        description: "Links, file paths or Page ids of the results.",
      },
      open_issues: {
        type: "array",
        items: { type: "string" },
        description: "Anything left open or for the user to decide.",
      },
      outcome: {
        type: "string",
        enum: ["completed", "stopped"],
        description:
          "completed (default): the work is done. stopped: the user asked to stop or cancel; summarize what was and was not done.",
      },
    },
    required: ["summary"],
  },
};

export const teamTools: Record<string, ToolHandler> = {
  async [COMPLETE_TEAM_RUN_TOOL_NAME](ctx, call) {
    const { deps, run, thread, bot } = ctx;
    return call.finish(await completeTeamRun(deps, run, thread, bot, call.args));
  },
};
