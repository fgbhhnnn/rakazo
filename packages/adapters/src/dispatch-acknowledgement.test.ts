import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  ACK_KEEP_CHARS,
  acknowledgementOf,
  launchedTasksSummary,
  proseSentences,
} from "./dispatch-acknowledgement.js";
import { createDispatcherTurnLedger, guardDispatcherReply } from "./dispatcher-reply-guard.js";

const five = [
  { ref: "TIZP28J2", name: "质数前300万", status: "started" as const },
  { ref: "TIZXV4ZQ", name: "蒙特卡洛π 8轮", status: "started" as const },
  { ref: "TJ07BNTV", name: "三种排序计时", status: "started" as const },
  { ref: "TJ0N35OB", name: "泰坦尼克6步分析", status: "queued" as const, position: 1 },
  { ref: "TJ0TX4IZ", name: "斐波那契20万项", status: "queued" as const, position: 2 },
];
// The reply seen in the long-task test (seq 1589): a lead-in, then headed lists of tasks.
const listed = `五个任务都已按顺序派出：\n\n**已完成开始运行（3 个）**\n- 质数前300万 #TIZP28J2\n- 蒙特卡洛π 8轮 #TIZXV4ZQ\n- 三种排序计时 #TJ07BNTV\n\n**排队中（2 个）**\n- 泰坦尼克6步分析 #TJ0N35OB（第 1 位）\n- 斐波那契20万项 #TJ0TX4IZ（第 2 位）\n\n${"每个任务的说明，".repeat(30)}完成后我会逐一告诉你。`;

describe("proseSentences", () => {
  it("skips headings, emphasis-only lines, list items, tables and colon lead-ins", () => {
    expect(proseSentences(listed)).toEqual([
      `${"每个任务的说明，".repeat(30)}完成后我会逐一告诉你。`,
    ]);
    expect(proseSentences("## 标题\n| a | b |\n> 引用\n1. 第一步\n好的，开始了。然后")).toEqual([
      "好的，开始了。",
      "然后。",
    ]);
  });
  it("never ends on a half sentence", () => {
    expect(proseSentences("下面是答案：很长的分析内容，")).toEqual([]);
  });
});

describe("acknowledgementOf", () => {
  it("keeps up to two whole sentences", () => {
    expect(acknowledgementOf("一。二。三。")).toBe("一。二。");
    expect(acknowledgementOf(`${"长".repeat(ACK_KEEP_CHARS + 5)}。短。`)).toBe(
      "收到，已安排后台处理，完成后我会把结果发给你。",
    );
  });
  it("replaces a dangling header with the real status of every launched task", () => {
    const ack = acknowledgementOf(listed, five);
    expect(ack).toBe(launchedTasksSummary(five));
    for (const task of five) expect(ack).toContain(`#${task.ref}`);
    expect(ack).toContain("2 个已排队");
    expect(ack).toContain("（第 1 位）");
    expect(ack).not.toContain("**");
    expect(ack.endsWith("完成后我会把结果发给你。")).toBe(true);
  });
  it("keeps the model's own sentence when it names every task and the queue", () => {
    const own = "好的，#AAAA1111 已开始，#BBBB2222 排队第 1 位。";
    const tasks = [
      { ref: "AAAA1111", status: "started" as const },
      { ref: "BBBB2222", status: "queued" as const, position: 1 },
    ];
    expect(acknowledgementOf(`${own}\n${"细节。".repeat(100)}`, tasks)).toBe(`${own}细节。`);
    expect(acknowledgementOf("好的，#AAAA1111 和 #BBBB2222 都开始了。", tasks)).toBe(
      launchedTasksSummary(tasks),
    );
  });
});

describe("guardDispatcherReply uses the ledger's task list", () => {
  it("turns the seq-1589 reply into a complete acknowledgement", () => {
    const ledger = createDispatcherTurnLedger();
    for (const task of five) {
      ledger.record(
        "background_task",
        task.status === "started"
          ? { ok: true, status: "started", task_ref: task.ref, task_id: task.ref, name: task.name }
          : {
              ok: true,
              status: "queued",
              task_id: task.ref,
              name: task.name,
              position: task.position,
            },
      );
    }
    expect(ledger.launchedTasks).toEqual(five);
    const blocks: MessageBlock[] = [{ kind: "text", text: listed }];
    const out = guardDispatcherReply(true, blocks, ledger, { wokenByWorker: false, runId: "r" });
    expect(out.changed).toBe(true);
    expect(out.blocks).toEqual([{ kind: "text", text: launchedTasksSummary(five) }]);
  });
});
