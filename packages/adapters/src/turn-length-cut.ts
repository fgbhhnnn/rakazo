/**
 * A bot turn whose reply stops at the model's output-token limit (stopReason "length" with
 * text and no tool call) is cut off mid-sentence, not finished. Laned bot turns (the main bot
 * and background workers) ask the model to continue in the same reply a bounded number of
 * times; a main-bot reply still cut after that ends with a short notice instead of a silent
 * half sentence. Pure helpers; hooked from pi-runtime.ts.
 */
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { automated } from "./automated-messages.js";

/** In-run continues after a length stop; each one is another full model call. */
export const MAX_LENGTH_CONTINUATIONS = 2;

/** Sent in the user's role after a reply stopped at the output limit. */
export const LENGTH_CUT_CONTINUATION_PROMPT = automated(
  "Your previous reply stopped because it reached the output length limit. Continue exactly where it stopped, mid-word if needed, without repeating anything and without starting over.",
);

/** Only bot turns continue; internal unlaned calls (compaction, review) keep their behaviour. */
export function continuesLengthCut(lane: AgentRunRequest["lane"]): boolean {
  return lane === "main" || lane === "background";
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u;

/**
 * Notice appended to a main-bot reply that is still cut at the output limit after the in-run
 * continues, in the reply's own script (Chinese for a reply with CJK text, else English).
 */
export function lengthCutNotice(replyText: string): string {
  return CJK.test(replyText)
    ? "\n\n（回复达到模型单次输出长度上限，到这里被截断了，后面还没写完。回复“继续”我就接着写。）"
    : '\n\n(This reply reached the model\'s output length limit and was cut off here. Reply "continue" and I will pick up where it stopped.)';
}
