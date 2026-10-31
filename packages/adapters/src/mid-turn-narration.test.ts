import { BOT_MESSAGE_MAX_LENGTH } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { clampMidTurnNarration, MID_TURN_NARRATION_MAX_LENGTH } from "./mid-turn-narration.js";
import { messageUserMaxLength, USER_PROGRESS_MESSAGE_MAX_LENGTH } from "./user-progress.js";

// Narration promoted mid-turn is the model's own reply text (often code); it was cut at 500.
describe("mid-turn narration cap", () => {
  it("keeps a long code block whole", () => {
    const code = `\`\`\`ts\n${"const value = compute(input);\n".repeat(60)}\`\`\``;
    expect(code.length).toBeGreaterThan(USER_PROGRESS_MESSAGE_MAX_LENGTH);
    expect(clampMidTurnNarration(`  ${code}  `)).toBe(code);
  });

  it("is the bot message limit, so a promoted message is never longer than any reply", () => {
    expect(MID_TURN_NARRATION_MAX_LENGTH).toBe(BOT_MESSAGE_MAX_LENGTH);
    const clamped = clampMidTurnNarration("x".repeat(BOT_MESSAGE_MAX_LENGTH + 10));
    expect(clamped).toHaveLength(BOT_MESSAGE_MAX_LENGTH);
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("leaves message_user's own short cap alone", () => {
    expect(messageUserMaxLength()).toBe(USER_PROGRESS_MESSAGE_MAX_LENGTH);
    expect(clampMidTurnNarration("   ")).toBe("");
  });
});
