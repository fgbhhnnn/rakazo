import { describe, expect, it } from "vitest";
import { createDispatcherTurnLedger, guardDispatcherReply } from "./dispatcher-reply-guard.js";
import { slotFree, withoutWorkerSlotMentions } from "./worker-slot-mentions.js";

describe("withoutWorkerSlotMentions", () => {
  it.each([
    [
      "**蒙特卡洛 π 任务已完成**（#TIZXV4ZQ，由后台4执行）：共运行 4 轮。",
      "**蒙特卡洛 π 任务已完成**（#TIZXV4ZQ）：共运行 4 轮。",
    ],
    ["结果（由后台2完成）如下。", "结果如下。"],
    ["任务交给后台1处理了。", "任务交给后台处理了。"],
    ["后台3 已经开始跑了。", "后台 已经开始跑了。"],
    ["后台2号还在运行 #AB12CD34。", "后台还在运行 #AB12CD34。"],
  ])("removes the slot from %s", (input, expected) => {
    expect(withoutWorkerSlotMentions(input)).toBe(expected);
  });

  it.each([
    "后台3个任务都在运行。",
    "后台 2 项已排队。",
    "后台任务 #TJ0N35OB 已完成，耗时 225.4 秒。",
    "每轮 2000 万个点，退出码 0。",
  ])("keeps %s", (input) => {
    expect(withoutWorkerSlotMentions(input)).toBe(input);
  });
});

describe("guardDispatcherReply removes worker slot names", () => {
  it("rewrites a relayed result that credits a slot (seq 1609)", () => {
    const text = "**蒙特卡洛 π 任务已完成**（#TIZXV4ZQ，由后台4执行）：共运行 4 轮。";
    const out = guardDispatcherReply(true, [{ kind: "text", text }], createDispatcherTurnLedger(), {
      wokenByWorker: true,
      runId: "r",
    });
    expect(out.changed).toBe(true);
    expect(out.blocks).toEqual([
      { kind: "text", text: "**蒙特卡洛 π 任务已完成**（#TIZXV4ZQ）：共运行 4 轮。" },
    ]);
  });

  it("leaves a reply without slot names untouched", () => {
    const blocks = [{ kind: "text" as const, text: "后台3个任务都在运行。" }];
    const out = guardDispatcherReply(true, blocks, createDispatcherTurnLedger(), {
      wokenByWorker: true,
      runId: "r",
    });
    expect(out).toMatchObject({ changed: false, blocks });
  });

  it("does nothing outside dispatcher turns", () => {
    const blocks = [{ kind: "text" as const, text: "由后台4执行。" }];
    const out = guardDispatcherReply(false, blocks, createDispatcherTurnLedger(), {
      wokenByWorker: true,
      runId: "r",
    });
    expect(out.changed).toBe(false);
  });
});

describe("slotFree", () => {
  it("filters only the writers it applies to", () => {
    expect(slotFree(true)("后台4 正在跑 #AB12")).toBe("后台 正在跑 #AB12");
    expect(slotFree(false)("后台4 正在跑 #AB12")).toBe("后台4 正在跑 #AB12");
  });
});
