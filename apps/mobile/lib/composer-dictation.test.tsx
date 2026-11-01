// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerDictateButton } from "../components/composer-dictate-button";
import * as dictation from "./dictation";
import { resetI18nForTests } from "./i18n";

vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: object) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("expo-localization", () => ({ getLocales: () => [{ languageTag: "en-US" }] }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    accessibilityLabel: string;
    onPress: () => void;
    disabled?: boolean;
  }) =>
    createElement("button", {
      type: "button",
      "aria-label": accessibilityLabel,
      onClick: onPress,
      disabled,
    }),
}));
vi.mock("./dictation", () => ({ available: vi.fn(), listen: vi.fn() }));

describe("mobile composer dictation", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let options: Parameters<typeof dictation.listen>[0];
  const onText = vi.fn();
  async function render(props: Partial<ComponentProps<typeof ComposerDictateButton>> = {}) {
    await act(async () => root.render(<ComposerDictateButton onText={onText} {...props} />));
  }
  async function click(label: string) {
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click(),
    );
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    resetI18nForTests("en");
    vi.mocked(dictation.available).mockResolvedValue(true);
    vi.mocked(dictation.listen).mockImplementation(async (opts) => {
      options = opts;
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("hides when device dictation is unavailable", async () => {
    vi.mocked(dictation.available).mockResolvedValue(false);
    await render();
    expect(container.querySelector("button")).toBeNull();
  });

  it("previews interim text and inserts it once on manual stop", async () => {
    await render();
    await click("Dictate");
    act(() => options.onInterim?.("你好"));
    expect(container.textContent).toBe("你好");
    expect(onText).not.toHaveBeenCalled();
    await click("Stop dictation");
    expect(options.signal?.aborted).toBe(true);
    expect(onText).toHaveBeenCalledExactlyOnceWith("你好");
    act(() => options.onFinal("late duplicate"));
    expect(onText).toHaveBeenCalledOnce();
  });

  it("inserts the final text on automatic endpoint", async () => {
    await render();
    await click("Dictate");
    act(() => options.onFinal("review this"));
    expect(onText).toHaveBeenCalledExactlyOnceWith("review this");
    expect(container.querySelector('[aria-label="Dictate"]')).not.toBeNull();
  });

  it("uses zh-CN and translated controls for Chinese UI", async () => {
    resetI18nForTests("zh-CN");
    await render();
    await click("语音输入");
    expect(options.lang).toBe("zh-CN");
    expect(container.querySelector('[aria-label="停止语音输入"]')).not.toBeNull();
  });

  it.each(["idle", "failed"] as const)("reports %s and allows retry", async (reason) => {
    await render();
    await click("Dictate");
    act(() => options.onGiveUp?.(reason));
    expect(container.textContent).toContain(reason === "idle" ? "Nothing heard" : "permissions");
    expect(onText).not.toHaveBeenCalled();
    await click("Dictate");
    expect(container.textContent).toBe("Listening…");
  });

  it("reports start failures", async () => {
    vi.mocked(dictation.listen).mockRejectedValue(new Error("unavailable"));
    await render();
    await click("Dictate");
    expect(container.textContent).toContain("permissions");
    expect(onText).not.toHaveBeenCalled();
  });

  it.each(["disabled", "unmount"])("aborts on %s and ignores late callbacks", async (reason) => {
    await render();
    await click("Dictate");
    if (reason === "disabled") await render({ disabled: true });
    else act(() => root.render(null));
    expect(options.signal?.aborted).toBe(true);
    act(() => {
      options.onInterim?.("late");
      options.onFinal("late");
      options.onGiveUp?.("failed");
    });
    expect(onText).not.toHaveBeenCalled();
  });
});
