import { type GroupMemberRef, mentionedMembersInOrder } from "./group-mentions.js";

/**
 * Group "team" contract shared by the handoff tool and an "@Name" in a bot's group reply:
 * both go through one handoff path, which reports `delivered` only after the next bot's run
 * is recorded, or one of these reasons.
 */
export type HandoffFailureReason =
  | "hop_limit"
  | "not_in_group"
  | "one_handoff_per_turn"
  | "self_target"
  | "hand_back"
  | "group_unavailable"
  | "source_inactive"
  | "invalid_message"
  | "invalid_chain";

/** Shown in the group when a chain of bot-to-bot handoffs reaches its limit. */
export const HANDOFF_CHAIN_LIMIT_NOTICE = "已达到连续交接上限，等你回复。";

/** Appended to a group reply that claims a handoff no handoff backs. */
export function unverifiedHandoffNote(names: readonly string[]): string {
  return names.length ? `（未实际交接给 ${names.join("、")}）` : "（未实际交接）";
}

/** Shown in the group when a handoff named in a reply could not be made. */
export function failedHandoffNotice(name: string, reason: HandoffFailureReason): string {
  if (reason === "hop_limit") return HANDOFF_CHAIN_LIMIT_NOTICE;
  const why: Record<HandoffFailureReason, string> = {
    hop_limit: "已达到连续交接上限",
    not_in_group: "对方不是本群成员",
    one_handoff_per_turn: "一轮只能交接一次",
    self_target: "不能交给自己",
    hand_back: "不能直接交回给刚交来的成员",
    group_unavailable: "群已不可用",
    source_inactive: "本轮已结束",
    invalid_message: "交接内容为空或过长",
    invalid_chain: "交接链无法校验",
  };
  return `未能交接给 ${name}：${why[reason]}。`;
}

export type HandoffBrief = {
  message: string;
  objective?: string;
  context?: string;
  deliverable?: string;
  acceptance?: string;
  artifacts?: readonly string[];
};

/**
 * The text a receiving bot gets: the request plus a short brief and references to artifacts
 * (links, paths, Page ids), never a pasted transcript. Empty fields are left out.
 */
export function formatHandoffBrief(brief: HandoffBrief): string {
  const field = (label: string, value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed ? `${label}：${trimmed}` : undefined;
  };
  const artifacts = (brief.artifacts ?? []).map((ref) => ref.trim()).filter(Boolean);
  return [
    brief.message.trim(),
    field("目标", brief.objective),
    field("背景", brief.context),
    field("交付物", brief.deliverable),
    field("验收标准", brief.acceptance),
    artifacts.length ? `引用：${artifacts.join("，")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

// A done-marker, then (within the sentence) a hand-over verb: "已交给@前端", "我已把需求转交给后端",
// "刚通知了测试", "handed it off to UI". Plans ("接下来交给…") and questions are not claims.
const ZH_CLAIM = /(?:已经?|刚刚?|已)[^。！？!?\n]{0,24}?(?:交给|转交|交接|移交|转给|派给|分配给|通知)/;
const EN_CLAIM =
  /\b(?:I(?:'ve| have)?|we(?:'ve| have)?|just|already)\s+(?:handed|passed|assigned|notified|forwarded)\b/i;
const QUESTION = /[？?]\s*$|吗[。！!]?\s*$|要不要|是否|需不需要/;
const SENTENCE = /[^。！？!?\n]+[。！？!?]*/g;

/** The short role of a member name: "团队-前端" is also called "前端". */
function shortNames(name: string): string[] {
  const full = name.trim();
  const tail = full.split(/[-－·•|｜/]/).pop()?.trim();
  return tail && tail !== full && tail.length >= 2 ? [full, tail] : [full];
}

export type HandoffClaim = { sentence: string; memberIds: string[] };

/** Sentences of a reply that say work was handed to someone, with the members they name. */
export function handoffClaims(text: string, members: readonly GroupMemberRef[]): HandoffClaim[] {
  const claims: HandoffClaim[] = [];
  for (const sentence of text.match(SENTENCE) ?? []) {
    if (QUESTION.test(sentence.trim())) continue;
    if (!ZH_CLAIM.test(sentence) && !EN_CLAIM.test(sentence)) continue;
    const ids = new Set(mentionedMembersInOrder(sentence, members).map((member) => member.id));
    const lower = sentence.toLowerCase();
    for (const member of members) {
      if (shortNames(member.name).some((name) => lower.includes(name.toLowerCase()))) {
        ids.add(member.id);
      }
    }
    claims.push({ sentence, memberIds: [...ids] });
  }
  return claims;
}

/**
 * Checks a group reply's handoff claims against the handoffs this turn really made (the tool,
 * or the reply's own "@Name" about to be routed). Returns the note to append, if any.
 */
export function unverifiedHandoffClaimNote(
  text: string,
  members: readonly GroupMemberRef[],
  handedOffTo: readonly string[],
): string | undefined {
  const claims = handoffClaims(text, members);
  if (!claims.length) return undefined;
  const missing = new Set<string>();
  let unnamed = false;
  for (const claim of claims) {
    if (!claim.memberIds.length) {
      if (!handedOffTo.length) unnamed = true;
      continue;
    }
    for (const id of claim.memberIds) if (!handedOffTo.includes(id)) missing.add(id);
  }
  if (!missing.size && !unnamed) return undefined;
  const names = members.filter((member) => missing.has(member.id)).map((member) => member.name);
  return unverifiedHandoffNote(names);
}

/**
 * The member an "@Name" in a bot's own group reply hands the next stage to: the first exact
 * member mention that is not the bot itself. At most one per reply; "@everyone" never counts.
 */
export function replyMentionTarget<T extends GroupMemberRef>(
  text: string,
  members: readonly T[],
  selfId: string,
): T | undefined {
  return mentionedMembersInOrder(
    text,
    members.filter((member) => member.id !== selfId),
  )[0];
}
