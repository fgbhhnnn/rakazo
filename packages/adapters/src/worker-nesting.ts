import { isHiddenBot } from "@rakazo/db";

/**
 * One level of delegation: the main bot dispatches, a hidden background worker does its own work.
 * A worker never starts nested agents of any kind: no background tasks, no in-turn helpers
 * (run_subagent), no new or handed-off bots. Nested workers bypass the per-bot worker cap and
 * queue, are invisible to the main bot (status, steering, cancel) and compete for the same
 * computer, so they are withheld from the worker's tools and refused if called anyway.
 */
export const WORKER_NESTED_AGENT_TOOLS = [
  "background_task",
  "background_task_status",
  "background_task_message",
  "background_task_cancel",
  "run_subagent",
  "spawn_bot",
  "handoff_to_bot",
  "ask_teammate",
  "message_bot",
  "message_agent",
  "create_child_routine",
] as const;

const NESTED = new Set<string>(WORKER_NESTED_AGENT_TOOLS);

export const WORKER_NESTING_REFUSAL =
  "Background workers cannot start sub-tasks, sub-agents, helpers or other bots. Do this work yourself with your own tools (split a big job into batches and work through them one after another), then report the result.";

/** Adds every nested-agent tool to a hidden worker's disabled set; other bots are untouched. */
export function withholdNestedAgentTools(
  bot: { spawnKey?: string | null },
  disabled: Set<string>,
): void {
  if (isHiddenBot(bot)) for (const name of WORKER_NESTED_AGENT_TOOLS) disabled.add(name);
}

/** The tool error a hidden worker gets when it calls a nested-agent tool anyway. */
export function workerNestingRefusal(
  bot: { spawnKey?: string | null },
  toolName: string,
): string | undefined {
  return isHiddenBot(bot) && NESTED.has(toolName) ? WORKER_NESTING_REFUSAL : undefined;
}
