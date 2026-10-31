// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./api", () => ({ rpc: state.rpc }));
vi.mock("./query", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));

const { withMemberSettingsGuard } = await import("./member-settings-guard");
const { queryClient } = await import("./query");

const Guarded = withMemberSettingsGuard(() => createElement("p", null, "settings screen"));
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  queryClient.clear();
  state.rpc.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount() {
  await act(async () => root.render(createElement(Guarded)));
}

it("hides the screen from a locked member and shows the administrator note", async () => {
  state.rpc.mockResolvedValue({ memberSettingsLocked: true });
  await mount();
  expect(state.rpc).toHaveBeenCalledWith("me");
  expect(container.textContent).toBe("Your administrator manages this setting.");
});

it("shows the screen when the member is not locked", async () => {
  state.rpc.mockResolvedValue({ memberSettingsLocked: false });
  await mount();
  expect(container.textContent).toBe("settings screen");
});

it("shows nothing until the first answer, then decides a revisit from the last one", async () => {
  let answer!: (me: { memberSettingsLocked: boolean }) => void;
  state.rpc.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  await mount();
  expect(container.textContent).toBe("");
  await act(async () => answer({ memberSettingsLocked: true }));
  expect(container.textContent).toBe("Your administrator manages this setting.");

  act(() => root.unmount());
  root = createRoot(container);
  state.rpc.mockReturnValue(new Promise(() => undefined));
  await mount();
  expect(container.textContent).toBe("Your administrator manages this setting.");
});

it("forgets the last answer once the query cache is cleared at sign-out", async () => {
  state.rpc.mockResolvedValue({ memberSettingsLocked: true });
  await mount();
  act(() => root.unmount());
  queryClient.clear();
  root = createRoot(container);
  state.rpc.mockReturnValue(new Promise(() => undefined));
  await mount();
  expect(container.textContent).toBe("");
});
