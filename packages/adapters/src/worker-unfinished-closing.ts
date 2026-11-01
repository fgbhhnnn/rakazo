/**
 * Whether a worker's final reply says, in its own closing words, that the work is unfinished.
 * Only the closing prose counts: Markdown headings, list items and table rows are content (a
 * summary the user asked for may well have a "未完成事项" section), not the worker talking
 * about its own progress. Pure helpers; hooked from worker-incomplete-result.ts.
 */

/** Roughly how much of the reply's end is examined. */
export const CLOSING_TAIL_CHARS = 300;

/**
 * Self-referential unfinished wording (Chinese and English). Bare 未完成 / "incomplete" are
 * deliberately absent: they describe content far more often than the worker's own state.
 */
const SELF_UNFINISHED_PHRASES: readonly RegExp[] = [
  /还没(?:有)?(?:做完|写完|改完|弄完|跑完)/,
  /(?:我|我们|这边|本次|这次|任务|工作|剩下的?|其余的?|其他的?)(?:还|仍|也)?(?:没(?:有)?|尚未|未能)(?:全部|完全)?(?:做完|完成)/,
  /尚未(?:做完|写完|改完)/,
  /随后补上/,
  /稍后补上/,
  /稍后(?:再)?继续/,
  /(?:我|我们|我会|稍后|下次|之后|回头)(?:再)?接着做/,
  /待续/,
  /还在改/,
  /还在做/,
  /还在写/,
  /\bnot(?:\s+\w+){0,3}\s+finished\b/i,
  /\bhaven'?t\s+finished\b/i,
  /\bstill\s+(?:working\s+on|in\s+progress)\b/i,
  /\b(?:i|we)(?:\s+will|'ll|\s+am\s+going\s+to|\s+are\s+going\s+to)\s+(?:continue|finish)\b/i,
  /\bwill\s+continue\s+(?:with|working|on)\b/i,
  /\bto\s+be\s+continued\b/i,
  /\bnot\s+done\s+yet\b/i,
];

/** Phrases that cancel an unfinished match (the work is done). */
const SELF_FINISHED_NEGATIVES: readonly RegExp[] = [
  /已完成[，,].{0,12}没有未完成/,
  /没有未完成项/,
  /无未完成/,
  /全部完成/,
  /全部做完/,
  /\bno\s+unfinished\b/i,
  /\bnothing\s+left\s+unfinished\b/i,
  /\ball\s+(?:done|complete|finished)\b/i,
];

const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;
const LIST_ITEM = /^\s*(?:[-*+•·]\s|\d{1,3}[.)]\s|\d{1,3}、|[（(]\d{1,3}[)）]|[-*+]\s*\[[ xX]\])/;
const TABLE_ROW = /^\s*\|/;
const RULE_OR_FENCE = /^\s*(?:-{3,}|\*{3,}|_{3,}|`{3,}|~{3,})/;

function isStructuralLine(line: string): boolean {
  return (
    HEADING.test(line) || LIST_ITEM.test(line) || TABLE_ROW.test(line) || RULE_OR_FENCE.test(line)
  );
}

/**
 * The prose at the end of a reply: whole lines from the end until about CLOSING_TAIL_CHARS,
 * minus headings, list items, table rows, rules and code fences.
 */
export function closingProse(text: string): string {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").trimEnd().split("\n");
  const tail: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0 && total < CLOSING_TAIL_CHARS; i--) {
    const line = lines[i] ?? "";
    tail.unshift(line);
    total += line.trim().length;
  }
  const prose = tail
    .filter((line) => line.trim() && !isStructuralLine(line))
    .join("\n")
    .trim();
  // A single long closing paragraph: only its end is the worker's sign-off.
  return prose.length > CLOSING_TAIL_CHARS * 2 ? prose.slice(-CLOSING_TAIL_CHARS * 2) : prose;
}

/** True when the reply's closing prose says the worker itself has not finished. */
export function closingSaysUnfinished(text: string): boolean {
  const closing = closingProse(text);
  if (!closing) return false;
  if (SELF_FINISHED_NEGATIVES.some((re) => re.test(closing))) return false;
  return SELF_UNFINISHED_PHRASES.some((re) => re.test(closing));
}
