/** Pasted credential assignments, never a general judgment about the message's meaning. */
export function detectChatPasswordValues(text: string): string[] {
  const values: string[] = [];
  const value = String.raw`(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s，,;；]+))`;
  const assignments = new RegExp(
    String.raw`(?:密码|口令|\b(?:password|passwd|pwd|api[_ -]?key|access[_ -]?token|secret)\b)\s*(?:[：:=]\s*|(?:是|为)\s*|\bis\s+)${value}`,
    "giu",
  );
  const chineseWhitespace = new RegExp(String.raw`(?:密码|口令)[ \t]+(?![：:=是为])${value}`, "gu");
  // English bare assignments need an account label, so "reset my password please" stays prose.
  const pairs = new RegExp(
    String.raw`(?:用户名|账号|帐号|\b(?:username|user|login|account|apple\s+id)\b)\s*(?:[：:=]\s*|(?:是|为)\s*|\bis\s+|[ \t]+)\S+[^\n]*?\b(?:password|passwd|pwd)\s+(?!is\s|[：:=])${value}`,
    "giu",
  );
  for (const pattern of [assignments, chineseWhitespace, pairs]) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1] ?? match[2] ?? match[3];
      if (candidate && !/^\[(?:redacted|hidden)\]$/i.test(candidate)) values.push(candidate);
    }
  }
  if (values.length) {
    const accounts =
      /(?:用户名|账号|帐号|\b(?:username|user|login|account|apple\s+id)\b)\s*(?:[：:=]\s*|(?:是|为)\s*|\bis\s+|[ \t]+)([^\s，,;；]+)/giu;
    for (const match of text.matchAll(accounts)) values.push(match[1]!);
  }
  return [...new Set(values)];
}
