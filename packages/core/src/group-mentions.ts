export type GroupMemberRef = {
  id: string;
  name: string;
};

export function memberName(
  members: readonly { botId: string; name: string }[] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId || !members) return undefined;
  return members.find((member) => member.botId === botId)?.name;
}

const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_-]{0,39})/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * CJK text has no spaces around names: "请@团队-前端看下" and "@团队-前端请…" both mention
 * 团队-前端. A CJK character may sit right before the "@" or right after the name; a Latin
 * letter, digit, "_" or "-" may not, so emails and longer Latin names stay apart. With the
 * names tried longest first, "@团队-前端请" picks the longest member name it starts with.
 */
const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
const WORD = String.raw`[\p{L}\p{N}_-]`;
const MENTION_START = `(?<!(?![${CJK}])${WORD})`;
const NAME_END = `(?!(?![${CJK}])${WORD})`;

export function hasMentionToken(text: string, name: string): boolean {
  const normalized = name.trim();
  if (!normalized) return false;
  return new RegExp(`${MENTION_START}@${escapeRegExp(normalized)}${NAME_END}`, "iu").test(text);
}

export function parseMentionNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[1];
    if (name) names.add(name.toLowerCase());
  }
  return [...names];
}

/**
 * Members named by an exact "@Name" in `text`, in the order they first appear. Names are tried
 * longest first, so "@团队-前端" never also counts as "@团队". "@everyone" is not a member.
 */
export function mentionedMembersInOrder<T extends GroupMemberRef>(
  text: string,
  members: readonly T[],
): T[] {
  const named = members.filter((member) => member.name.trim());
  if (!named.length) return [];
  const byName = [...named].sort((a, b) => b.name.trim().length - a.name.trim().length);
  const alternatives = byName.map((member) => escapeRegExp(member.name.trim())).join("|");
  const pattern = new RegExp(`${MENTION_START}@(${alternatives})${NAME_END}`, "giu");
  const found: T[] = [];
  for (const match of text.matchAll(pattern)) {
    const name = match[1]!.toLowerCase();
    const member = byName.find((entry) => entry.name.trim().toLowerCase() === name);
    if (member && !found.includes(member)) found.push(member);
  }
  return found;
}

export function resolveGroupTargetBotIds(input: {
  text: string;
  members: GroupMemberRef[];
  /** Bot ids from typed mention chips (non-members are ignored for wake). */
  explicitMentions?: string[];
}): string[] {
  const membersById = new Map(input.members.map((member) => [member.id, member]));
  const targetIds = new Set<string>();

  for (const mentionId of input.explicitMentions ?? []) {
    // Out-of-chat bots stay as @Name in the prompt; only members are woken here.
    if (membersById.has(mentionId)) targetIds.add(mentionId);
  }

  const names = ["everyone", ...input.members.map((member) => member.name.trim())]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  // Consume each mention once so a full name cannot also wake its prefix.
  const alternatives = names.map(escapeRegExp).join("|");
  const pattern = new RegExp(`${MENTION_START}@(${alternatives})${NAME_END}`, "giu");
  const mentions = [...input.text.matchAll(pattern)].map((match) => match[1]!);
  const isMentioned = (name: string) => {
    const exactName = new RegExp(`^${escapeRegExp(name.trim())}$`, "iu");
    return mentions.some((mention) => exactName.test(mention));
  };

  if (isMentioned("everyone")) {
    for (const member of input.members) targetIds.add(member.id);
  } else {
    for (const member of input.members) {
      if (isMentioned(member.name)) targetIds.add(member.id);
    }
  }

  if (targetIds.size === 0 && input.members[0]) {
    targetIds.add(input.members[0].id);
  }

  return [...targetIds];
}

export function inferHandoffTargetName(prompt: string): string | undefined {
  const handoffMatch =
    /hand(?:\s+this|\s+off|\s+it)?\s+to\s+@?([A-Za-z0-9][A-Za-z0-9_-]{0,39})/i.exec(prompt) ??
    /@([A-Za-z0-9][A-Za-z0-9_-]{0,39})\s+take/i.exec(prompt);
  return handoffMatch?.[1];
}

export function inferHandoffTargetBotId(
  prompt: string,
  members: GroupMemberRef[],
): string | undefined {
  const handedTo = members.find((member) => {
    const escaped = escapeRegExp(member.name.trim());
    return escaped
      ? new RegExp(`\\bto\\s+@?${escaped}(?![\\p{L}\\p{N}_-])`, "iu").test(prompt)
      : false;
  });
  if (handedTo) return handedTo.id;
  const mentioned = members.find((member) => hasMentionToken(prompt, member.name));
  if (mentioned) return mentioned.id;
  const name = inferHandoffTargetName(prompt)?.toLowerCase();
  return name ? members.find((member) => member.name.toLowerCase() === name)?.id : undefined;
}
