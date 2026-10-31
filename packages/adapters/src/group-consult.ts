import { runContinueJob } from "@rakazo/adapter-kit";
import { MessageBlock } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  GROUP_QUESTION_SENT_NOTE,
  type GroupQuestionRefusal,
  groupAnswerNonce,
  groupQuestionAskerRunId,
  groupQuestionLimits,
  groupQuestionNonce,
  groupQuestionRefusalText,
  isGroupQuestionNonce,
  resolveBotAddress,
  teammateAnswerPrompt,
  teammateNoAnswerCardText,
  teammateNoAnswerPrompt,
  teammateQuestionPrompt,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { holdWhileBusy } from "./group-held-runs.js";
import { humanAnchorForRun } from "./group-team-run-anchor.js";

/**
 * ask_teammate (see core group-consult.ts). The question is a visible card in the group
 * (a handoff block whose message carries the `group-question:<asker run>` nonce) that starts
 * one answering turn for the asked member. When that turn ends, its reply is routed back: the
 * asker gets a new turn (run nonce `group-answer:<question>`) with the answer as its prompt and
 * the question as its source, so it keeps its own stage. None of this goes through the handoff
 * gate, so questions never count as handoffs, hops or leader repeats.
 */

type Tx = Prisma.TransactionClient;
type Db = PrismaClient;
type GroupRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
};
type HandoffBlock = Extract<MessageBlock, { kind: "handoff" }>;
type SourceMessage = {
  id: string;
  botId: string | null;
  clientNonce: string | null;
  blocks: unknown;
};

export type AskTeammateResult =
  | { error: string; reason: GroupQuestionRefusal | "group_unavailable" | "source_inactive" }
  | {
      ok: true;
      asked: true;
      botId: string;
      runId: string;
      questionMessageId: string;
      note: string;
    };

function handoffBlockOf(blocks: unknown): HandoffBlock | undefined {
  const parsed = MessageBlock.array().safeParse(blocks);
  return parsed.success
    ? parsed.data.find((block): block is HandoffBlock => block.kind === "handoff")
    : undefined;
}

/** The question a message asks, when it is a teammate question. */
export function teammateQuestionOf(
  message: Pick<SourceMessage, "clientNonce" | "blocks"> | null | undefined,
): HandoffBlock | undefined {
  if (!message || !isGroupQuestionNonce(message.clientNonce)) return undefined;
  return handoffBlockOf(message.blocks);
}

/** Whether a run whose source is `message` is answering a teammate's question. */
export function answersTeammateQuestion(
  message: Pick<SourceMessage, "clientNonce" | "blocks"> | null | undefined,
  botId: string,
): boolean {
  return teammateQuestionOf(message)?.toBotId === botId;
}

const QUESTION_LABEL = "【提问】";

function questionText(block: HandoffBlock): string {
  return block.text.startsWith(QUESTION_LABEL)
    ? block.text.slice(QUESTION_LABEL.length)
    : block.text;
}

/**
 * The stage a run works on, for the handoff path's chain checks. A run started by a question
 * it asked (the asker woken with the answer) still works on the stage its asking turn had, so
 * its hand-back guard and hop come from that stage's source, not from the question card.
 * Returns the source to check, or a refusal for a turn that is answering a question.
 */
export async function stageSourceForHandoff(
  tx: Pick<Tx, "run" | "message">,
  run: { botId: string },
  source: SourceMessage | null,
): Promise<{ refused: string } | { source: SourceMessage | null }> {
  let current = source;
  for (let depth = 0; depth < 10; depth++) {
    const question = teammateQuestionOf(current);
    if (!question || !current) return { source: current };
    if (question.toBotId === run.botId) {
      return {
        refused:
          "you are answering a teammate's question; answer it in your reply, which goes back to them automatically. Do not hand off.",
      };
    }
    const askerRunId = groupQuestionAskerRunId(current.clientNonce);
    const asking = askerRunId
      ? await tx.run.findUnique({
          where: { id: askerRunId },
          select: {
            sourceMessage: { select: { id: true, botId: true, clientNonce: true, blocks: true } },
          },
        })
      : null;
    current = asking?.sourceMessage ?? null;
  }
  return { source: current };
}

