import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { detectChatPasswordValues } from "./chat-password-detection.js";
import {
  CHAT_PASSWORD_HYGIENE_NOTE,
  chatPasswordRunRedactions,
  chatPasswordTurnNote,
  protectChatPasswordTurn,
  protectSteeringPasswords,
} from "./chat-password-hygiene.js";

const examples = [
  ["密码是 Abc12345!", ["Abc12345!"]],
  ["账号 foo@bar.com 密码 xxxx", ["xxxx", "foo@bar.com"]],
  ["apple id xxx 密码 yyy", ["yyy", "xxx"]],
  ["密码 为 Fake123!", ["Fake123!"]],
  ["密码 ： Fake123!", ["Fake123!"]],
  ['密码是 "fake value with spaces"', ["fake value with spaces"]],
  ["My password is Fake123!", ["Fake123!"]],
  ["Account demo@example.test password fake-pass", ["fake-pass", "demo@example.test"]],
  ["Apple ID demo@example.test password is Fake123!", ["Fake123!", "demo@example.test"]],
  ["username=demo password fake-pass", ["fake-pass", "demo"]],
  ["API key is fake-key", ["fake-key"]],
] as const;

describe("conversational credential assignments", () => {
  it.each(examples)(
    "protects the assignment and every affected model input (%#)",
    (text, expected) => {
      expect(detectChatPasswordValues(text)).toEqual(expected);
      const blocks: MessageBlock[] = [{ kind: "text", text }];
      expect(chatPasswordTurnNote(text)).toBe(CHAT_PASSWORD_HYGIENE_NOTE);
      expect(chatPasswordTurnNote("", blocks)).toBe(CHAT_PASSWORD_HYGIENE_NOTE);
      const values = chatPasswordRunRedactions("Continue", [
        { id: "m", threadId: "t", role: "user", blocks },
      ]);
      expect(values).toEqual(expected);
      const protectedTurn = protectChatPasswordTurn(
        text,
        [{ role: "user", content: text }],
        text,
        values,
      );
      const register = vi.fn();
      const steering = protectSteeringPasswords(
        [{ id: "steering", messageId: "m", text, historyText: text }],
        register,
      );
      expect(register).toHaveBeenCalledWith(expected);
      expect(steering[0]?.text).toContain(CHAT_PASSWORD_HYGIENE_NOTE);
      for (const value of expected) {
        expect(JSON.stringify(protectedTurn)).not.toContain(value);
        expect(JSON.stringify(steering)).not.toContain(value);
        expect(CHAT_PASSWORD_HYGIENE_NOTE).not.toContain(value);
      }
    },
  );

  it.each([
    "Please reset my password",
    "I forgot my password please help",
    "密码忘了",
    "如何修改密码？",
    "Password=[redacted]",
    "密码是 [hidden]",
    "apple id xxx",
    "notapassword=ordinary",
  ])("leaves ordinary requests and protected placeholders alone (%#)", (text) => {
    expect(detectChatPasswordValues(text)).toEqual([]);
    expect(chatPasswordTurnNote(text)).toBeUndefined();
  });

  it("registers corrections independently without mutating stored messages", () => {
    const text = "账号 demo 密码 first-fake\n密码是 second-fake";
    expect(new Set(detectChatPasswordValues(text))).toEqual(
      new Set(["first-fake", "second-fake", "demo"]),
    );
    expect(text).toContain("first-fake");
  });
});
