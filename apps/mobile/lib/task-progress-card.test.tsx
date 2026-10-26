// @vitest-environment jsdom
import type { TaskProgressBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CHAT_CARD_RADIUS } from "./chat-card-shell";
import { ZH_MESSAGES } from "./locales/zh";
import { threadCardWidth } from "./message-presentation";

declare global {
  interface Window {
    rn: { dimensions: { width: number; height: number } };
  }
}
window.rn = { dimensions: { width: 393, height: 852 } };

vi.mock("react-native", () => {
  type Props = {
    children?: ReactNode;
    testID?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    disabled?: boolean;
    onPress?: () => void;
    onLongPress?: () => void;
    style?: unknown;
  };
  return {
    ActivityIndicator: () => createElement("rn-spinner"),
    Pressable: ({
      children,
      onPress,
      testID,
      accessibilityLabel,
      accessibilityRole,
      disabled,
      onLongPress,
      style,
    }: Props) =>
      createElement(
        "rn-pressable",
        {
          "data-testid": testID,
          onClick: disabled ? undefined : onPress,
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          onContextMenu: onLongPress,
          // Exposes a tap handler or pressed-state feedback, which a view-only row must not have.
          "data-tappable": onPress && !disabled ? "true" : undefined,
          "data-press-feedback": typeof style === "function" ? "true" : undefined,
        },
        children,
      ),
    Text: ({ children }: Props) => createElement("rn-text", null, children),
    View: ({ children, testID, style }: Props) =>
      createElement(
        "rn-view",
        { "data-testid": testID, "data-style": testID ? JSON.stringify(style) : undefined },
        children,
      ),
    useWindowDimensions: () => window.rn.dimensions,
  };
});
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios, android }: { ios: string; android: string }) =>
    createElement("rn-symbol", { "data-ios": ios, "data-android": android }),
}));
vi.mock("./native", () => ({
  useMobileTokens: () => ({
    card: "card",
    cardForeground: "fg",
    foreground: "fg",
    mutedForeground: "muted",
    border: "border",
    success: "success",
    destructive: "destructive",
    warning: "warning",
  }),
}));
const translate = vi.hoisted(() => ({ catalog: {} as Record<string, string> }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (message: string, values: Record<string, string> = {}) =>
      (translate.catalog[message] ?? message).replace(
        /\{(\w+)\}/g,
        (_, key: string) => values[key] ?? "",
      ),
  }),
}));

import { TaskProgressCard } from "../components/task-progress-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const now = new Date("2026-10-25T15:20:00Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();
const block: TaskProgressBlock = {
  kind: "task_progress",
  botId: "main",
  updatedAt: ago(5),
  tasks: [
    {
      ref: "TAB12CD3",
      name: "竞品调研",
      state: "running",
      workerBotId: "worker-1",
      queuedAt: ago(800),
      startedAt: ago(750),
      step: "Reading https://example.com/pricing",
    },
    {
      ref: "TASK0002",
      name: "登录后台",
      state: "needs_user",
      workerBotId: "worker-2",
      queuedAt: ago(300),
      startedAt: ago(290),
      step: "允许打开 example.com 吗？",
    },
    { ref: "TQUEUE01", name: "写周报", state: "queued", queuedAt: ago(30), position: 1 },
    {
      ref: "TFAIL001",
      name: "发图",
      state: "failed",
      queuedAt: ago(900),
      startedAt: ago(880),
      finishedAt: ago(700),
      step: "worker hand-off did not complete",
    },
  ],
};

let unmount = () => undefined as void;
afterEach(() => {
  unmount();
  translate.catalog = {};
});

function mount(props: Parameters<typeof TaskProgressCard>[0]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<TaskProgressCard {...props} />));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

it("shows every task's state, run time and latest step", () => {
  const card = mount({ block, now });
  const row = (ref: string) => card.querySelector(`[data-testid="task-progress-${ref}"]`)!;
  expect(row("TAB12CD3").textContent).toContain("12m");
  expect(row("TAB12CD3").textContent).toContain("Reading https://example.com/pricing");
  expect(row("TASK0002").getAttribute("aria-label")).toBe("登录后台 #TASK0002: needs you");
  expect(row("TQUEUE01").textContent).toContain("queued #1");
  expect(row("TFAIL001").textContent).toContain("3m");
  expect(card.textContent).toContain("3 running · 1 not finished");
  // Running spins; other states show their symbol on both platforms.
  expect(row("TAB12CD3").querySelector("rn-spinner")).not.toBeNull();
  expect(row("TASK0002").querySelector("rn-symbol")?.getAttribute("data-ios")).toBe(
    "hand.raised.fill",
  );
  expect(row("TFAIL001").querySelector("rn-symbol")?.getAttribute("data-android")).toBe(
    "close-circle",
  );
});

it("is view-only: no row opens its hidden worker, long-press still reaches the message", () => {
  const onLongPress = vi.fn();
  const card = mount({ block, now, pressableProps: { onLongPress } });
  const rows = [...card.querySelectorAll<HTMLElement>("rn-pressable")];
  expect(rows).toHaveLength(block.tasks.length);
  expect(block.tasks.filter((task) => task.workerBotId).length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.dataset.tappable).toBeUndefined();
    expect(row.dataset.pressFeedback).toBeUndefined();
    expect(row.getAttribute("role")).toBe("text");
  }
  expect(card.querySelector('rn-symbol[data-ios="chevron.right"]')).toBeNull();
  act(() =>
    card
      .querySelector('[data-testid="task-progress-TASK0002"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
  );
  expect(onLongPress).toHaveBeenCalledOnce();
});

it("keeps the thread card's full width on any phone, with no chevron", () => {
  // iOS and Android resolve a percentage width in a content-sized bot row to nothing, and
  // the card then collapsed to its icon column with one character per line.
  for (const width of [375, 393, 430, 1024]) {
    window.rn.dimensions = { width, height: 852 };
    const card = mount({ block, now });
    const style = JSON.parse(
      card.querySelector<HTMLElement>('[data-testid="task-progress-card"]')!.dataset.style!,
    ) as { width: unknown };
    expect(style.width).toBe(threadCardWidth(width));
    expect(typeof style.width).toBe("number");
    expect(style.width as number).toBeGreaterThan(300);
    expect(card.querySelector('rn-symbol[data-ios="chevron.right"]')).toBeNull();
    expect(card.querySelector('rn-symbol[data-android="chevron-forward"]')).toBeNull();
    unmount();
    unmount = () => undefined;
  }
  window.rn.dimensions = { width: 393, height: 852 };
});

it("counts up on its own and reads in Chinese", () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  translate.catalog = ZH_MESSAGES;
  try {
    const card = mount({ block: { ...block, tasks: [block.tasks[0]!] } });
    expect(card.textContent).toContain("后台任务");
    expect(card.textContent).toContain("1 个进行中");
    expect(card.textContent).toContain("12m");
    act(() => vi.advanceTimersByTime(61_000));
    expect(card.textContent).toContain("13m");
    unmount();
    unmount = () => undefined;
  } finally {
    vi.useRealTimers();
  }
});

it("draws the borderless chat-card shell shared with ChoiceCard and approvals", () => {
  const card = mount({ block, now });
  const style = JSON.parse(
    card.querySelector<HTMLElement>('[data-testid="task-progress-card"]')!.dataset.style!,
  ) as Record<string, unknown>;
  expect(style.borderRadius).toBe(CHAT_CARD_RADIUS);
  expect(style.backgroundColor).toBe("card");
  expect(style).not.toHaveProperty("borderWidth");
  expect(style).not.toHaveProperty("borderColor");
});
