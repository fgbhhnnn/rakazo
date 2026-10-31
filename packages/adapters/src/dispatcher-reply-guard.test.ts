import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  acknowledgementOf,
  CLAIM_RECHECK_MARKER,
  claimsWorkerAction,
  createDispatcherTurnLedger,
  DISPATCH_ACK_MAX_CHARS,
  guardDispatcherReply,
  queueClaimRecheck,
  withoutWorkerClaims,
} from "./dispatcher-reply-guard.js";

const text = (value: string): MessageBlock[] => [{ kind: "text", text: value }];
const joined = (blocks: MessageBlock[]) =>
  blocks.map((block) => (block.kind === "text" ? block.text : "")).join("");
const ctx = { wokenByWorker: false, runId: "run_1" };

function ledger(...calls: [string, unknown][]) {
  const l = createDispatcherTurnLedger();
  for (const [name, result] of calls) l.record(name, result);
  return l;
}

describe("dispatcher turn ledger", () => {
  it("tracks new launches and any successful background_task* call", () => {
    expect(ledger().actedOnWorkers).toBe(false);
    const started = ledger([
      "background_task",
      { ok: true, status: "started", task_ref: "AB12CD34" },
    ]);
    expect(started.launchedNew).toBe(true);
    expect([...started.launchedRefs]).toEqual(["AB12CD34"]);
    const dup = ledger(["background_task", { ok: true, status: "already_running" }]);
    expect(dup.launchedNew).toBe(false);
    expect(dup.actedOnWorkers).toBe(true);
    expect(ledger(["background_task_message", { ok: true }]).actedOnWorkers).toBe(true);
    expect(ledger(["background_task", { error: "nope" }]).actedOnWorkers).toBe(false);
    expect(ledger(["web_search", { ok: true }]).actedOnWorkers).toBe(false);
  });
});

describe("claim detection", () => {
  it.each([
    "我已经让它重新发一份了。",
    "已经安排后台去做了。",
    "我让后台补发了文件。",
    "开了一个后台任务处理这个。",
    "刚刚已派给 worker 了。",
    "正在补发那张图。",
    "I've asked the worker to resend it.",
  ])("flags %s", (sentence) => {
    expect(claimsWorkerAction(sentence)).toBe(true);
  });
  it.each([
    "要不要我让它重发？",
    "需要的话可以让它再做一版吗",
    "这张图是红色的。",
    "北京今天晴，最高 20 度。",
  ])("does not flag %s", (sentence) => {
    expect(claimsWorkerAction(sentence)).toBe(false);
  });
  it("removes only the claim sentences", () => {
    expect(withoutWorkerClaims("好的。我已经让它重新发了。稍等一下。")).toBe("好的。稍等一下。");
  });
});

describe("guardDispatcherReply: false claims (fix 3)", () => {
  it("strips a claim no tool backed and asks for one recheck", () => {
    const out = guardDispatcherReply(true, text("好的。我已经让它补发了文件。"), ledger(), ctx);
    expect(out.changed).toBe(true);
    expect(out.recheckClaim).toBe(true);
    expect(joined(out.blocks)).toBe("好的。");
    expect(out.original).toBe("好的。我已经让它补发了文件。");
  });
  it("keeps the claim when a background_task* call succeeded", () => {
    const out = guardDispatcherReply(
      true,
      text("我已经让它补发了文件。"),
      ledger(["background_task_message", { ok: true }]),
      ctx,
    );
    expect(out).toMatchObject({ changed: false, recheckClaim: false });
  });
  it("leaves a turn woken by a worker result alone", () => {
    const out = guardDispatcherReply(true, text("它已经补发了文件。"), ledger(), {
      ...ctx,
      wokenByWorker: true,
    });
    expect(out.changed).toBe(false);
  });
  it("is a no-op outside dispatcher turns", () => {
    expect(guardDispatcherReply(false, text("我已经让它补发了。"), ledger(), ctx).changed).toBe(
      false,
    );
  });
  it("keeps a placeholder when the whole reply was the claim", () => {
    const out = guardDispatcherReply(true, text("已经安排后台去做了。"), ledger(), ctx);
    expect(joined(out.blocks)).toBe("收到。");
  });
});

