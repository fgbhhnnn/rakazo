// @vitest-environment jsdom

import type { TaskProgressBlock } from "@rakazo/contracts";
import { act, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { TaskProgressCard } from "./TaskProgressCard";

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
      ref: "TSTUCK01",
      name: "导出报表",
      state: "stuck",
      workerBotId: "worker-2",
      queuedAt: ago(1500),
      startedAt: ago(1440),
      step: "Running: python export.py",
    },
    { ref: "TQUEUE01", name: "写周报", state: "queued", queuedAt: ago(30), position: 1 },
    {
      ref: "TDONE001",
      name: "整理会议纪要",
      state: "done",
      queuedAt: ago(3000),
      startedAt: ago(2950),
      finishedAt: ago(2500),
    },
  ],
};

let cleanup: () => void = () => undefined;
afterEach(() => cleanup());

function mount(props: Parameters<typeof TaskProgressCard>[0]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<TaskProgressCard {...props} />));
  cleanup = () => {
    root.unmount();
    container.remove();
  };
  return container;
}

describe("TaskProgressCard", () => {
  it("lists each task with its state, run time and latest step", () => {
    const card = mount({ block, now });
    const rows = [...card.querySelectorAll("li")];
    expect(rows.map((row) => row.dataset.state)).toEqual(["running", "stuck", "queued", "done"]);
    expect(rows[0]!.textContent).toContain("竞品调研 #TAB12CD3");
    expect(rows[0]!.textContent).toContain("12m");
    expect(rows[0]!.textContent).toContain("Reading https://example.com/pricing");
    expect(rows[1]!.textContent).toContain("no progress");
    expect(rows[2]!.textContent).toContain("queued #1");
    expect(rows[2]!.querySelector('[data-testid="task-progress-time"]')).toBeNull();
    // A finished task's time stops at its finish.
    expect(rows[3]!.textContent).toContain("7m");
    expect(card.querySelector('[data-testid="task-progress-counts"]')?.textContent).toBe(
      "3 running · 1 done",
    );
  });

  it("opens a task's worker from its row", () => {
    const onOpenBot = vi.fn();
    const card = mount({ block, now, onOpenBot });
    card.querySelectorAll<HTMLButtonElement>("li button")[1]!.click();
    expect(onOpenBot).toHaveBeenCalledWith("worker-2");
    // Queued tasks have no worker yet: nothing to open.
    expect(card.querySelectorAll("li")[2]!.querySelector("button")).toBeNull();
  });

  it("counts run time up on its own while tasks run", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now.getTime()));
    try {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      act(() => root.render(<TaskProgressCard block={{ ...block, tasks: [block.tasks[0]!] }} />));
      cleanup = () => {
        act(() => root.unmount());
        container.remove();
      };
      const card = container;
      const time = () =>
        card.querySelector('[data-testid="task-progress-time"]')?.textContent ?? "";
      expect(time()).toBe("12m");
      act(() => vi.advanceTimersByTime(60_000));
      expect(time()).toBe("13m");
    } finally {
      cleanup();
      cleanup = () => undefined;
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
      vi.useRealTimers();
    }
  });

  it("titles a closed card as finished", () => {
    const card = mount({
      block: { ...block, closed: true, tasks: [block.tasks[3]!] },
      now,
    });
    expect(card.textContent).toContain("Background tasks finished");
    expect(card.querySelector('[data-testid="task-progress-counts"]')?.textContent).toBe("1 done");
  });
});