/** ask_teammate's handler body: records the question and wakes the asked member. */
export async function askTeammate(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: GroupRun,
  groupId: string,
  input: { bot_id?: string; confirm_name?: string; question: string },
  now = new Date(),
): Promise<AskTeammateResult> {
  const question = input.question.trim();
  const card = `${QUESTION_LABEL}${question}`;
  if (!question || card.length > BOT_MESSAGE_MAX_LENGTH) {
    return refusal("invalid_question");
  }
  const limits = groupQuestionLimits();
  type Committed =
    | Extract<AskTeammateResult, { error: string }>
    | {
        ok: true;
        botId: string;
        runId: string;
        questionMessageId: string;
        held: boolean;
        seq: number | undefined;
      };
  const committed = await deps.prisma.$transaction(async (tx): Promise<Committed> => {
    try {
      await lockOwnedGroup(tx, run, groupId);
    } catch (error) {
      if (error instanceof IsolationError)
        return { error: "group is no longer available", reason: "group_unavailable" } as const;
      throw error;
    }
    const group = await tx.chatGroup.findFirst({
      where: { id: groupId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
      include: {
        thread: { select: { id: true } },
        members: {
          where: { bot: { archivedAt: null } },
          include: { bot: { select: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    // A question stays in the group the asker works in.
    if (!group?.thread || group.thread.id !== run.threadId) return refusal("not_in_group");
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    const source = await tx.run.findFirst({
      where: { id: run.id, threadId: run.threadId, botId: run.botId, status: "running" },
      select: {
        createdAt: true,
        sourceMessage: { select: { id: true, botId: true, clientNonce: true, blocks: true } },
      },
    });
    if (!source)
      return { error: "source run is no longer active", reason: "source_inactive" } as const;
    if (answersTeammateQuestion(source.sourceMessage, run.botId))
      return refusal("answering_question");
    const members = group.members.map((member) => member.bot);
    const asker = members.find((member) => member.id === run.botId);
    if (!asker) return refusal("not_in_group");
    const target = resolveBotAddress(members, { botId: input.bot_id, name: input.confirm_name });
    if (!target) return refusal("not_in_group");
    if (target.id === run.botId) return refusal("self_target");

    const nonce = groupQuestionNonce(run.id);
    const existing = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId: run.threadId, clientNonce: nonce } },
      select: { id: true, blocks: true, sourceRuns: { take: 1, select: { id: true } } },
    });
    if (existing) {
      const recorded = handoffBlockOf(existing.blocks);
      const answerRun = existing.sourceRuns[0];
      // A replay of the same call reuses the record; a second question in one turn is refused.
      if (recorded?.toBotId === target.id && recorded.text === card && answerRun) {
        return {
          ok: true,
          botId: target.id,
          runId: answerRun.id,
          questionMessageId: existing.id,
          held: true,
          seq: undefined,
        };
      }
      return refusal("one_question_per_turn");
    }

    // Bounded per human request: every question since the human message this turn answers.
    const anchor = await humanAnchorForRun(tx, {
      id: run.id,
      threadId: run.threadId,
      createdAt: source.createdAt,
    });
    const earlier = await tx.message.findMany({
      where: {
        threadId: run.threadId,
        clientNonce: { startsWith: "group-question:" },
        ...(anchor
          ? { seq: { gt: anchor.seq } }
          : { createdAt: { gt: new Date(now.getTime() - 3_600_000) } }),
      },
      select: { botId: true, blocks: true },
      take: 100,
    });
    if (earlier.length >= limits.maxPerChain) return refusal("question_limit");
    const samePair = earlier.filter(
      (message) =>
        message.botId === run.botId && handoffBlockOf(message.blocks)?.toBotId === target.id,
    ).length;
    if (samePair >= limits.maxPerPair) return refusal("pair_limit");

    const stage = await stageSourceForHandoff(tx, run, source.sourceMessage);
    const hop = "source" in stage ? handoffBlockOf(stage.source?.blocks)?.hop : undefined;
    const block: MessageBlock = {
      kind: "handoff",
      fromBotId: run.botId,
      toBotId: target.id,
      text: card,
      ...(hop === undefined ? {} : { hop }),
    };
    const message = await createThreadMessageInTransaction(tx, {
      threadId: run.threadId,
      role: "bot",
      blocks: [block],
      botId: run.botId,
      runId: run.id,
      clientNonce: nonce,
    });
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: target.id,
        threadId: run.threadId,
        userId: run.userId,
        prompt: teammateQuestionPrompt({ askerName: asker.name, question }),
        status: "queued",
      },
    });
    const heldUntil = await holdWhileBusy(tx, { threadId: run.threadId, botId: target.id }, now);
    const answerRun = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: target.id,
        threadId: run.threadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: "follow_up",
        sourceMessageId: message.id,
        ...(heldUntil ? { wakeAt: heldUntil } : {}),
      },
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks: [block] },
    });
    await touchGroupUpdatedAt(tx, groupId);
    return {
      ok: true,
      botId: target.id,
      runId: answerRun.id,
      questionMessageId: message.id,
      held: Boolean(heldUntil),
      seq: event.seq,
    };
  });
  if ("error" in committed) {
    getLogger().info("teammate question refused", {
      runId: run.id,
      reason: committed.reason,
      targetId: input.bot_id,
    });
    return committed;
  }
  if (committed.seq !== undefined) {
    await deps.events.notify(run.threadId, committed.seq).catch((error) => {
      getLogger().error("teammate question notification", error);
    });
  }
  if (!committed.held) {
    await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
      getLogger().error("teammate question enqueue", error);
    });
  }
  return {
    ok: true,
    asked: true,
    botId: committed.botId,
    runId: committed.runId,
    questionMessageId: committed.questionMessageId,
    note: GROUP_QUESTION_SENT_NOTE,
  };
}

