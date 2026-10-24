import { isHiddenBot } from "@rakazo/db";

/**
 * A hidden background worker's thread is not where the user is, so a card it posts (secret
 * request, app connection, takeover, MCP approval) or a reminder it schedules there is never
 * seen: the worker would just stall. These tools are withheld from workers and refused if
 * called anyway; the worker reports what it needs and the main bot handles it with the user.
 * forget_secret is also withheld: a worker uses the main bot's credentials, never revokes them.
 * secret_request stays: it posts no card, it only makes an authenticated call with a saved credential.
 */
export const WORKER_USER_FACING_TOOLS = [
  "request_secret",
  "forget_secret",
  "connect_app",
  "connect_agent",
  "respond_agent_connection",
  "request_takeover",
  "add_mcp_server",
  "schedule_create",
  "schedule_list",
  "schedule_cancel",
] as const;

const USER_FACING = new Set<string>(WORKER_USER_FACING_TOOLS);

export const WORKER_USER_FACING_REFUSAL =
  "Background workers cannot ask the user for anything (secrets, logins, app connections, takeovers, MCP servers) or schedule reminders. Stop here and report exactly what you need and why; the main bot handles it with the user and then tells you to continue.";

/** Adds the user-facing tools to a hidden worker's disabled set; other bots are untouched. */
export function withholdUserFacingTools(
  bot: { spawnKey?: string | null },
  disabled: Set<string>,
): void {
  if (isHiddenBot(bot)) for (const name of WORKER_USER_FACING_TOOLS) disabled.add(name);
}

/** The tool error a hidden worker gets when it calls a user-facing tool anyway. */
export function workerUserFacingRefusal(
  bot: { spawnKey?: string | null },
  toolName: string,
): string | undefined {
  return isHiddenBot(bot) && USER_FACING.has(toolName) ? WORKER_USER_FACING_REFUSAL : undefined;
}
