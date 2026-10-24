import { describe, expect, it } from "vitest";
import { answerableAskMessageIds } from "./answerable-ask.js";
import {
  askAnswerRunId,
  isOpenWorkerApprovalMirror,
  workerApprovalClosedState,
} from "./worker-approval-mirror.js";

const mirror = {
  kind: "ask",
  approvalEffectId: "effect1",
  status: "pending",
  workerApproval: { runId: "worker-run", messageId: "worker-message", label: "任务 #A7（抓）" },
};

describe("worker approval mirror", () => {
  it("is open until answered or closed", () => {
    expect(isOpenWorkerApprovalMirror(mirror)).toBe(true);
    expect(isOpenWorkerApprovalMirror({ ...mirror, status: "answered" })).toBe(false);
    for (const closed of ["cancelled", "expired"]) {
      expect(
        isOpenWorkerApprovalMirror({
          ...mirror,
          workerApproval: { ...mirror.workerApproval, closed },
        }),
      ).toBe(false);
    }
    expect(isOpenWorkerApprovalMirror({ kind: "ask", status: "pending" })).toBe(false);
    expect(isOpenWorkerApprovalMirror({ ...mirror, kind: "text" })).toBe(false);
  });

  it("names why a closed copy can no longer be answered", () => {
    expect(workerApprovalClosedState(mirror)).toBeUndefined();
    expect(
      workerApprovalClosedState({
        ...mirror,
        workerApproval: { ...mirror.workerApproval, closed: "cancelled" },
      }),
    ).toBe("cancelled");
    expect(
      workerApprovalClosedState({
        ...mirror,
        workerApproval: { ...mirror.workerApproval, closed: "expired" },
      }),
    ).toBe("expired");
    // An answer always wins over a later close.
    expect(
      workerApprovalClosedState({
        ...mirror,
        status: "answered",
        workerApproval: { ...mirror.workerApproval, closed: "cancelled" },
      }),
    ).toBeUndefined();
    expect(workerApprovalClosedState({ kind: "ask", status: "pending" })).toBeUndefined();
  });

  it("answers a copy through the worker's run and anything else through its own", () => {
    expect(askAnswerRunId({ runId: null, blocks: [{ kind: "text" }, mirror] })).toBe("worker-run");
    expect(askAnswerRunId({ runId: "own", blocks: [{ kind: "ask", status: "pending" }] })).toBe(
      "own",
    );
    expect(askAnswerRunId({ blocks: [{ kind: "ask" }] })).toBeUndefined();
  });

  it("makes an open copy answerable in the main chat although no run there waits", () => {
    const snapshot = {
      run: { id: "main-run", status: "completed" },
      messages: [
        { id: "open", runId: null, blocks: [mirror] },
        { id: "answered", runId: null, blocks: [{ ...mirror, status: "answered" }] },
        {
          id: "closed",
          runId: null,
          blocks: [{ ...mirror, workerApproval: { ...mirror.workerApproval, closed: "expired" } }],
        },
        { id: "plain", runId: "main-run", blocks: [{ kind: "ask", status: "pending" }] },
      ],
    };
    expect([...answerableAskMessageIds(snapshot)]).toEqual(["open"]);
  });
});
