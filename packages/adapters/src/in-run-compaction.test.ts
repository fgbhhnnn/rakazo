import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  createInRunCompactor,
  IN_RUN_SUMMARY_PREFIX,
  isInRunSummary,
  tailStart,
} from "./in-run-compaction.js";

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as AgentMessage;
const call = (id: string) =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "shell", arguments: { cmd: `step ${id}` } }],
    timestamp: 0,
  }) as unknown as AgentMessage;
const result = (id: string, size = 100) =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName: "shell",
    content: [{ type: "text", text: `out-${id} ${"x".repeat(size)}` }],
    timestamp: 0,
  }) as unknown as AgentMessage;
const size = (messages: AgentMessage[]) => JSON.stringify(messages).length;

function run(steps: number, extra: AgentMessage[] = []) {
  const messages: AgentMessage[] = [user("任务：整理报表，不要删除任何文件"), ...extra];
  for (let i = 0; i < steps; i++) messages.push(call(`c${i}`), result(`c${i}`, 1000));
  return messages;
}

describe("in-run compaction", () => {
  it("leaves a context under the threshold untouched and never calls the model", async () => {
    const summarize = vi.fn();
    const compact = createInRunCompactor({
      contextWindow: () => 1_000_000,
      estimateTokens: size,
      summarize,
    });
    const messages = run(5);
    expect(await compact(messages)).toBe(messages);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("summarizes older tool steps, keeps user turns and the recent tail verbatim", async () => {
    const summarize = vi.fn(async (_transcript: string) => "did steps c0..c15");
    const messages = run(20, [user("已批准：可以覆盖 out.csv")]);
    const compact = createInRunCompactor({
      contextWindow: () => size(messages) / 2,
      estimateTokens: size,
      summarize,
    });
    const out = await compact(messages);
    expect(summarize).toHaveBeenCalledOnce();
    expect(String(summarize.mock.calls[0]![0])).toContain("out-c0");
    // Task request, constraints and approvals stay first, then the summary.
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(messages[1]);
    expect(isInRunSummary(out[2] as never)).toBe(true);
    expect(String((out[2] as { content: string }).content)).toContain("did steps c0..c15");
    // The tail starts on a tool call, so no orphaned tool result.
    expect((out[3] as { role: string }).role).toBe("assistant");
    expect(out.slice(-4)).toEqual(messages.slice(-4));
    expect(size(out)).toBeLessThan(size(messages));
  });

  it("reuses the summary on later turns and folds it into the next one", async () => {
    let n = 0;
    const summarize = vi.fn(async (transcript: string) => {
      n += 1;
      return n === 2 && transcript.includes("summary one") ? "summary two" : "summary one";
    });
    const messages = run(20);
    const window = size(messages) / 2;
    const compact = createInRunCompactor({
      contextWindow: () => window,
      estimateTokens: size,
      summarize,
    });
    await compact(messages);
    // One more short step: still under the limit after reusing the summary.
    const grown = [...messages, call("n0"), result("n0", 10)];
    const second = await compact(grown);
    expect(summarize).toHaveBeenCalledOnce();
    expect(second.filter((m) => isInRunSummary(m as never))).toHaveLength(1);
    expect(second.slice(-2)).toEqual(grown.slice(-2));
    // Many more steps: compacts again, and the earlier summary is part of the input.
    for (let i = 0; i < 20; i++) grown.push(call(`m${i}`), result(`m${i}`, 1000));
    const third = await compact(grown);
    expect(summarize).toHaveBeenCalledTimes(2);
    const summaries = third.filter((m) => isInRunSummary(m as never));
    expect(summaries).toHaveLength(1);
    expect(String((summaries[0] as { content: string }).content)).toBe(
      `${IN_RUN_SUMMARY_PREFIX}\nsummary two`,
    );
    expect(third[0]).toBe(messages[0]);
  });

  it("falls back to the uncompacted context when the summary call fails", async () => {
    const summarize = vi.fn(async () => {
      throw new Error("provider down");
    });
    const messages = run(20);
    const compact = createInRunCompactor({
      contextWindow: () => size(messages) / 2,
      estimateTokens: size,
      summarize,
    });
    expect(await compact(messages)).toEqual(messages);
  });

  it("never starts the verbatim tail on a tool result", () => {
    const messages = run(3);
    expect((messages[tailStart(messages as never, 3)] as { role: string }).role).toBe("assistant");
  });
});
