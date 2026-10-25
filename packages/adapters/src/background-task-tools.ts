import { BUILTIN_TOOL_NAMES, type MessageBlock } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { backgroundTaskCard } from "./background-task-cards.js";
import { refreshTaskProgressCard } from "./background-task-progress.js";
import {
  backgroundTaskMessage,
  backgroundTaskStatus,
  cancelBackgroundTask,
  launchBackgroundTask,
} from "./background-tasks.js";
import type { ExecutorDeps } from "./executor.js";
import type { AttachmentBlock } from "./task-attachments.js";

type DispatchRun = Parameters<typeof launchBackgroundTask>[1];
type DispatchBot = Parameters<typeof launchBackgroundTask>[2];

/**
 * The dispatcher's background_task* tools. Returns the tool result, or undefined when the name
 * is not one of them. A launched worker is announced in the chat with a link to its live progress.
 */
export async function runBackgroundTaskTool(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "sandbox">,
  name: string,
  args: Record<string, unknown>,
  input: {
    run: DispatchRun;
    dispatcher: DispatchBot;
    effectKey: string;
    /** The uploads this task carries, given the task's own text (see dispatcherTaskAttachments). */
    attachments: (taskText: string) => readonly AttachmentBlock[];
    publish: (blocks: MessageBlock[]) => Promise<unknown>;
  },
): Promise<unknown> {
  const { dispatcher } = input;
  const result = await runTool(deps, name, args, input);
  // The chat's progress card picks up the started, steered or cancelled task right away.
  if (result !== undefined && name !== "background_task_status")
    await refreshTaskProgressCard(deps, dispatcher.id);
  return result;
}

async function runTool(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "sandbox">,
  name: string,
  args: Record<string, unknown>,
  input: Parameters<typeof runBackgroundTaskTool>[3],
): Promise<unknown> {
  const { run, dispatcher, effectKey } = input;
  if (name === "background_task") {
    const launched = await launchBackgroundTask(deps, run, dispatcher, args, {
      builtinToolNames: BUILTIN_TOOL_NAMES,
      deliveryKey: effectKey,
      attachments: input.attachments(
        [args.name, args.task, args.instructions].filter((v) => typeof v === "string").join("\n"),
      ),
    });
    if ("task_ref" in launched && "worker_id" in launched && launched.worker_id) {
      try {
        await input.publish([
          backgroundTaskCard(launched.worker_id, launched.name, launched.task_ref),
        ]);
      } catch (error) {
        getLogger().error("background task notice", error);
      }
    }
    return launched;
  }
  if (name === "background_task_status") return backgroundTaskStatus(deps, run, dispatcher, args);
  if (name === "background_task_message")
    return backgroundTaskMessage(deps, run, dispatcher, args, effectKey);
  if (name === "background_task_cancel") return cancelBackgroundTask(deps, run, dispatcher, args);
  return undefined;
}
