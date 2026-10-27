import type { MessageBlock } from "@rakazo/contracts";
import { replyWaitsOnUser } from "@rakazo/core";
import type { ExecutorDeps } from "./executor-deps.js";
import { handoffRequestedByHuman } from "./group-requested-handoff.js";
import { continueTeamRun } from "./group-team-run.js";

/**
 * After a group turn completed and its reply was saved: the handoff the human asked for, then
 * the team run's next step. Both run in code, so a model that forgets to call the tool cannot
 * stall the group. Never throws.
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
): Promise<void> {
  if (!input.thread.groupId) return;
  const replyText = input.blocks
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("")
    .trim();
  const waitsOnUser =
    input.blocks.some((block) => block.kind === "ask") || replyWaitsOnUser(replyText);
  await handoffRequestedByHuman(deps, run, {
    groupId: input.thread.groupId,
    bot: input.bot,
    replyText,
    waitsOnUser,
    continued: input.continued,
    handoffTargets: input.handoffTargets,
  });
  await continueTeamRun(deps, run, {
    thread: input.thread,
    bot: input.bot,
    replyText,
    waitsOnUser,
    continued: input.continued,
  });
}
