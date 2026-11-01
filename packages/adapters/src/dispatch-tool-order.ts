/**
 * Dispatcher tools whose calls in one model turn must run in the order the model emitted them.
 * Pi runs a turn's tool calls concurrently by default; several background_task calls then enter
 * the queue in whatever order their async pre-steps finish (1, 2, 4, 5, 3, 6), and the queue's
 * FIFO follows that wrong order. Status, follow-up and cancel calls must likewise see the tasks
 * launched before them in the same turn.
 */
export const SEQUENTIAL_DISPATCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  "background_task",
  "background_task_status",
  "background_task_message",
  "background_task_cancel",
]);