function refusal(reason: GroupQuestionRefusal) {
  return { error: groupQuestionRefusalText(reason), reason } as const;
}

/** Whether this turn asked a teammate a question (its asker then waits for the answer). */
export async function askedThisTurn(
  prisma: Pick<Db, "message">,
  run: { id: string; threadId: string },
): Promise<boolean> {
  const asked = await prisma.message.findUnique({
    where: {
      threadId_clientNonce: { threadId: run.threadId, clientNonce: groupQuestionNonce(run.id) },
    },
    select: { id: true },
  });
  return Boolean(asked);
}

type Delivery =
  | { kind: "answer"; answer: string }
  | { kind: "no_answer"; reason: "timeout" | "failed" };

/**
 * Wakes the asker of `questionMessageId` once, with the answer or with its absence. Idempotent
 * (one run per question, keyed by its nonce); skipped when the human wrote after the question,
 * since the human's message now leads. Returns the asker's new run id when one was queued.
 */
export async function wakeAsker(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  questionMessageId: string,
  delivery: Delivery,
  options: { answeringRunId?: string } = {},
  now = new Date(),
): Promise<string | undefined> {
  const committed = await deps.prisma.$transaction(async (tx) => {
    const question = await tx.message.findUnique({
      where: { id: questionMessageId },
      select: {
        id: true,
        threadId: true,
        seq: true,
        botId: true,
        clientNonce: true,
        blocks: true,
        thread: { select: { spaceId: true } },
      },
    });
    const block = teammateQuestionOf(question);
    const askerRunId = groupQuestionAskerRunId(question?.clientNonce);
    if (!question || !block || !askerRunId) return undefined;
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${question.threadId} FOR UPDATE`;
    const nonce = groupAnswerNonce(question.id);
    const already = await tx.run.findFirst({
      where: { spaceId: question.thread.spaceId, clientNonce: nonce },
      select: { id: true },
    });
    if (already) return undefined;
    const askerRun = await tx.run.findUnique({
      where: { id: askerRunId },
      select: { spaceId: true, userId: true, botId: true },
    });
    if (!askerRun || askerRun.botId !== block.fromBotId) return undefined;
    const newerHuman = await tx.message.findFirst({
      where: { threadId: question.threadId, role: "user", seq: { gt: question.seq } },
      select: { id: true },
    });
    if (newerHuman) {
      getLogger().info("teammate answer not routed: the user wrote since", {
        questionMessageId: question.id,
      });
      return undefined;
    }
    const names = await tx.bot.findMany({
      where: { id: { in: [block.fromBotId, block.toBotId] } },
      select: { id: true, name: true },
    });
    const name = (id: string) => names.find((bot) => bot.id === id)?.name ?? id;
    const asked = questionText(block);
    const prompt =
      delivery.kind === "answer"
        ? teammateAnswerPrompt({
            answererName: name(block.toBotId),
            question: asked,
            answer: delivery.answer.slice(0, BOT_MESSAGE_MAX_LENGTH),
          })
        : teammateNoAnswerPrompt({
            answererName: name(block.toBotId),
            question: asked,
            reason: delivery.reason,
          });
    let noticeSeq: number | undefined;
    if (delivery.kind === "no_answer") {
      // The user sees why the asker moved on without an answer.
      const blocks: MessageBlock[] = [
        {
          kind: "text",
          text: teammateNoAnswerCardText(
            name(block.toBotId),
            name(block.fromBotId),
            delivery.reason,
          ),
        },
      ];
      const notice = await createThreadMessageInTransaction(tx, {
        threadId: question.threadId,
        role: "bot",
        blocks,
        botId: block.fromBotId,
        clientNonce: `group-question-notice:${question.id}`,
      });
      noticeSeq = (
        await appendEventInTransaction(tx, {
          spaceId: askerRun.spaceId,
          threadId: question.threadId,
          botId: block.fromBotId,
          type: "thread.message.created",
          payload: { messageId: notice.id, role: "bot", blocks },
        })
      ).seq;
    }
    const task = await tx.task.create({
      data: {
        spaceId: askerRun.spaceId,
        botId: block.fromBotId,
        threadId: question.threadId,
        userId: askerRun.userId,
        prompt,
        status: "queued",
      },
    });
    const heldUntil = await holdWhileBusy(
      tx,
      {
        threadId: question.threadId,
        botId: block.fromBotId,
        exceptRunIds: options.answeringRunId ? [options.answeringRunId] : [],
      },
      now,
    );
    const resumed = await tx.run.create({
      data: {
        spaceId: askerRun.spaceId,
        botId: block.fromBotId,
        threadId: question.threadId,
        taskId: task.id,
        userId: askerRun.userId,
        status: "queued",
        trigger: "follow_up",
        // The question is the source: the asker's stage is found through it (see
        // stageSourceForHandoff), and the turn is never mistaken for one the user started.
        sourceMessageId: question.id,
        clientNonce: nonce,
        ...(heldUntil ? { wakeAt: heldUntil } : {}),
      },
    });
    return { runId: resumed.id, held: Boolean(heldUntil), threadId: question.threadId, noticeSeq };
  });
  if (!committed) return undefined;
  if (committed.noticeSeq !== undefined) {
    await deps.events.notify(committed.threadId, committed.noticeSeq).catch((error) => {
      getLogger().error("teammate no-answer notification", error);
    });
  }
  if (!committed.held) {
    await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
      getLogger().error("teammate answer enqueue", error);
    });
  }
  return committed.runId;
}

/**
 * The group end-of-turn step for questions. A turn that asked waits for its answer (no stage
 * return, no requested handoff); a turn that answered routes its reply to the asker. Returns
 * whether the turn was one of those, so the regular team-run step is skipped for it.
 */
export async function teammateQuestionAfterTurn(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: GroupRun & { sourceMessageId?: string | null },
  input: { replyText: string },
): Promise<{ handled: boolean }> {
  if (await askedThisTurn(deps.prisma, run)) return { handled: true };
  if (!run.sourceMessageId) return { handled: false };
  const source = await deps.prisma.message.findUnique({
    where: { id: run.sourceMessageId },
    select: { id: true, botId: true, clientNonce: true, blocks: true },
  });
  if (!answersTeammateQuestion(source, run.botId) || !source) return { handled: false };
  const answer = (await answerText(deps.prisma, run.id)) || input.replyText;
  await wakeAsker(deps, source.id, { kind: "answer", answer }, { answeringRunId: run.id });
  return { handled: true };
}

/** Everything the answering turn posted, in order (an answer may span interim messages). */
async function answerText(prisma: Pick<Db, "message">, runId: string): Promise<string> {
  const messages = await prisma.message.findMany({
    where: { runId, role: "bot" },
    orderBy: { seq: "asc" },
    select: { blocks: true, clientNonce: true },
    take: 20,
  });
  return messages
    .filter((message) => !isGroupQuestionNonce(message.clientNonce))
    .flatMap((message) =>
      Array.isArray(message.blocks)
        ? (message.blocks as MessageBlock[]).flatMap((block) =>
            block.kind === "text" ? [block.text] : [],
          )
        : [],
    )
    .join("\n\n")
    .trim();
}

const ACTIVE = ["queued", "leased", "running", "waiting_input", "waiting_takeover"];

/**
 * Reconciler step: a question whose answering turn failed, or that has gone unanswered past the
 * timeout, wakes its asker without an answer and says so in the group. Never throws.
 */
const QUESTION_RECONCILE_LOOKBACK_MS = 2 * 3_600_000;

export async function reconcileTeammateQuestions(
  deps: Pick<ExecutorDeps, "prisma" | "jobs"> & {
    events?: Pick<ExecutorDeps["events"], "notify">;
  },
  now = new Date(),
): Promise<void> {
  const { timeoutMs } = groupQuestionLimits();
  // Only questions whose asker was not woken yet, newest first and within a bounded window, so
  // old leftovers (a question the user moved past) never crowd out a new one.
  const questionSource = {
    clientNonce: { startsWith: "group-question:" },
    sourceRuns: { none: { clientNonce: { startsWith: "group-answer:" } } },
  };
  const lookback = new Date(now.getTime() - timeoutMs - QUESTION_RECONCILE_LOOKBACK_MS);
  const select = {
    id: true,
    botId: true,
    status: true,
    sourceMessageId: true,
  } as const;
  const [ended, waiting] = await Promise.all([
    deps.prisma.run.findMany({
      where: {
        status: { in: ["failed", "cancelled"] },
        updatedAt: { gt: new Date(now.getTime() - QUESTION_RECONCILE_LOOKBACK_MS) },
        trigger: "follow_up",
        sourceMessage: questionSource,
      },
      select,
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
    deps.prisma.run.findMany({
      where: {
        status: { in: ACTIVE },
        trigger: "follow_up",
        createdAt: { lte: new Date(now.getTime() - timeoutMs), gt: lookback },
        sourceMessage: questionSource,
      },
      select,
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  const events = deps.events ?? { notify: async () => undefined };
  const wakeDeps = { prisma: deps.prisma, jobs: deps.jobs, events } as Pick<
    ExecutorDeps,
    "prisma" | "events" | "jobs"
  >;
  for (const [runs, reason] of [
    [ended, "failed"],
    [waiting, "timeout"],
  ] as const) {
    for (const row of runs) {
      try {
        // Read per row: one unreadable message must not stop the others.
        const sourceMessage = row.sourceMessageId
          ? await deps.prisma.message.findUnique({
              where: { id: row.sourceMessageId },
              select: { id: true, botId: true, clientNonce: true, blocks: true, createdAt: true },
            })
          : null;
        if (!sourceMessage || !answersTeammateQuestion(sourceMessage, row.botId)) continue;
        if (reason === "timeout" && sourceMessage.createdAt.getTime() > now.getTime() - timeoutMs)
          continue;
        if (reason === "failed") {
          // A retry of the answering turn is still going to answer.
          const retry = await deps.prisma.run.findFirst({
            where: { retryOfRunId: row.id },
            select: { id: true },
          });
          if (retry) continue;
        }
        await wakeAsker(wakeDeps, sourceMessage.id, { kind: "no_answer", reason }, {}, now);
      } catch (error) {
        getLogger().error("teammate question reconcile", error);
      }
    }
  }
}

/**
 * The turn a run continues: a run woken with a teammate's answer carries on the stage of the
 * turn that asked, so the user's own request ("then pass it to …") still applies to it.
 */
export async function stageOriginOfRun(
  prisma: Pick<Db, "message" | "run">,
  run: { botId: string; trigger: string; sourceMessageId?: string | null },
): Promise<{ trigger: string; sourceMessageId: string | null }> {
  let origin = { trigger: run.trigger, sourceMessageId: run.sourceMessageId ?? null };
  for (let depth = 0; depth < 10 && origin.sourceMessageId; depth++) {
    const source = await prisma.message.findUnique({
      where: { id: origin.sourceMessageId },
      select: { clientNonce: true, blocks: true },
    });
    const question = teammateQuestionOf(source);
    if (question?.fromBotId !== run.botId) return origin;
    const askerRunId = groupQuestionAskerRunId(source?.clientNonce);
    const asking = askerRunId
      ? await prisma.run.findUnique({
          where: { id: askerRunId },
          select: { trigger: true, sourceMessageId: true },
        })
      : null;
    if (!asking) return origin;
    origin = { trigger: asking.trigger, sourceMessageId: asking.sourceMessageId };
  }
  return origin;
}
