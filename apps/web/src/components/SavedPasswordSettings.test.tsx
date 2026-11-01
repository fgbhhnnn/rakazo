// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SavedPasswordSettings } from "./SavedPasswordSettings";

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { savedPasswordSettings: api } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (text: TemplateStringsArray) => text.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/user-error", () => ({ errorText: () => "Could not save" }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.get.mockReset().mockResolvedValue({ allowBotPasswordReveal: false });
  api.update.mockReset().mockImplementation(async (input) => input);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]')!;
async function render() {
  await act(async () => root.render(<SavedPasswordSettings />));
  await act(async () =>
    container.querySelector<HTMLButtonElement>("[data-slot=collapsible-trigger]")!.click(),
  );
}

it("loads the default, warns before enabling, and saves account consent in both directions", async () => {
  await render();
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(container.textContent).toContain(
    "Passwords go to your model provider and may appear in history. Enable only if needed.",
  );
  expect(toggle().getAttribute("aria-describedby")).toBeTruthy();
  await act(async () => toggle().click());
  expect(api.update).toHaveBeenLastCalledWith({ allowBotPasswordReveal: true });
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  await act(async () => toggle().click());
  expect(api.update).toHaveBeenLastCalledWith({ allowBotPasswordReveal: false });
});
it("keeps the saved value on failure and prevents concurrent saves", async () => {
  await render();
  let reject!: (cause: Error) => void;
  api.update.mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  await act(async () => {
    toggle().click();
    toggle().click();
  });
  expect(api.update).toHaveBeenCalledTimes(1);
  expect(toggle().getAttribute("aria-disabled")).toBe("true");
  await act(async () => reject(new Error("fake-failure")));
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not save");
});
it("disables the switch when consent cannot be read", async () => {
  api.get.mockRejectedValueOnce(new Error("offline"));
  await render();
  expect(toggle().getAttribute("aria-disabled")).toBe("true");
  expect(api.update).not.toHaveBeenCalled();
});
