import { describe, expect, it } from "vitest";
import { answerableAskMessageIds } from "./answerable-ask.js";
import { isOpenComputerRestartPrompt } from "./computer-restart-prompt.js";
import { askAnswerRunId, workerApprovalClosedState } from "./worker-approval-mirror.js";

const card = {
  kind: "ask",
  text: "电脑连续 3 次没有响应，要重启吗？",
  status: "pending",
  actions: [
    { id: "restart", label: "重启电脑" },
    { id: "keep", label: "先不重启" },
  ],
  computerRestart: { computerId: "computer-1", botId: "bot-1" },
};

describe("computer restart card", () => {
  it("is open until answered or closed", () => {
    expect(isOpenComputerRestartPrompt(card)).toBe(true);
    expect(isOpenComputerRestartPrompt({ ...card, status: "answered" })).toBe(false);
    for (const closed of ["expired", "recovered"])
      expect(
        isOpenComputerRestartPrompt({
          ...card,
          computerRestart: { ...card.computerRestart, closed },
        }),
      ).toBe(false);
    expect(isOpenComputerRestartPrompt({ kind: "ask", status: "pending" })).toBe(false);
  });

  it("is answerable without a run, and its answer names the computer", () => {
    const messages = [{ id: "card", runId: null, blocks: [card] }];
    expect([...answerableAskMessageIds({ messages, run: null })]).toEqual(["card"]);
    expect(askAnswerRunId(messages[0]!)).toBe("computer-1");
    expect(
      answerableAskMessageIds({
        messages: [{ id: "card", runId: null, blocks: [{ ...card, status: "answered" }] }],
      }).size,
    ).toBe(0);
    // Not a worker card: no "cancelled" label for it.
    expect(workerApprovalClosedState(card)).toBeUndefined();
  });
});
