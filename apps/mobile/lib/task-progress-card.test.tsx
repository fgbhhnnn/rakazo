// @vitest-environment jsdom
import type { TaskProgressBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ZH_MESSAGES } from "./locales/zh";

vi.mock("react-native", () => {
  type Props = {
    children?: ReactNode;
    testID?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    disabled?: boolean;
    onPress?: () => void;
  };
  return {
    Pressable: ({
      children,
      onPress,
      testID,
      accessibilityLabel,
      accessibilityRole,
      disabled,
    }: Props) =>
      createElement(
        "rn-pressable",
        {
          "data-testid": testID,
          onClick: disabled ? undefined : onPress,
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
        },
        children,
      ),
    Text: ({ children }: Props) => createElement("rn-text", null, children),
    View: ({ children, testID }: Props) =>
      createElement("rn-view", { "data-testid": testID }, children),
  };
});
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
});

it("opens a worker from its row, not a queued task", () => {
  const onOpenBot = vi.fn();
  const card = mount({ block, now, onOpenBot });
  act(() => card.querySelector<HTMLElement>('[data-testid="task-progress-TASK0002"]')!.click());
  expect(onOpenBot).toHaveBeenCalledWith("worker-2", "登录后台");
  act(() => card.querySelector<HTMLElement>('[data-testid="task-progress-TQUEUE01"]')!.click());
  expect(onOpenBot).toHaveBeenCalledTimes(1);
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
