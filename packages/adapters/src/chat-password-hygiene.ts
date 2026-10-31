import type { AgentRunRequest, AgentSteeringMessage } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { messageToAgentHistoryText } from "./reply-context.js";

/** Internal redaction values only: never log or return these from a tool. */
export function chatPasswordRedactions(text: string): string[] {
  const values: string[] = [];
  const assignments =
    /(?:密码|口令|password|passwd|pwd|api[_ -]?key|access[_ -]?token|secret)\s*[：:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s，,;；]+))/giu;
  const pairs =
    /(?:用户名|账号|帐号|username|user|login)\s*[：:=]\s*\S+[^\n]*?(?:密码|password|passwd|pwd)\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s，,;；]+))/giu;
  for (const pattern of [assignments, pairs]) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[2] ?? match[3];
      if (value && !/^\[(?:redacted|hidden)\]$/i.test(value)) values.push(value);
    }
  }
  if (values.length) {
    for (const match of text.matchAll(
      /(?:用户名|账号|帐号|username|user|login)\s*[：:=]\s*([^\s，,;；]+)/giu,
    ))
      values.push(match[1]!);
  }
  return [...new Set(values)];
}

/** No matched value is ever included in the instruction. */
export function chatPasswordHygieneNote(text: string): string | undefined {
  return chatPasswordRedactions(text).length ? CHAT_PASSWORD_HYGIENE_NOTE : undefined;
}

export const CHAT_PASSWORD_HYGIENE_NOTE =
  "A user message in this turn appears to contain a pasted password or credential. Briefly tell the user to delete or redact that message and change the exposed password/key, then save it using a secure credential card. Do not quote, repeat, test, or copy the pasted value into tools, worker messages or your reply. Use one card for the login, respecting existing and dismissed cards. Do not claim you can redact/delete a message: this app has no individual-message redaction tool. Continue handling the user's request.";

/** Steering is another user message in the current turn, after its initial prompt was built. */
export function protectSteeringPasswords(
  messages: AgentSteeringMessage[],
  registerRedactions: (values: string[]) => void,
): AgentSteeringMessage[] {
  return messages.map((message) => {
    const values = chatPasswordRedactions(message.text);
    if (!values.length) return message;
    registerRedactions(values);
    return {
      ...message,
      historyText: message.historyText
        ? redactSecrets(message.historyText, values)
        : message.historyText,
      text: `${redactSecrets(message.text, values)}\n\n${CHAT_PASSWORD_HYGIENE_NOTE}`,
    };
  });
}

export function chatPasswordRunRedactions(
  prompt: string,
  messages: readonly Parameters<typeof messageToAgentHistoryText>[0][],
): string[] {
  return chatPasswordRedactions(
    [
      prompt,
      ...messages.filter((message) => message.role === "user").map(messageToAgentHistoryText),
    ].join("\n"),
  );
}

export function chatPasswordTurnNote(prompt: string, blocks: readonly MessageBlock[] = []) {
  return chatPasswordHygieneNote(
    [prompt, ...blocks.flatMap((block) => (block.kind === "text" ? [block.text] : []))].join("\n"),
  );
}

export function protectChatPasswordTurn(
  prompt: string,
  history: AgentRunRequest["history"],
  resumeText: string,
  redactions: string[],
) {
  return {
    prompt: redactSecrets(prompt, redactions),
    history: history.map((item) => ({ ...item, content: redactSecrets(item.content, redactions) })),
    resumeToolResult: {
      content: [{ type: "text" as const, text: redactSecrets(resumeText, redactions) }],
    },
  };
}
