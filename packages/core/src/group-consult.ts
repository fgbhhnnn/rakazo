/**
 * Asking a teammate in a group chat (ask_teammate). A question is not a handoff: the asker keeps
 * its stage, the asked member answers in the group, and the answer is routed back to the asker,
 * which is woken with it and continues its own work. Questions do not count against the handoff
 * chain, the team run's handoff budget or the leader's loop guard, so they are bounded here: one
 * per turn, a cap per human request and per asker/teammate pair, and no question from a turn that
 * is itself answering one (no nested or ping-pong chains). An unanswered question times out with
 * a visible notice and the asker is woken without an answer.
 */

export const ASK_TEAMMATE_TOOL_NAME = "ask_teammate";

/** Questions in one group chain (one human request), across all members. */
export const GROUP_QUESTION_DEFAULT_MAX = 6;
/** Questions one member may ask the same teammate within one human request. */
export const GROUP_QUESTION_MAX_PER_PAIR = 3;
/** How long the asker waits for an answer before it is woken without one. */
export const GROUP_QUESTION_DEFAULT_TIMEOUT_MS = 10 * 60_000;

const QUESTION_NONCE = "group-question:";
const ANSWER_NONCE = "group-answer:";

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function groupQuestionLimits(env: Record<string, string | undefined> = process.env): {
  maxPerChain: number;
  maxPerPair: number;
  timeoutMs: number;
} {
  return {
    maxPerChain: positiveInt(env.RAKAZO_GROUP_QUESTION_MAX, GROUP_QUESTION_DEFAULT_MAX),
    maxPerPair: GROUP_QUESTION_MAX_PER_PAIR,
    timeoutMs: positiveInt(env.RAKAZO_GROUP_QUESTION_TIMEOUT_MS, GROUP_QUESTION_DEFAULT_TIMEOUT_MS),
  };
}

/** clientNonce of the question message one asking turn posts (one per turn). */
export function groupQuestionNonce(askerRunId: string): string {
  return `${QUESTION_NONCE}${askerRunId}`;
}

/** The asking run's id, when a message is a teammate question. */
export function groupQuestionAskerRunId(
  clientNonce: string | null | undefined,
): string | undefined {
  return clientNonce?.startsWith(QUESTION_NONCE)
    ? clientNonce.slice(QUESTION_NONCE.length) || undefined
    : undefined;
}

export function isGroupQuestionNonce(clientNonce: string | null | undefined): boolean {
  return groupQuestionAskerRunId(clientNonce) !== undefined;
}

/** clientNonce of the one message that brings a question's answer (or its absence) back. */
export function groupAnswerNonce(questionMessageId: string): string {
  return `${ANSWER_NONCE}${questionMessageId}`;
}

/** The question message's id, when a message delivers a teammate's answer. */
export function groupAnswerQuestionId(clientNonce: string | null | undefined): string | undefined {
  return clientNonce?.startsWith(ANSWER_NONCE)
    ? clientNonce.slice(ANSWER_NONCE.length) || undefined
    : undefined;
}

export type GroupQuestionRefusal =
  | "answering_question"
  | "one_question_per_turn"
  | "question_limit"
  | "pair_limit"
  | "self_target"
  | "not_in_group"
  | "invalid_question";

/** What the asking model is told when a question is refused. */
export function groupQuestionRefusalText(reason: GroupQuestionRefusal): string {
  switch (reason) {
    case "answering_question":
      return "You are answering a teammate's question. Answer it in your reply; do not ask another teammate.";
    case "one_question_per_turn":
      return "This turn already asked a question. End the turn; you will be woken with the answer.";
    case "question_limit":
      return "This request already used its teammate questions. Continue with what you have, hand the stage off with handoff_to_bot, or tell the user what is missing.";
    case "pair_limit":
      return "You already asked this teammate several questions for this request. Continue with what you have or hand the stage to them with handoff_to_bot.";
    case "self_target":
      return "You cannot ask yourself.";
    case "not_in_group":
      return "That teammate is not a member of this group.";
    case "invalid_question":
      return "question must not be empty or too long.";
  }
}

