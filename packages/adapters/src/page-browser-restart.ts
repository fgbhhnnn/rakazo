import type { ConnectorTool } from "@rakazo/adapter-kit";
import { browserResultForModel, redactBrowserResult } from "./browser-tools.js";
import type { RunContext } from "./run-context.js";
import { computerScreenToolResult } from "./run-lifecycle.js";
import type { ToolCall } from "./run-tool-gate.js";

export const browserRestartTool: ConnectorTool = {
  name: "browser_restart",
  description:
    "Restart the page browser on this computer using its existing profile, keeping saved cookies and logins. Use after two consecutive page-browser timeouts, then navigate to the site again. Old element refs are invalid.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

/** The caller checks takeover/teaching before allowing any screen mutation. */
export async function browserRestartFromTool(ctx: RunContext, call: ToolCall) {
  ctx.computer.checkpoint.markDirty();
  return computerScreenToolResult(async () => {
    const browser = ctx.providers.browser;
    const result = browser.restart
      ? await browser.restart(await ctx.computer.get("tool", call.name), ctx.context)
      : { ok: false, error: "Restart is unavailable for this page browser." };
    if (result.ok) ctx.state.screen.unchangedVisualStreak = { count: 0 };
    return browserResultForModel(redactBrowserResult(result, [...ctx.secrets]));
  }, call.finish);
}
