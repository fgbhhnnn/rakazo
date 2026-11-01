// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ZH_MESSAGES } from "./locales/zh";
import { ZH_TW_MESSAGES } from "./locales/zh-TW";
import { SavedPasswordSettings } from "./saved-password-settings";

const api = vi.hoisted(() => ({ rpc: vi.fn() }));
const translate = (text: string) => text;
vi.mock("./api", () => ({ rpc: api.rpc }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: translate }) }));
vi.mock("./user-error", () => ({ errorText: () => "Could not save" }));
vi.mock("expo-router", () => ({ useFocusEffect: (fn: () => void) => useEffect(fn, [fn]) }));
vi.mock("../components/settings-group", () => ({
  SettingsSwitch: ({
    label,
    detail,
    value,
    disabled,
    onChange,
  }: {
    label: string;
    detail: string;
    value: boolean;
    disabled: boolean;
    onChange: (value: boolean) => void;
  }) =>
    createElement(
      "button",
      {
        role: "switch",
        type: "button",
        "aria-label": label,
        "aria-checked": value,
        disabled,
        onClick: () => onChange(!value),
      },
      detail,
    ),
  SettingsRow: ({ title }: { title: string }) => createElement("p", { role: "alert" }, title),
}));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.rpc
    .mockReset()
    .mockImplementation(async (_proc, input) => input ?? { allowBotPasswordReveal: false });
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
it("loads account consent, warns and saves using only the account API", async () => {
  await act(async () => root.render(createElement(SavedPasswordSettings)));
  expect(api.rpc).toHaveBeenCalledWith("savedPasswordSettings/get");
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(toggle().textContent).toContain(
    "Passwords go to your model provider and may appear in history.",
  );
  await act(async () => toggle().click());
  expect(api.rpc).toHaveBeenLastCalledWith("savedPasswordSettings/update", {
    allowBotPasswordReveal: true,
  });
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  await act(async () => toggle().click());
  expect(api.rpc).toHaveBeenLastCalledWith("savedPasswordSettings/update", {
    allowBotPasswordReveal: false,
  });
});
it("keeps consent off when a save fails", async () => {
  await act(async () => root.render(createElement(SavedPasswordSettings)));
  api.rpc.mockRejectedValueOnce(new Error("offline"));
  await act(async () => toggle().click());
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not save");
});
it("withholds the control until a successful read", async () => {
  api.rpc.mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(createElement(SavedPasswordSettings)));
  expect(toggle().disabled).toBe(true);
});
it("includes Chinese labels and warnings", () => {
  for (const catalog of [ZH_MESSAGES, ZH_TW_MESSAGES]) {
    expect(catalog["Allow bots to use saved passwords directly"]).toBeTruthy();
    expect(
      catalog[
        "Passwords go to your model provider and may appear in history. Enable only if needed."
      ],
    ).toBeTruthy();
  }
});
