import { describe, expect, it, vi } from "vitest";
import {
  CHAT_PASSWORD_HYGIENE_NOTE,
  chatPasswordHygieneNote,
  chatPasswordRedactions,
  protectSteeringPasswords,
} from "./chat-password-hygiene.js";

describe("chat password hygiene", () => {
  it.each([
    ["密码: fake-value", "fake-value"],
    ["password=fake-value", "fake-value"],
    ["用户名: demo 密码: fake-value", "fake-value"],
    ["username=demo password fake-value", "fake-value"],
    ["账号: demo\n密码：fake-value", "fake-value"],
    ['password="fake value with spaces"', "fake value with spaces"],
    ["api_key='fake-key'", "fake-key"],
  ])("warns without copying the value (%#)", (text, value) => {
    const note = chatPasswordHygieneNote(text);
    expect(note).toBe(CHAT_PASSWORD_HYGIENE_NOTE);
    expect(note).not.toContain(value);
    expect(chatPasswordRedactions(text)).toContain(value);
  });

  it.each(["Please reset my password", "密码忘了", "Use the secure card", "password=[redacted]"])(
    "does not flag a message without an assignment (%#)",
    (text) => {
      expect(chatPasswordHygieneNote(text)).toBeUndefined();
    },
  );

  it("redacts every correction and username in a turn", () => {
    expect(chatPasswordRedactions("username=demo password=fake-old\n密码：fake-new")).toEqual([
      "fake-old",
      "fake-new",
      "demo",
    ]);
  });

  it("keeps steering deliverable and its metadata while redacting history and adding the warning", () => {
    const register = vi.fn();
    const messages = [
      {
        id: "steering",
        messageId: "message",
        origin: "user" as const,
        text: "Upload the file; password=fake-value",
        historyText: "password=fake-value",
      },
    ];
    const [protectedMessage] = protectSteeringPasswords(messages, register);
    expect(register).toHaveBeenCalledWith(["fake-value"]);
    expect(protectedMessage).toMatchObject({
      id: "steering",
      messageId: "message",
      origin: "user",
    });
    expect(protectedMessage?.text).toContain("Upload the file");
    expect(protectedMessage?.text).toContain(CHAT_PASSWORD_HYGIENE_NOTE);
    expect(JSON.stringify(protectedMessage)).not.toContain("fake-value");
    expect(messages[0]?.text).toContain("fake-value"); // Stored input is left intact.
  });

  it("leaves ordinary steering alone", () => {
    const register = vi.fn();
    const message = { id: "steering", messageId: "message", text: "Upload the file" };
    expect(protectSteeringPasswords([message], register)).toEqual([message]);
    expect(register).not.toHaveBeenCalled();
  });
});
