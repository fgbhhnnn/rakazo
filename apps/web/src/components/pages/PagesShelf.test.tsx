// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { pages: { list: mocks.list } } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./PageCard", () => ({
  PageCard: ({ title, snippet }: { title: string; snippet?: string }) => (
    <button type="button">
      {title}|{snippet}
    </button>
  ),
}));

import { PagesShelf } from "./PagesShelf";

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.list.mockReset();
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

async function render(botId?: string) {
  root = createRoot(container);
  await act(async () => root?.render(<PagesShelf botId={botId} />));
}

it("lists the selected bot's pages as cards", async () => {
  mocks.list.mockResolvedValue([
    { id: "page-1", title: "Weekly report", snippet: "Revenue grew." },
    { id: "page-2", title: "Launch plan", snippet: "Ship Friday." },
  ]);
  await render("bot-1");
  expect(mocks.list).toHaveBeenCalledWith({ botId: "bot-1", limit: 30 });
  expect(container.querySelector("h2")?.textContent).toBe("Pages");
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "Weekly report|Revenue grew.",
    "Launch plan|Ship Friday.",
  ]);
});

it("renders nothing when there are no pages or they fail to load", async () => {
  mocks.list.mockResolvedValue([]);
  await render("bot-1");
  expect(container.innerHTML).toBe("");
  act(() => root?.unmount());
  mocks.list.mockRejectedValue(new Error("offline"));
  await render("bot-1");
  expect(container.innerHTML).toBe("");
});
