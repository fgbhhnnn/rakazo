import type { MessageBlock } from "@rakazo/contracts";
import { replyWaitsOnUser } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { stageOriginOfRun, teammateQuestionAfterTurn } from "./group-consult.js";
import { releaseHeldGroupRun } from "./group-held-runs.js";
import { handoffRequestedByHuman } from "./group-requested-handoff.js";
import { continueTeamRun } from "./group-team-run.js";

/**
 * After a group turn completed and its reply was saved: the handoff the human asked for, then
 * the team run's next step. Both run in code, so a model that forgets to call the tool cannot
 * stall the group. Never throws. Returns whether a claim recheck of this turn would be stale
 * (see continueTeamRun).
 */
export async function afterGroupTurn(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    trigger: string;
    createdAt: Date;
    sourceMessageId?: string | null;
  },
  input: {
    thread: { groupId: string | null | undefined };
    bot: { id: string; name: string; spawnKey?: string | null };
    blocks: readonly MessageBlock[];
    handoffTargets: readonly string[];
    /** The user steered the turn; its continuation run answers instead. */
    continued: boolean;
  },
): Promise<{ suppressClaimRecheck: boolean }> {
  if (!input.thread.groupId) return { suppressClaimRecheck: false };
  try {
    return await groupTurnSteps(deps, run, input);
  } finally {
    // A wake queued behind this turn (group-held-runs.ts) starts now.
    await releaseHeldGroupRun(deps, run);
  }
}

async function groupTurnSteps(
  deps: Parameters<typeof afterGroupTurn>[0],
  run: Parameters<typeof afterGroupTurn>[1],
  input: Parameters<typeof afterGroupTurn>[2],
): Promise<{ suppressClaimRecheck: boolean }> {
  const replyText = input.blocks
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("")
    .trim();
  // A turn that asked a teammate waits for the answer; a turn that answered routes it back.
  // Neither is a finished stage, so the requested handoff and the team run's step wait.
  const question = await teammateQuestionAfterTurn(deps, run, { replyText }).catch((error) => {
    getLogger().error("teammate question turn end", error);
    return { handled: false };
  });
  if (question.handled) return { suppressClaimRecheck: true };
  const waitsOnUser =
    input.blocks.some((block) => block.kind === "ask") || replyWaitsOnUser(replyText);
  const origin = await stageOriginOfRun(deps.prisma, run).catch(() => ({
    trigger: run.trigger,
    sourceMessageId: run.sourceMessageId ?? null,
  }));
  await handoffRequestedByHuman(
    deps,
    { ...run, ...origin },
    {
      groupId: input.thread.groupId,
      bot: input.bot,
      replyText,
      waitsOnUser,
      continued: input.continued,
      handoffTargets: input.handoffTargets,
    },
  );
  return continueTeamRun(deps, run, {
    thread: input.thread,
    bot: input.bot,
    replyText,
    blocks: input.blocks,
    waitsOnUser,
    continued: input.continued,
  });
}
