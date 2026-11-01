import type { ConnectorTool } from "@rakazo/adapter-kit";
import { ASK_TEAMMATE_TOOL_NAME, redactSecrets } from "@rakazo/core";
import { askTeammate } from "./group-consult.js";
import type { ToolHandler } from "./run-tool-gate.js";

/** Offered to visible group members that are not themselves answering a question (executor). */
export const askTeammateTool: ConnectorTool = {
  name: ASK_TEAMMATE_TOOL_NAME,
  description:
    "Ask another member of this group a question and keep your own stage. Use it when you need information only that teammate has (a contract, a field name, a decision in their area) to finish your own work. The question shows in the group and wakes that member to answer; end your turn right after asking, and you are woken with the answer to continue. One question per turn. To give the work itself to someone, use handoff_to_bot instead.",
  inputSchema: {
    type: "object",
    properties: {
      bot_id: { type: "string", description: "Member bot id from your teammate list." },
      confirm_name: {
        type: "string",
        description: "Exact name of the member when bot_id is omitted.",
      },
      question: {
        type: "string",
        description:
          "The question, self-contained: what you need, why, and the form you need it in.",
      },
    },
    required: ["question"],
  },
};

export const askTools: Record<string, ToolHandler> = {
  async [ASK_TEAMMATE_TOOL_NAME](ctx, call) {
    const { deps, run, thread } = ctx;
    const { args } = call;
    if (!thread.groupId) return call.finish({ error: "ask_teammate only works in a group chat" });
    const result = await askTeammate(deps, run, thread.groupId, {
      bot_id: args.bot_id ? String(args.bot_id) : undefined,
      confirm_name: args.confirm_name ? String(args.confirm_name) : undefined,
      question: redactSecrets(String(args.question ?? ""), ctx.secrets),
    });
    if ("ok" in result) {
      // The turn waits for the answer: no more tools, and its reply is not a finished stage.
      ctx.state.handedOff = true;
      ctx.state.askedTeammate = true;
      ctx.state.handoffTargets.push(result.botId);
    }
    return call.finish(result);
  },
};
