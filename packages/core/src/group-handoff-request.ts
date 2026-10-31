import { type GroupMemberRef, mentionedMembersInOrder } from "./group-mentions.js";

/**
 * A human's explicit "pass it on" instruction in a group message, for any kind of team:
 * "写完大纲，然后交给撰稿", "报价单做好后转给外贸-跟单", "写完需求，然后交给团队-后端",
 * "完成后交给 @团队-后端", "转给团队-测试", "then hand it off to Backend". The system makes that
 * handoff itself when the addressed bot finishes without making it, so it must stay
 * conservative: an exact member name right after a hand-over verb, no negation, question or
 * done-marker before the verb in the same clause, nothing inside quotes, and exactly one target.
 */

// Longest verbs first so "转交给" is not read as "交给" with a stray "转" before it.
const ZH_VERBS = ["转交给", "交接给", "移交给", "转给", "交给"];
const EN_VERB =
  /\b(?:hand|pass)(?:\s+(?:it|this|that|them|the\s+work))?(?:\s+(?:off|on|over))?\s+to\b/gi;

// Before the verb in the same clause: "先别交给", "不要交给", "不用交给", "暂不交给", "已经交给",
// "要不要交给", "是否交给", "don't hand it to", "no need to pass it to".
const ZH_BLOCKERS =
  /别|不要|不用|无需|不必|不需要|先不|暂不|暂时不|不再|勿|没有|没|未|已|刚|要不要|是否|需不需要|能不能|可不可以|如果|假如|万一/;