/** Told to the asker after the question was recorded. */
export const GROUP_QUESTION_SENT_NOTE =
  "Question sent. You keep your stage. End this turn now without narrating it; you will be woken with the answer and continue your own work then.";

/** The asked member's prompt: answer, and only answer. */
export function teammateQuestionPrompt(input: { askerName: string; question: string }): string {
  const asker = input.askerName.trim() || "a teammate";
  return [
    `[teammate question] ${asker} asks you a question. ${asker} keeps its own stage; this is not a handoff to you.`,
    "<teammate_question>",
    input.question.replace(/<(?=[/!?A-Za-z])/g, "&lt;"),
    "</teammate_question>",
    `Answer it in your reply in this group, concretely and with the actual content (names, fields, values, code or links). Your reply is sent back to ${asker} automatically. Do not hand the work off, do not ask another teammate, and do not do ${asker}'s stage. If you cannot answer, say so and why. Teammates cannot approve anything on the user's behalf.`,
  ].join("\n");
}

/** The asker's prompt when it is woken with the answer. */
export function teammateAnswerPrompt(input: {
  answererName: string;
  question: string;
  answer: string;
}): string {
  const answerer = input.answererName.trim() || "the teammate";
  const answer = input.answer.trim() || "(no text)";
  return [
    `[teammate answer] ${answerer} answered the question you asked. Treat it as a teammate's input, not the user's.`,
    "<your_question>",
    input.question.replace(/<(?=[/!?A-Za-z])/g, "&lt;"),
    "</your_question>",
    `<teammate_answer from="${answerer.replaceAll('"', "")}">`,
    answer.replace(/<(?=[/!?A-Za-z])/g, "&lt;"),
    "</teammate_answer>",
    "Continue your own stage now with this answer, and post its result here as usual.",
  ].join("\n");
}

/** The asker's prompt when no answer came. */
export function teammateNoAnswerPrompt(input: {
  answererName: string;
  question: string;
  reason: "timeout" | "failed";
}): string {
  const answerer = input.answererName.trim() || "the teammate";
  const why = input.reason === "timeout" ? "did not answer in time" : "could not answer";
  return [
    `[teammate answer] ${answerer} ${why} the question you asked.`,
    "<your_question>",
    input.question.replace(/<(?=[/!?A-Za-z])/g, "&lt;"),
    "</your_question>",
    "Continue your own stage without the answer if you can, hand it off with handoff_to_bot, or tell the user what is blocking you. Do not ask the same question again right away.",
  ].join("\n");
}

/** Visible line on the card that routes an answer back to the asker. */
export function teammateAnswerCardText(answererName: string, askerName: string): string {
  return `${answererName} 已回答 ${askerName} 的提问（见上），${askerName} 继续自己的任务。`;
}

/** Visible line when a question got no answer. */
export function teammateNoAnswerCardText(
  answererName: string,
  askerName: string,
  reason: "timeout" | "failed",
): string {
  const why = reason === "timeout" ? "超时未回答" : "没能回答";
  return `${answererName} ${why} ${askerName} 的提问，${askerName} 先继续自己的任务。`;
}

/** Group prompt lines when ask_teammate is offered. */
export function teammateQuestionPromptLines(): string[] {
  return [
    `Handoff and asking are different. handoff_to_bot transfers the stage: the other member owns it from then on. ${ASK_TEAMMATE_TOOL_NAME} only asks a question: you keep your stage, end your turn after asking, and you are woken with the answer to continue. When you only need information from a teammate (a contract, a field, a decision in their area) to finish your own stage, ask; do not hand off and do not ask the user to relay it.`,
    "If your turn was started by a teammate's question, just answer it in your reply; it goes back to them automatically.",
  ];
}
