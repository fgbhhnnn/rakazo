// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), writeText: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { pages: { get: mocks.get, update: mocks.update } } }));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return {
    useLingui: () => ({ t, i18n: { date: (value: string) => `date:${value}` } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: string }) => <div data-markdown>{children}</div>,
}));

import { PageReader } from "./PageReader";

const PAGE = {
  id: "page-1",
  artifactId: "artifact-2",
  botId: "bot-1",
  groupId: null,
  title: "Launch plan",
  snippet: "Why now.",
  version: 2,
  createdAt: "2026-10-25T10:00:00.000Z",
  updatedAt: "2026-10-25T11:00:00.000Z",
  markdown: "# Launch plan\n\nWhy now.\n\n## Goals\n\nShip it.\n\n## Timeline\n\nQ4.",
};

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.get.mockReset().mockResolvedValue(PAGE);
  mocks.update.mockReset();
  mocks.writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.writeText },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderReader(onClose = vi.fn()) {
  await act(async () => root?.render(<PageReader pageId="page-1" onClose={onClose} />));
  return onClose;
}

function button(label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

async function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("shows the title once, anchored sections, and an On this page list that jumps", async () => {
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  await renderReader();

  expect(mocks.get).toHaveBeenCalledWith({ pageId: "page-1" });
  expect(container.querySelector("h1")?.textContent).toBe("Launch plan");
  const markdown = [...container.querySelectorAll("[data-markdown]")].map(
    (node) => node.textContent,
  );
  expect(markdown).toEqual(["Why now.", "## Goals\n\nShip it.", "## Timeline\n\nQ4."]);
  expect(container.querySelector("section#page-goals")).not.toBeNull();

  const nav = container.querySelector('nav[aria-label="On this page"]');
  const links = [...(nav?.querySelectorAll("a") ?? [])];
  expect(links.map((link) => link.textContent)).toEqual(["Goals", "Timeline"]);
  await act(async () => links[1]?.click());
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(scroll.mock.contexts[0]).toBe(container.querySelector("#page-timeline"));
  expect(links[1]?.getAttribute("aria-current")).toBe("location");
});

it("copies the signed-in page link and closes", async () => {
  const onClose = await renderReader();
  await act(async () => button("Copy link")?.click());
  expect(mocks.writeText).toHaveBeenCalledWith(`${window.location.origin}/app/pages/page-1`);
  expect(button("Link copied")).not.toBeNull();

  await act(async () => button("Close page")?.click());
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("saves an inline edit as the next version from the version it started on", async () => {
  await renderReader();
  await act(async () => button("Edit page")?.click());
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  expect(textarea?.value).toBe(PAGE.markdown);

  const markdown = `${PAGE.markdown}\n\n## Owners\n\nAda.`;
  mocks.update.mockResolvedValue({ ...PAGE, version: 3, markdown });
  await typeInto(textarea!, markdown);
  const save = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Save",
  );
  await act(async () => save?.click());

  expect(mocks.update).toHaveBeenCalledWith({ pageId: "page-1", markdown, baseVersion: 2 });
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.querySelector("section#page-owners")?.textContent).toContain("Ada.");
});

it("keeps the draft and explains when the page changed underneath the edit", async () => {
  await renderReader();
  await act(async () => button("Edit page")?.click());
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  await typeInto(textarea!, "# Launch plan\n\nRewritten.");
  mocks.update.mockRejectedValue(Object.assign(new Error("stale"), { code: "CONFLICT" }));
  const save = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Save",
  );
  await act(async () => save?.click());

  expect(container.querySelector("textarea")?.value).toBe("# Launch plan\n\nRewritten.");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "This page changed since you opened it.",
  );
});

it("does not save an empty page", async () => {
  await renderReader();
  await act(async () => button("Edit page")?.click());
  await typeInto(container.querySelector<HTMLTextAreaElement>("textarea")!, "   ");
  const save = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Save",
  );
  await act(async () => save?.click());
  expect(mocks.update).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("A page can't be empty.");
});

it("says so when the page cannot be opened", async () => {
  mocks.get.mockRejectedValue(new Error("Not found"));
  await renderReader();
  expect(container.textContent).toContain("Not found");
});