describe("guardDispatcherReply: dispatch and answer in one turn (fix 2)", () => {
  const started = () =>
    ledger(["background_task", { ok: true, status: "started", task_ref: "AB12CD34" }]);
  const answer = `好的，已开始查 #AB12CD34。下面是答案：${"很长的分析内容，".repeat(80)}`;

  it("trims a long answer to the acknowledgement and keeps other blocks", () => {
    const image: MessageBlock = { kind: "image", artifactId: "art_1" } as MessageBlock;
    const out = guardDispatcherReply(true, [...text(answer), image], started(), ctx);
    expect(out.changed).toBe(true);
    expect(out.recheckClaim).toBe(false);
    expect(joined(out.blocks)).toBe(acknowledgementOf(answer));
    expect(joined(out.blocks).length).toBeLessThanOrEqual(200);
    expect(out.blocks).toContainEqual(image);
  });
  it("keeps a short acknowledgement", () => {
    const out = guardDispatcherReply(true, text("好的，已开始 #AB12CD34。"), started(), ctx);
    expect(out.changed).toBe(false);
  });
  it("keeps a long reply that relays another finished task", () => {
    const relay = `已开始新任务 #AB12CD34。另外 #ZZ99YY88 的结果：${"内容".repeat(DISPATCH_ACK_MAX_CHARS)}`;
    expect(guardDispatcherReply(true, text(relay), started(), ctx).changed).toBe(false);
    const labelled = `已开始新任务。【后台任务：写报告】${"内容".repeat(DISPATCH_ACK_MAX_CHARS)}`;
    expect(guardDispatcherReply(true, text(labelled), started(), ctx).changed).toBe(false);
  });
  it("does not trim when nothing new was launched or a worker woke the turn", () => {
    expect(guardDispatcherReply(true, text(answer), ledger(), ctx).changed).toBe(false);
    expect(
      guardDispatcherReply(true, text(answer), started(), { ...ctx, wokenByWorker: true }).changed,
    ).toBe(false);
  });
  it("acknowledgement takes at most two sentences", () => {
    expect(acknowledgementOf("一。二。三。")).toBe("一。二。");
  });
});

describe("guardDispatcherReply: one acknowledgement per dispatch turn", () => {
  const started = () =>
    ledger(["background_task", { ok: true, status: "started", task_ref: "AB12CD34" }]);
  const acked = { ...ctx, acknowledgedMidTurn: true };
  const repeat =
    "可以帮你重构。我已经在看 GitHub 上的 autoai-next，先只做代码分析，这一步不需要 Expo 或苹果开发者的 key。分析完成后我会告诉你能不能迁、卡在哪、建议怎么分阶段做。";
  const steps = { kind: "steps", steps: [] } as unknown as MessageBlock;

  it("drops a reworded second acknowledgement after the lead-in already went out", () => {
    const out = guardDispatcherReply(true, [steps, ...text(repeat)], started(), acked);
    expect(out.changed).toBe(true);
    expect(out.recheckClaim).toBe(false);
    expect(out.blocks).toEqual([]);
  });
  it("keeps the final reply's non-tool blocks", () => {
    const image: MessageBlock = { kind: "image", artifactId: "art_1" } as MessageBlock;
    const out = guardDispatcherReply(true, [...text(repeat), image], started(), acked);
    expect(out.blocks).toEqual([image]);
  });
  it("still sends a question, another task's result, or a reply with no lead-in", () => {
    const question = "我先看代码。你要保留 uniapp 的 H5 端吗？";
    expect(guardDispatcherReply(true, text(question), started(), acked).changed).toBe(false);
    const relay = "已开始 #AB12CD34。另外 #ZZ99YY88 已经完成了。";
    expect(guardDispatcherReply(true, text(relay), started(), acked).changed).toBe(false);
    expect(guardDispatcherReply(true, text(repeat), started(), ctx).changed).toBe(false);
  });
  it("leaves turns that launched nothing or were woken by a worker alone", () => {
    expect(guardDispatcherReply(true, text(repeat), ledger(), acked).changed).toBe(false);
    expect(
      guardDispatcherReply(true, text(repeat), started(), { ...acked, wokenByWorker: true })
        .changed,
    ).toBe(false);
  });
});

describe("queueClaimRecheck", () => {
  const run = {
    id: "run_1",
    spaceId: "s",
    botId: "b",
    threadId: "t",
    taskId: "task_1",
    userId: "u",
    trigger: "user",
    sourceMessageId: "m",
  };
  function deps(prompt: string) {
    const tx = {
      task: { create: vi.fn(async () => ({ id: "task_2" })) },
      run: { create: vi.fn(async () => ({ id: "run_2" })) },
    };
    return {
      tx,
      deps: {
        prisma: {
          task: { findUnique: vi.fn(async () => ({ prompt })) },
          $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
        },
        jobs: { enqueue: vi.fn(async () => undefined) },
      } as never,
    };
  }

  it("queues one corrective turn on the same source message", async () => {
    const { tx, deps: d } = deps("帮我重发那张图");
    expect(await queueClaimRecheck(d, run, "我已经让它补发了。")).toBe(true);
    const taskData = (tx.task.create.mock.calls[0] as unknown as [{ data: { prompt: string } }])[0]
      .data;
    expect(taskData.prompt.startsWith("帮我重发那张图")).toBe(true);
    expect(taskData.prompt).toContain(CLAIM_RECHECK_MARKER);
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trigger: "user",
          sourceMessageId: "m",
          retryOfRunId: "run_1",
        }),
      }),
    );
    expect((d as { jobs: { enqueue: ReturnType<typeof vi.fn> } }).jobs.enqueue).toHaveBeenCalled();
  });

  it("never re-prompts a corrective turn again", async () => {
    const { tx, deps: d } = deps(`x\n\n${CLAIM_RECHECK_MARKER}\n...`);
    expect(await queueClaimRecheck(d, run, "我已经让它补发了。")).toBe(false);
    expect(tx.task.create).not.toHaveBeenCalled();
  });
});
