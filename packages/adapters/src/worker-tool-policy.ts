/** Which builtin tools a background worker gets. */

export const BACKGROUND_TASK_TOOL_NAMES = [
  "background_task",
  "background_task_status",
  "background_task_message",
  "background_task_cancel",
] as const;

/** Tools a worker never gets: no recursion, no fleet changes, no talking to the user directly. */
export const WORKER_ALWAYS_DISABLED = [
  ...BACKGROUND_TASK_TOOL_NAMES,
  "spawn_bot",
  "archive_bot",
  "update_bot",
  "handoff_to_bot",
  "call_user",
  "end_call",
  "create_space",
  "propose_instructions_update",
  "list_fleet",
  "create_group",
  "update_group",
  "organize_bot",
  "set_child_instructions",
  "set_child_bot_model",
  "create_child_routine",
  // A worker never talks to the user or other bots itself: its final reply is its only output,
  // and the dispatcher relays it. ask_user would also park the worker in waiting_input.
  "ask_user",
  "message_user",
  "message_bot",
  "message_agent",
];

/** Builtin tools a worker may not use, given an optional allowlist. Unknown names are ignored. */
export function workerDisabledTools(
  allBuiltinNames: readonly string[],
  allowlist: readonly string[] | undefined,
): string[] {
  const disabled = new Set<string>(WORKER_ALWAYS_DISABLED);
  if (allowlist && allowlist.length > 0) {
    const allowed = new Set(allowlist);
    for (const name of allBuiltinNames) if (!allowed.has(name)) disabled.add(name);
  }
  return [...disabled].filter((name) => allBuiltinNames.includes(name)).sort();
}

/** The builtin tools a worker actually gets for a profile (or explicit allowlist). */
export function workerToolSurface(
  allBuiltinNames: readonly string[],
  allowlist: readonly string[] | undefined,
): string[] {
  const disabled = new Set(workerDisabledTools(allBuiltinNames, allowlist));
  return allBuiltinNames.filter((name) => !disabled.has(name));
}
