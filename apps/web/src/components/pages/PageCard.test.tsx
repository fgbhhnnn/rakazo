// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { pages: { get: mocks.get, update: vi.fn() } } }));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return {
    useLingui: () => ({ t, i18n: { date: (value: string) => value } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: string }) => <div data-markdown>{children}</div>,
}));

import { PageCard } from "./PageCard";

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.get.mockReset().mockResolvedValue({
    id: "page-1",
    artifactId: "artifact-1",
    botId: "bot-1",
    groupId: null,
    title: "Weekly report",
    snippet: "Revenue grew.",
    version: 1,
    createdAt: "2026-10-25T10:00:00.000Z",
    updatedAt: "2026-10-25T10:00:00.000Z",
    markdown: "Revenue grew.",
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows the title and snippet, and opens the page only when tapped", async () => {
  await act(async () =>
    root?.render(<PageCard pageId="page-1" title="Weekly report" snippet="Revenue grew." />),
  );
  const card = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Open page Weekly report"]',
  );
  expect(card?.textContent).toBe("Weekly reportRevenue grew.");
  expect(mocks.get).not.toHaveBeenCalled();

  await act(async () => card?.click());
  expect(mocks.get).toHaveBeenCalledWith({ pageId: "page-1" });
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.querySelector("h1")?.textContent).toBe("Weekly report");
  expect(dialog?.querySelector('button[aria-label="Close page"]')).not.toBeNull();
});
