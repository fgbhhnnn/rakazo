import type { MessageBlock } from "@rakazo/contracts";
import { BOT_MESSAGE_MAX_LENGTH, clampBotMessage } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { HIDDEN_BOT_SPAWN_PREFIX } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { backgroundTaskForWorkerRun } from "./background-task-rows.js";
import type { ExecutorDeps } from "./executor.js";
import { type AttachmentBlock, attachmentBlocks } from "./task-attachments.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";

type RelayDeps = Pick<ExecutorDeps, "prisma"> &
  Partial<Pick<ExecutorDeps, "artifacts" | "maxUploadSizeBytes">>;

/** The worker report's "文件：" section (see WORKER_INSTRUCTIONS), kept verbatim so it still attaches. */
export function reportFilesSection(text: string): string {
  const match = /^文件[:：][ \t]*$/m.exec(text);
  if (!match) return "";
  const section = text.slice(match.index).trim();
  return section.length <= 2_000 ? section : "";
}

export function resultFileName(ref: string | null | undefined, runId: string): string {
  const id = (ref?.trim() || runId.slice(-8)).replace(/[^A-Za-z0-9_-]/g, "");
  return `result-${id || "task"}.md`;
}

/** The short note the dispatcher gets instead of an over-long worker result. */
export function attachedResultNote(header: string, fileName: string, chars: number, files: string) {
  return [
    header,
    `结果较长（${chars} 字），完整结果已作为附件 ${fileName} 附上，系统会把它原样发给用户。`,
    "请只用一两句话告诉用户要点并说明完整内容见附件，不要复述或改写全文。",
    files,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * What a worker's outcome relays to its dispatcher. A hidden worker's result over the bot
 * message limit is never cut: the full text becomes a result-<REF>.md attachment on the relay and
 * the message is a short note. Other bots keep the clamped message.
 */
export async function workerOutcomeRelay(
  deps: RelayDeps,
  run: { id: string; spaceId: string; userId: string; botId: string },
  workerTitle: string | undefined,
  text: string,
  /** The dispatcher the file is attributed to, so it lives with the user's bot, not the hidden worker. */
  ownerBotId: string = run.botId,
): Promise<{ message: string; attachments?: AttachmentBlock[] }> {
  const header = workerTitle === undefined ? "" : `【后台任务：${workerTitle}】`;
  const full = header ? `${header}\n${text}` : text;
  if (workerTitle === undefined || full.trim().length <= BOT_MESSAGE_MAX_LENGTH) {
    return { message: clampBotMessage(full) };
  }
  const body = text.trim();
  const files = reportFilesSection(body);
  if (deps.artifacts) {
    try {
      const task = await backgroundTaskForWorkerRun(deps.prisma, run).catch(() => null);
      const fileName = resultFileName(task?.ref, run.id);
      const attached = await attachWorkspaceFileToThread(
        {
          prisma: deps.prisma,
          artifacts: deps.artifacts,
          maxUploadSizeBytes: deps.maxUploadSizeBytes,
        },
        {
          spaceId: run.spaceId,
          userId: run.userId,
          botId: ownerBotId,
          runId: run.id,
          filePath: fileName,
          bytes: new TextEncoder().encode(`${full.trim()}\n`),
          operationId: `${run.id}:worker-result`,
          description: workerTitle ? `后台任务完整结果：${workerTitle}` : undefined,
        },
      );
      return {
        message: clampBotMessage(attachedResultNote(header, fileName, body.length, files)),
        attachments: [attached.block],
      };
    } catch (error) {
      getLogger().warn(
        `worker result not attached, relaying it clamped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // No artifact store: keep the file list and say plainly that the text was cut.
  const note = `\n…（结果过长，已截断；共 ${body.length} 字）`;
  const tail = files ? `\n${files}` : "";
  const room = BOT_MESSAGE_MAX_LENGTH - header.length - note.length - tail.length - 2;
  return {
    message: clampBotMessage(`${header}\n${body.slice(0, Math.max(0, room))}${note}${tail}`),
  };
}

/**
 * The dispatcher forwards a worker relay's attachments (the result-<REF>.md file) to the user
 * itself, so a long result reaches them whole even though the dispatcher has no computer and
 * cannot attach_file. Only attachments a hidden worker of this bot sent are forwarded, once per run.
 */
export async function forwardWorkerRelayAttachments(input: {
  prisma: PrismaClient;
  run: { id: string; threadId: string; sourceMessageId?: string | null };
  bot: { id: string };
  report: { fromBotId: string };
  publish: (blocks: MessageBlock[]) => Promise<unknown>;
}): Promise<string[]> {
  const { prisma, run } = input;
  if (!run.sourceMessageId) return [];
  const worker = await prisma.bot.findFirst({
    where: {
      id: input.report.fromBotId,
      spawnKey: { startsWith: `${HIDDEN_BOT_SPAWN_PREFIX}${input.bot.id}:` },
    },
    select: { id: true },
  });
  if (!worker) return [];
  const source = await prisma.message.findUnique({
    where: { id: run.sourceMessageId },
    select: { blocks: true },
  });
  const blocks = attachmentBlocks(
    Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [],
  );
  if (!blocks.length) return [];
  const published = await prisma.message.findMany({
    where: { threadId: run.threadId, runId: run.id },
    select: { blocks: true },
  });
  const seen = new Set(
    attachmentBlocks(
      published.flatMap((m) => (Array.isArray(m.blocks) ? (m.blocks as MessageBlock[]) : [])),
    ).map((block) => block.artifactId),
  );
  const fresh = blocks.filter((block) => !seen.has(block.artifactId));
  if (!fresh.length) return [];
  await input.publish(fresh);
  return fresh.map((block) => block.artifactId);
}
