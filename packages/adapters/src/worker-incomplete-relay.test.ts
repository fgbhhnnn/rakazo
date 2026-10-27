import { BOT_MESSAGE_MAX_LENGTH } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const attach = vi.fn();
vi.mock("./thread-artifacts.js", () => ({ attachWorkspaceFileToThread: attach }));
vi.mock("./background-task-rows.js", () => ({
  backgroundTaskForWorkerRun: vi.fn(async () => ({ ref: "TZ5P9D3Y" })),
}));

const { incompleteFailedRelay } = await import("./worker-incomplete-continue.js");
const { incompleteExhaustedLead, incompleteExhaustedNote } = await import(
  "./worker-incomplete-result.js"
);

const run = { id: "run_worker_1", spaceId: "space", userId: "user", botId: "worker" };
const block = { kind: "file" as const, artifactId: "art_1", name: "result-TZ5P9D3Y.md" };

function decision(text: string) {
  const input = { reason: "unfinished_phrase" as const, cleanedText: text, continues: 3 };
  return {
    cleanedText: text,
    note: incompleteExhaustedNote(input),
    lead: incompleteExhaustedLead(input),
  };
}

describe("incompleteFailedRelay (exhausted continues keep the full text)", () => {
  beforeEach(() => {
    attach.mockReset();
    attach.mockResolvedValue({ artifactId: "art_1", block });
  });

  it("keeps a 5000-character result whole in the message, led by the unconfirmed note", async () => {
    const text = `${"第一节内容。".repeat(800)}结尾：第七节完整。`;
    expect(text.length).toBeGreaterThan(3_000);
    const relay = await incompleteFailedRelay(
      { prisma: {} as never, artifacts: {} as never },
      run,
      "项目总结",
      decision(text),
    );
    expect(relay.attachments).toBeUndefined();
    expect(relay.message).toContain("【未确认完成】");
    expect(relay.message).toContain(text);
    expect(relay.message.endsWith("结尾：第七节完整。")).toBe(true);
    expect(attach).not.toHaveBeenCalled();
  });

  it("sends an over-long result whole as the result file with only the worker's text", async () => {
    const text = `${"结论段落。".repeat(3_000)}\n最后一句。`;
    expect(text.length).toBeGreaterThan(BOT_MESSAGE_MAX_LENGTH);
    const relay = await incompleteFailedRelay(
      { prisma: {} as never, artifacts: {} as never },
      run,
      "项目总结",
      decision(text),
      "dispatcher",
    );
    expect(relay.attachments).toEqual([block]);
    expect(relay.message.startsWith("【未确认完成】")).toBe(true);
    expect(relay.message).toContain("result-TZ5P9D3Y.md");
    expect(relay.message.length).toBeLessThanOrEqual(BOT_MESSAGE_MAX_LENGTH);
    const bytes = new TextDecoder().decode(
      (attach.mock.calls[0]![1] as { bytes: Uint8Array }).bytes,
    );
    expect(bytes).toBe(`【后台任务：项目总结】\n${text.trim()}\n`);
    expect(bytes).not.toContain("未确认完成");
  });

  it("does not tell the dispatcher that content is missing", () => {
    const { note } = decision("完整的总结。");
    expect(note).toContain("系统没有删减");
    expect(note).toContain("不要说内容被截断或缺失");
    expect(note).not.toContain("最后可见内容");
  });
});
