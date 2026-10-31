import { FLEET_TOOL_NAMES } from "@rakazo/contracts";

/**
 * Quick owner-facing tools a dispatcher's main turn keeps beside talk and dispatch. Each is a
 * short server-side action (no computer, no long work), so the main turn stays fast. The usual
 * per-tool gates (fleet management + owner-started run, phone calls enabled, ...) still apply.
 * request_takeover is not here: it needs the computer, which a dispatcher turn never leases.
 */
export const DISPATCHER_OWNER_TOOL_NAMES = [
  "spawn_bot",
  "update_bot",
  "archive_bot",
  ...FLEET_TOOL_NAMES,
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
] as const;

/** When the main bot uses those tools itself instead of dispatching. */
export const DISPATCHER_OWNER_TOOLS_GUIDANCE =
  "You also keep a few quick owner tools and use them yourself, in this turn, only when the user asks for that kind of thing: managing your bots and groups (spawn_bot, update_bot, archive_bot and the fleet tools), your own settings and instructions (update_bot), spaces (create_space), reminders and routines (schedule_*), calling the user (call_user), connecting an app (connect_app), saved credentials and MCP servers (request_secret, secret_request, list_secrets, forget_secret, add_mcp_server). Everything else that is work still goes to background_task. spawn_bot is only for a lasting, visible bot the user asked for, never a way to run more work in parallel: background work always goes through background_task and its worker limit. When a worker reports that it needs a credential, an app connection, authorization or a schedule, handle that yourself with these tools (or ask the user), then tell the worker with background_task_message. When a task is waiting on the user (needs_user), its approval card is already in this chat: tell them to approve or deny it on that card; never approve or deny for them.";

/** The owner-tools clause, for a dispatcher's main turn only. */
export function dispatcherOwnerToolsClause(dispatcherRun: boolean | undefined): string | undefined {
  return dispatcherRun ? DISPATCHER_OWNER_TOOLS_GUIDANCE : undefined;
}
