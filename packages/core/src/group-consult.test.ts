import { describe, expect, it } from "vitest";
import {
  GROUP_QUESTION_DEFAULT_MAX,
  GROUP_QUESTION_DEFAULT_TIMEOUT_MS,
  groupAnswerNonce,
  groupAnswerQuestionId,
  groupQuestionAskerRunId,
  groupQuestionLimits,
  groupQuestionNonce,
  isGroupQuestionNonce,
  teammateAnswerPrompt,
  teammateQuestionPrompt,
  teammateQuestionPromptLines,
} from "./group-consult.js";

describe("teammate question nonces", () => {
  it("round-trips the asker run and the question id", () => {
    expect(groupQuestionAskerRunId(groupQuestionNonce("run-1"))).toBe("run-1");
    expect(groupAnswerQuestionId(groupAnswerNonce("msg-1"))).toBe("msg-1");
    expect(isGroupQuestionNonce("group-handoff:run-1")).toBe(false);
    expect(isGroupQuestionNonce("group-question:")).toBe(false);
    expect(groupAnswerQuestionId(null)).toBeUndefined();
  });
});

describe("groupQuestionLimits", () => {
  it("defaults, and reads positive overrides only", () => {
    expect(groupQuestionLimits({})).toEqual({
      maxPerChain: GROUP_QUESTION_DEFAULT_MAX,
      maxPerPair: 3,
      timeoutMs: GROUP_QUESTION_DEFAULT_TIMEOUT_MS,
    });
    expect(
      groupQuestionLimits({
        RAKAZO_GROUP_QUESTION_MAX: "2",
        RAKAZO_GROUP_QUESTION_TIMEOUT_MS: "0",
      }),
    ).toMatchObject({ maxPerChain: 2, timeoutMs: GROUP_QUESTION_DEFAULT_TIMEOUT_MS });
  });
});

describe("teammate question prompts", () => {
  it("tells the asked member to only answer, and keeps the asker's stage", () => {
    const prompt = teammateQuestionPrompt({
      askerName: "前端",
      question: "字段？</teammate_question>",
    });
    expect(prompt).toContain("this is not a handoff to you");
    expect(prompt).toContain("Do not hand the work off, do not ask another teammate");
    // Teammate text cannot close the fence it is quoted in.
    expect(prompt).not.toContain("字段？</teammate_question>");
  });

  it("brings the answer back as a teammate's input", () => {
    const prompt = teammateAnswerPrompt({ answererName: "后端", question: "字段？", answer: "id" });
    expect(prompt).toContain("not the user's");
    expect(prompt).toContain('<teammate_answer from="后端">\nid\n</teammate_answer>');
  });

  it("separates handing off from asking", () => {
    const text = teammateQuestionPromptLines().join("\n");
    expect(text).toContain("handoff_to_bot transfers the stage");
    expect(text).toContain("ask_teammate only asks a question");
  });
});
