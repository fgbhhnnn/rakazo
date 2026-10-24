import { ATTACHMENT_MAX_BYTES, type MessageBlock } from "@rakazo/contracts";
import { inferAttachmentMimeType } from "@rakazo/core";
import type { parseComputerMode } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { BACKGROUND_WORKER_SPAWN_PREFIX, parseWorkerReportFiles } from "./background-tasks.js";
import { resolveBotWorkspacePath } from "./computer-support.js";
import type { ExecutorDeps } from "./executor.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";

/* How a dispatcher's main turn reads its thread and relays a worker's report files. */

/**
 * Several main turns of one bot can be live at once (a user turn plus wake turns for worker
 * results that land together). Each used to read the whole thread and answer every pending
 * message, so the user got the same answer two or three times. A user-side message that belongs
 * to another queued or running turn of this bot is that turn's to answer, so it is left out here.
 */
export async function withoutMessagesOwnedByOtherLiveRuns<
  M extends { role: string; runId: string | null },
>(
  prisma: Pick<ExecutorDeps["prisma"], "run">,
  run: { botId: string; threadId: string },
  runId: string,
  messages: M[],
): Promise<M[]> {
  const owners = [
    ...new Set(
      messages
        .filter((message) => message.role === "user" && message.runId && message.runId !== runId)
        .map((message) => message.runId as string),
    ),
  ];
  if (!owners.length || typeof prisma.run?.findMany !== "function") return messages;
  const live = await prisma.run.findMany({
    where: {
      id: { in: owners },
      botId: run.botId,
      threadId: run.threadId,
      status: { in: ["queued", "running"] },
    },
    select: { id: true },
  });
  if (!live?.length) return messages;
  const liveIds = new Set(live.map((row) => row.id));
  return messages.filter(
    (message) => !(message.role === "user" && message.runId && liveIds.has(message.runId)),
  );
}

/**
 * Workers list real absolute paths (they confirm them with realpath), such as
 * /home/user/rakazo-home/bots/<id>/out.csv. Workspace tools treat "/" as the workspace root, so
 * the computer's real workspace prefix is removed; "~/" paths are workspace-relative.
 */
const OUTSIDE_WORKSPACE_ROOTS =
  /^\/(?:home|root|tmp|var|etc|opt|usr|mnt|media|srv|data|private|Users|Volumes)(?:\/|$)/;

/** Key for "this file was already attached in this turn", independent of a leading slash. */
export function attachedPathKey(resolvedPath: string): string {
  return `resolved:${resolvedPath.replace(/^\/+/, "")}`;
}

export function workerReportWorkspacePath(file: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(file)) return null; // Windows host path: not in the workspace
  if (file.startsWith("~/")) return file.slice(2);
  const match = /^\/(?:[^/]+\/)*?rakazo-home(?:\/(.*))?$/.exec(file);
  if (match) return `/${match[1] ?? ""}`;
  // A real path outside the workspace (the shell's own home, /tmp, ...). Computer file reads are
  // confined to the workspace, so prefixing it would name a file that does not exist; skip it.
  if (OUTSIDE_WORKSPACE_ROOTS.test(file)) return null;
  // Otherwise "/" is the workspace root (e.g. /bots/<id>/out.csv, /shared/a.png).
  return file;
}

/**
 * A worker's report lists its output files ("文件：" section). The main bot's wake turn attaches
 * them itself, from the worker's workspace, so the user gets the files with the relay instead of
 * a promise and a second hand-off. Paths the model already attached this run are skipped.
 */
export async function attachWorkerReportFiles(input: {
  deps: ExecutorDeps;
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    trigger: string;
  };
  bot: { id: string };
  threadGroupId?: string;
  report: { fromBotId: string; text: string };
  computerMode: ReturnType<typeof parseComputerMode>;
  readComputer: () => Promise<Parameters<ExecutorDeps["sandbox"]["readFile"]>[0]>;
  context: Parameters<ExecutorDeps["sandbox"]["readFile"]>[2];
  alreadyAttached: Set<string>;
  /** Posts the attached file block to the thread as the main bot. */
  publish: (blocks: MessageBlock[]) => Promise<unknown>;
}): Promise<string[]> {
  const { deps, run } = input;
  if (!deps.artifacts) return [];
  const files = parseWorkerReportFiles(input.report.text).filter(
    (file) => !input.alreadyAttached.has(file),
  );
  if (!files.length) return [];
  const worker = await deps.prisma.bot.findFirst({
    where: {
      id: input.report.fromBotId,
      spawnKey: { startsWith: `${BACKGROUND_WORKER_SPAWN_PREFIX}${input.bot.id}:` },
    },
    select: { id: true },
  });
  if (!worker) return [];
  const computer = await input.readComputer();
  const attached: string[] = [];
  for (const [index, file] of files.entries()) {
    const mimeType = inferAttachmentMimeType(file);
    if (!mimeType) continue;
    const relative = workerReportWorkspacePath(file);
    if (relative === null) {
      getLogger().warn("worker report file not attached: path is outside the computer workspace");
      continue;
    }
    const resolved = resolveBotWorkspacePath(input.computerMode, worker.id, relative);
    if (input.alreadyAttached.has(attachedPathKey(resolved))) continue;
    try {
      const bytes = await deps.sandbox.readFile(computer, resolved, input.context, {
        maxBytes: deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES,
      });
      const result = await attachWorkspaceFileToThread(
        {
          prisma: deps.prisma,
          artifacts: deps.artifacts,
          maxUploadSizeBytes: deps.maxUploadSizeBytes,
        },
        {
          spaceId: run.spaceId,
          userId: run.userId,
          botId: input.bot.id,
          groupId: input.threadGroupId,
          runId: run.id,
          filePath: file,
          bytes,
          operationId: `${run.id}:worker-file:${index}`,
        },
      );
      await input.publish([result.block]);
      input.alreadyAttached.add(file);
      input.alreadyAttached.add(attachedPathKey(resolved));
      attached.push(file);
    } catch (error) {
      getLogger().warn(
        `worker report file not attached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return attached;
}