const EN_BLOCKERS =
  /\b(?:don'?t|do\s+not|never|no\s+need|not|already|just|if|whether|should\s+i|instead\s+of)\b/i;

// Quoted text is an example or a line to write, not an instruction: “已交给团队-测试”.
const QUOTED = /“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"]*"|`[^`]*`/g;
const CLAUSE_END = /[。！？!?；;，,、\n]/;
const SENTENCE_END = /[。！？!?\n]/;

export type RequestedHandoff<T extends GroupMemberRef> = {
  member: T;
  /** Where the member's name (with any "@" before it) sits after each hand-over verb. */
  spans: Array<[number, number]>;
};

function clauseStart(text: string, index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) if (CLAUSE_END.test(text[i]!)) return i + 1;
  return 0;
}

function sentenceAfter(text: string, index: number): string {
  let end = index;
  while (end < text.length && !SENTENCE_END.test(text[end]!)) end += 1;
  return text.slice(index, end + 1);
}

function memberAt<T extends GroupMemberRef>(
  text: string,
  index: number,
  byLength: readonly T[],
): { member: T; start: number; end: number } | undefined {
  let at = index;
  while (at < text.length && /\s/.test(text[at]!)) at += 1;
  const start = at;
  if (text[at] === "@" || text[at] === "＠") at += 1;
  while (at < text.length && /\s/.test(text[at]!)) at += 1;
  const rest = text.slice(at).toLowerCase();
  for (const member of byLength) {
    const name = member.name.trim().toLowerCase();
    if (!rest.startsWith(name)) continue;
    // A longer Latin word is a different name ("Backend" is not "Back"); CJK may run on.
    const next = rest.charAt(name.length);
    if (/[a-z0-9_-]/i.test(next) && /[a-z0-9_-]$/i.test(name)) continue;
    return { member, start, end: at + name.length };
  }
  return undefined;
}

/** Verb hits as [verb start, verb end] in the quote-free text. */
function verbHits(text: string): Array<[number, number]> {
  const hits: Array<[number, number]> = [];
  for (let i = 0; i < text.length; i += 1) {
    const verb = ZH_VERBS.find((candidate) => text.startsWith(candidate, i));
    if (verb) {
      hits.push([i, i + verb.length]);
      i += verb.length - 1;
    }
  }
  for (const match of text.matchAll(EN_VERB)) {
    const start = match.index ?? 0;
    hits.push([start, start + match[0].length]);
  }
  return hits.sort((a, b) => a[0] - b[0]);
}

/**
 * The one member a human message explicitly asks `selfId` to hand the work to, or undefined
 * when there is none, it is negated, hypothetical or a question, or more than one is named.
 */
export function requestedHandoffTarget<T extends GroupMemberRef>(
  text: string,
  members: readonly T[],
  selfId: string,
): RequestedHandoff<T> | undefined {
  const clean = text.replace(QUOTED, (quoted) => " ".repeat(quoted.length));
  const byLength = members
    .filter((member) => member.name.trim())
    .sort((a, b) => b.name.trim().length - a.name.trim().length);
  if (!byLength.length) return undefined;
  const found = new Map<string, RequestedHandoff<T>>();
  for (const [start, end] of verbHits(clean)) {
    const hit = memberAt(clean, end, byLength);
    if (!hit) continue;
    const before = clean.slice(clauseStart(clean, start), start);
    if (ZH_BLOCKERS.test(before) || EN_BLOCKERS.test(before)) continue;
    const sentence = sentenceAfter(clean, end);
    if (/[？?]/.test(sentence) || /吗\s*[。！!]?\s*$/.test(sentence.trim())) continue;
    const entry = found.get(hit.member.id) ?? { member: hit.member, spans: [] };
    entry.spans.push([hit.start, hit.end]);
    found.set(hit.member.id, entry);
  }
  if (found.size !== 1) return undefined;
  const [request] = [...found.values()];
  if (!request || request.member.id === selfId) return undefined;
  return request;
}

/** Shown on the system-made handoff card, so nobody mistakes it for the bot's own call. */
export function systemHandoffMarker(name: string): string {
  return `（系统按你的要求交给 ${name}）`;
}

// The bot said it will not or cannot pass the work on: "无法交给后端", "我不能交接".
const REFUSAL =
  /(?:无法|不能|不会|没法|不便|拒绝)[^。！？!?\n]{0,12}(?:交给|交接|转交|移交|转给)|\b(?:can(?:no|')t|won'?t|unable to|refuse to)\s+(?:hand|pass)\b/i;
// The bot is waiting on the user: a question at the end of its reply.
const ASKS_USER =
  /[？?]\s*$|(?:请(?:你|您)?(?:确认|告诉|提供|补充)|需要你|等你)[^。！？!?\n]*[。！!]?\s*$/;

/** Whether a bot's finished reply ends by asking the user something. */
export function replyWaitsOnUser(reply: string): boolean {
  return ASKS_USER.test(reply.trim());
}

/** Whether a bot's finished reply refuses the handoff or waits on the user instead. */
export function replyBlocksRequestedHandoff(reply: string): boolean {
  return REFUSAL.test(reply.trim()) || replyWaitsOnUser(reply);
}

/**
 * "@团队-产品 写需求，然后交给@团队-后端": the "@" after the hand-over verb names who gets the
 * work next, not who should start now. When a human message wakes exactly that member and one
 * other, and the member is "@"-ed nowhere else, the member is not woken directly; the other
 * bot's turn hands the work over (itself, or by the system when it does not).
 */
export function deferredHandoffTargetId(
  text: string,
  members: readonly GroupMemberRef[],
  targetIds: readonly string[],
): string | undefined {
  const woken = [...new Set(targetIds)];
  if (woken.length !== 2) return undefined;
  for (const selfId of woken) {
    const request = requestedHandoffTarget(text, members, selfId);
    const deferredId = request?.member.id;
    if (!request || !deferredId || !woken.includes(deferredId)) continue;
    let rest = text;
    for (const [start, end] of request.spans) {
      rest = `${rest.slice(0, start)}${" ".repeat(end - start)}${rest.slice(end)}`;
    }
    const elsewhere = mentionedMembersInOrder(rest, members).some(
      (member) => member.id === deferredId,
    );
    if (!elsewhere) return deferredId;
  }
  return undefined;
}
