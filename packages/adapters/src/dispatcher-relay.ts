import { createHash } from "node:crypto";
import path from "node:path";
import {
  ARTIFACT_NAME_MAX_LENGTH,
  ATTACHMENT_MAX_BYTES,
  type MessageBlock,
} from "@rakazo/contracts";
import { inferAttachmentMimeType } from "@rakazo/core";
import type { parseComputerMode } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { attachmentDisplayName } from "./attachment-display-name.js";
import { isThinkWorker } from "./background-task-lanes.js";
import { BACKGROUND_WORKER_SPAWN_PREFIX, parseWorkerReportFiles } from "./background-tasks.js";
import { resolveBotWorkspacePath } from "./computer-support.js";
import type { ExecutorDeps } from "./executor.js";
import {
  alreadyPostedFile,
  attachWorkspaceFileToThread,
  postedAttachmentHashes,
} from "./thread-artifacts.js";
import { forwardWorkerRelayAttachments } from "./worker-outcome-relay.js";

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

/** Key for "these exact bytes were already attached in this turn", whatever the path or name. */
export function attachedContentKey(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * The computer's real workspace prefix (…/rakazo-home) mapped onto the workspace root "/", or
 * null when the path does not name it. Workers list such realpath'd paths in their reports.
 */
export function realWorkspacePathToRoot(file: string): string | null {
  const match = /^\/(?:[^/]+\/)*?rakazo-home(?:\/(.*))?$/.exec(file);
  return match ? `/${match[1] ?? ""}` : null;
}

export function workerReportWorkspacePath(file: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(file)) return null; // Windows host path: not in the workspace
  if (file.startsWith("~/")) return file.slice(2);
  const rooted = realWorkspacePathToRoot(file);
  if (rooted !== null) return rooted;
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
    select: { id: true, spawnKey: true },
  });
  // A think worker has no computer: whatever its report lists, nothing is read from the computer.
  if (!worker || isThinkWorker(worker)) return [];
  // A run resumed after ask_user (or retried) already attached these files in an earlier
  // attempt; the in-memory set starts empty, so check what this run already stored.
  const storedNames = new Set(
    (
      await deps.prisma.artifact.findMany({
        where: { runId: run.id, botId: input.bot.id },
        select: { name: true },
      })
    ).map((artifact) => artifact.name),
  );
  // The same bytes under another path or name (a copy in shared/, a file the model attached
  // itself, an earlier wake turn for this task) are already in the chat: never post them again.
  const postedHashes = await hashesPostedSinceTask(deps.prisma, run, input.bot.id, worker.id);
  // A file posted for an earlier task, or attached by the bot itself before this task began.
  for (const key of await postedAttachmentHashes(deps.prisma, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: input.bot.id,
  })) {
    postedHashes.add(key);
  }
  const computer = await input.readComputer();
  const attached: string[] = [];
  for (const [index, file] of files.entries()) {
    const mimeType = inferAttachmentMimeType(file);
    if (!mimeType) continue;
    const fileName = path.basename(file) || file;
    if (storedNames.has(attachmentDisplayName(undefined, fileName, ARTIFACT_NAME_MAX_LENGTH))) {
      continue;
    }
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
      const contentKey = attachedContentKey(bytes);
      if (
        input.alreadyAttached.has(contentKey) ||
        alreadyPostedFile(postedHashes, contentKey, fileName)
      ) {
        continue;
      }
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
      input.alreadyAttached.add(contentKey);
      attached.push(file);
    } catch (error) {
      getLogger().warn(
        `worker report file not attached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return attached;
}

/**
 * Content keys of the files this main bot already posted in this thread since it started the
 * worker's latest background task (this run's own attachments included). Without a task row only
 * this run counts.
 */
async function hashesPostedSinceTask(
  prisma: ExecutorDeps["prisma"],
  run: { id: string; spaceId: string; threadId: string },
  botId: string,
  workerBotId: string,
): Promise<Set<string>> {
  try {
    const task = await prisma.backgroundTaskQueue.findFirst({
      where: { botId, workerBotId, threadId: run.threadId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const runIds = task
      ? (
          await prisma.run.findMany({
            where: { threadId: run.threadId, botId, createdAt: { gte: task.createdAt } },
            select: { id: true },
          })
        ).map((row) => row.id)
      : [];
    if (!runIds.includes(run.id)) runIds.push(run.id);
    const rows = await prisma.artifact.findMany({
      where: { spaceId: run.spaceId, botId, runId: { in: runIds } },
      select: { hash: true },
    });
    return new Set(rows.map((row) => `sha256:${row.hash}`));
  } catch (error) {
    getLogger().warn(
      `worker report dedup lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new Set();
  }
}

/** Tells a wake turn which report files the system already posted to the chat for it. */
export function workerFilesAttachedNote(files: readonly string[]): string | undefined {
  if (!files.length) return;
  const names = [...new Set(files.map((file) => path.basename(file) || file))];
  return [
    `已自动附上：${names.join("、")}`,
    "后台任务报告「文件：」里的这些文件，系统已经发到聊天里了（就在你这条回复上方）。不要再用 attach_file 发它们，不要让后台任务重新发送或复制，也不要说“预览还在补”“稍后发你”；直接告诉用户结果，说明文件已经发在上面。",
  ].join("\n");
}

/**
 * A worker's files and forwarded result go out with the dispatcher's relay of its report.
 * Safe to call before the model turn, before ask_user, and at end of turn: alreadyAttached
 * and posted hashes skip anything that already went out.
 */
export async function relayWorkerReportAttachments(input: {
  deps: ExecutorDeps;
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    trigger: string;
    sourceMessageId?: string | null;
  };
  bot: { id: string };
  threadGroupId?: string;
  peerMessage: { fromBotId: string; text: string } | null | undefined;
  dispatcherTurn: boolean;
  computerMode: ReturnType<typeof parseComputerMode>;
  readComputer: () => Promise<Parameters<ExecutorDeps["sandbox"]["readFile"]>[0]>;
  context: Parameters<ExecutorDeps["sandbox"]["readFile"]>[2];
  alreadyAttached: Set<string>;
  publish: (blocks: MessageBlock[]) => Promise<unknown>;
}): Promise<string[]> {
  if (!input.dispatcherTurn || !input.peerMessage) return [];
  let attachedReportFiles: string[] = [];
  if (input.deps.artifacts) {
    attachedReportFiles = await attachWorkerReportFiles({
      deps: input.deps,
      run: input.run,
      bot: input.bot,
      threadGroupId: input.threadGroupId,
      report: input.peerMessage,
      computerMode: input.computerMode,
      readComputer: input.readComputer,
      context: input.context,
      alreadyAttached: input.alreadyAttached,
      publish: input.publish,
    }).catch((error) => {
      getLogger().error("worker report attach", error);
      return [];
    });
  }
  await forwardWorkerRelayAttachments({
    prisma: input.deps.prisma,
    run: input.run,
    bot: input.bot,
    report: input.peerMessage,
    publish: input.publish,
  }).catch((error) => getLogger().error("worker result forward", error));
  return attachedReportFiles;
}
