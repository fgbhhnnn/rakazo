// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { askAnswerRunId } from "@rakazo/core";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Text: (props: { children?: ReactNode; testID?: string }) =>
    createElement("span", { "data-testid": props.testID }, props.children),
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({ mutedForeground: "muted" }) }));

import { inactiveAskText, WorkerApprovalLabel } from "../components/worker-approval-label";

// Keep Vitest's jsdom URL transform from replacing the file URL with self.location.
const testFileUrl = import.meta.url;

const mirror = {
  kind: "ask" as const,
  approvalEffectId: "effect1",
  text: "Review before web_fetch → example.com",
  status: "pending" as const,
  actions: [
    { id: "allow", label: "Allow once" },
    { id: "deny", label: "Deny" },
  ],
  workerApproval: { runId: "worker-run", messageId: "worker-message", label: "任务 #A7（抓报表）" },
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("names the task whose approval the main-chat card answers", async () => {
  await act(async () => root.render(<WorkerApprovalLabel block={mirror} />));
  const label = container.querySelector('[data-testid="worker-approval-label"]');
  expect(label?.textContent).toBe("任务 #A7（抓报表）");

  const { workerApproval: _, ...plain } = mirror;
  await act(async () => root.render(<WorkerApprovalLabel block={plain} />));
  expect(container.textContent).toBe("");
});

it("says a cancelled worker's copy was cancelled and any other closed card is no longer active", () => {
  expect(
    inactiveAskText({
      ...mirror,
      workerApproval: { ...mirror.workerApproval, closed: "cancelled" },
    }),
  ).toBe("Cancelled");
  expect(
    inactiveAskText({ ...mirror, workerApproval: { ...mirror.workerApproval, closed: "expired" } }),
  ).toBe("No longer active");
  expect(inactiveAskText({ kind: "ask", text: "Allow?", status: "pending" })).toBe(
    "No longer active",
  );
});

it("answers the copy through the screen's handler with the worker's run", async () => {
  const source = readFileSync(new URL("../app/thread.tsx", testFileUrl), "utf8");
  const handler = source.slice(
    source.indexOf("  const answerMessage = useCallback("),
    source.indexOf("  const openBot = useCallback("),
  );
  const rpc = vi.fn().mockResolvedValue(undefined);
  const refresh = vi.fn().mockResolvedValue(undefined);
  const scope = {
    useCallback: <T,>(callback: T) => callback,
    botId: "main-bot",
    groupId: undefined,
    readOnly: false,
    rpc,
    isCurrentTarget: () => true,
    refresh,
    askAnswerRunId,
  };
  const answerMessage = new Function(
    ...Object.keys(scope),
    ts.transpileModule(`${handler}\nreturn answerMessage;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )(...Object.values(scope));

  await answerMessage({ id: "mirror-message", runId: null, blocks: [mirror] }, "allow");
  expect(rpc).toHaveBeenCalledWith("threads/answer", {
    botId: "main-bot",
    runId: "worker-run",
    messageId: "mirror-message",
    answer: "allow",
  });

  // A card of this chat's own run still answers that run; one without a run sends nothing.
  await answerMessage(
    { id: "own", runId: "own-run", blocks: [{ kind: "ask", status: "pending" }] },
    "deny",
  );
  expect(rpc).toHaveBeenLastCalledWith("threads/answer", {
    botId: "main-bot",
    runId: "own-run",
    messageId: "own",
    answer: "deny",
  });
  await answerMessage({ id: "none", runId: null, blocks: [{ kind: "text", text: "x" }] }, "x");
  expect(rpc).toHaveBeenCalledTimes(2);

  // A computer restart card has no run; it answers with the computer it is about.
  await answerMessage(
    {
      id: "restart-card",
      runId: null,
      blocks: [
        {
          kind: "ask",
          status: "pending",
          computerRestart: { computerId: "computer1", botId: "main-bot" },
        },
      ],
    },
    "restart",
  );
  expect(rpc).toHaveBeenLastCalledWith("threads/answer", {
    botId: "main-bot",
    runId: "computer1",
    messageId: "restart-card",
    answer: "restart",
  });
});

it("shows a closed computer restart card as no longer active", () => {
  expect(
    inactiveAskText({
      kind: "ask",
      text: "电脑连续 3 次没有响应，要重启吗？",
      status: "pending",
      computerRestart: { computerId: "computer1", botId: "main-bot", closed: "recovered" },
    }),
  ).toBe("No longer active");
});
