import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { bareCompletionClaim, STAGE_OUTPUT_MISSING_PROMPT } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";

/**
 * Before a team-run member's finished stage returns to the leader (group-team-run.ts): a stage
 * whose turn only claimed to be done, with no content, code, file or link anywhere in what the
 * turn posted, gets one more turn asking for its output (core group-stage-output.ts). Once per
 * stage, keyed by the stage's source; a second bare reply returns to the leader as it is.
 */

/** Blocks that carry a result by themselves. */
const OUTPUT_BLOCKS = new Set(["file", "image", "chart", "card", "cloud_agent", "child_bot"]);

type MemberRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  sourceMessageId?: string | null;
};

export function stageOutputNonce(run: { id: string; sourceMessageId?: string | null }): string {
  return `stage-output:${run.sourceMessageId ?? run.id}`;
}

async function turnShowsOutput(
  prisma: Pick<PrismaClient, "message">,
  run: { id: string },
  blocks: readonly MessageBlock[],
): Promise<boolean> {
  if (blocks.some((block) => OUTPUT_BLOCKS.has(block.kind))) return true;
  const posted = await prisma.message.findMany({
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
    select: { blocks: true },
    take: 20,
  });
  const all = [
    ...posted.flatMap((message) =>
      Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [],
    ),
    ...blocks,
  ];
  if (all.some((block) => OUTPUT_BLOCKS.has(block.kind))) return true;
  const text = [
    ...new Set(all.flatMap((block) => (block.kind === "text" ? [block.text.trim()] : []))),
  ]
    .join("\n")
    .trim();
  return !bareCompletionClaim(text);
}

/** True when it queued the member's extra turn instead of returning the stage. Never throws. */
export async function askForMissingStageOutput(
  deps: Pick<ExecutorDeps, "prisma" | "jobs">,
  run: MemberRun,
  blocks: readonly MessageBlock[],
): Promise<boolean> {
  try {
    if (await turnShowsOutput(deps.prisma, run, blocks)) return false;
    const clientNonce = stageOutputNonce(run);
    const queued = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
      const asked = await tx.run.findFirst({
        where: { spaceId: run.spaceId, clientNonce },
        select: { id: true },
      });
      if (asked) return undefined;
      const task = await tx.task.create({
        data: {
          spaceId: run.spaceId,
          botId: run.botId,
          threadId: run.threadId,
          userId: run.userId,
          prompt: STAGE_OUTPUT_MISSING_PROMPT,
          status: "queued",
        },
      });
      const next = await tx.run.create({
        data: {
          spaceId: run.spaceId,
          botId: run.botId,
          threadId: run.threadId,
          taskId: task.id,
          userId: run.userId,
          status: "queued",
          trigger: "follow_up",
          // Same stage: the handoff that gave it to this member stays its source.
          sourceMessageId: run.sourceMessageId ?? null,
          clientNonce,
        },
      });
      return next.id;
    });
    if (!queued) return false;
    getLogger().info("team stage ended without output; asked for it", { runId: run.id });
    await deps.jobs.enqueue(runContinueJob(queued)).catch((error) => {
      getLogger().error("stage output enqueue", error);
    });
    return true;
  } catch (error) {
    getLogger().error("stage output check", error);
    return false;
  }
}
