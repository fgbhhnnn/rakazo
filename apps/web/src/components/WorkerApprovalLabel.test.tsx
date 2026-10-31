// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../lib/rpc", () => ({ rpc: {} }));

import type { AskBlock } from "./AskCard";
import { AskCard } from "./AskCard";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const mirror: AskBlock = {
  kind: "ask",
  approvalEffectId: "effect1",
  text: "Review before web_fetch → example.com",
  detail: "url: https://example.com/report",
  site: "example.com",
  status: "pending",
  actions: [
    { id: "allow", label: "Allow once" },
    { id: "always", label: "Always allow example.com" },
    { id: "deny", label: "Deny" },
  ],
  workerApproval: { runId: "worker-run", messageId: "worker-message", label: "任务 #A7（抓报表）" },
};

async function render(block: AskBlock, canAnswer: boolean, onAnswer = vi.fn(async () => {})) {
  await act(async () =>
    root.render(
      <AskCard
        block={block}
        canAnswer={canAnswer}
        canDismiss={false}
        onAnswer={onAnswer}
        onDismiss={async () => {}}
      />,
    ),
  );
  return onAnswer;
}

const buttons = () => [...container.querySelectorAll("button")].map((item) => item.textContent);
const label = () => container.querySelector('[data-testid="worker-approval-label"]')?.textContent;

it("shows which task asks and answers with the worker card's own controls", async () => {
  const onAnswer = await render(mirror, true);
  expect(label()).toBe("任务 #A7（抓报表）");
  expect(container.textContent).toContain("Review before web_fetch → example.com");
  expect(buttons()).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Allow"),
      expect.stringContaining("Always"),
      expect.stringContaining("Deny"),
    ]),
  );
  const allow = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.startsWith("Allow") && !item.textContent.includes("Always"),
  )!;
  await act(async () => allow.click());
  expect(onAnswer).toHaveBeenCalledWith("allow", undefined);
  expect(onAnswer).toHaveBeenCalledTimes(1);
});

it("shows a cancelled worker's copy as cancelled, without controls", async () => {
  await render(
    { ...mirror, workerApproval: { ...mirror.workerApproval!, closed: "cancelled" } },
    false,
  );
  expect(label()).toBe("任务 #A7（抓报表）");
  expect(container.textContent).toContain("Cancelled");
  expect(buttons()).toEqual([]);
});

it("shows an ended worker's copy as no longer active", async () => {
  await render(
    { ...mirror, workerApproval: { ...mirror.workerApproval!, closed: "expired" } },
    false,
  );
  expect(container.textContent).toContain("No longer active");
  expect(container.textContent).not.toContain("Cancelled");
  expect(buttons()).toEqual([]);
});

it("shows the answer once either chat answered it", async () => {
  await render({ ...mirror, status: "answered", answer: "deny" }, false);
  expect(container.textContent).not.toContain("No longer active");
  expect(buttons()).toEqual([]);
});

it("adds nothing to an ordinary approval card", async () => {
  const { workerApproval: _, ...plain } = mirror;
  await render(plain, true);
  expect(label()).toBeUndefined();
});
