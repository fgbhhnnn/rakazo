import { BOT_MESSAGE_MAX_LENGTH } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const attach = vi.fn();
vi.mock("./thread-artifacts.js", () => ({ attachWorkspaceFileToThread: attach }));
vi.mock("./background-task-rows.js", () => ({
  backgroundTaskForWorkerRun: vi.fn(async () => ({ ref: "AB12CD34" })),
}));

const { forwardWorkerRelayAttachments, reportFilesSection, resultFileName, workerOutcomeRelay } =
  await import("./worker-outcome-relay.js");

const run = { id: "run_worker_1", spaceId: "space", userId: "user", botId: "worker" };
const block = { kind: "file" as const, artifactId: "art_1", name: "result-AB12CD34.md" };
const long = `${"结论段落。".repeat(2_000)}\n文件：\n- ./jobs/x/out/report.md`;

describe("workerOutcomeRelay", () => {
  beforeEach(() => {
    attach.mockReset();
    attach.mockResolvedValue({ artifactId: "art_1", block });
  });

  it("passes a short worker result through unchanged", async () => {
    const relay = await workerOutcomeRelay({ prisma: {} as never }, run, "写报告", "完成了");
    expect(relay).toEqual({ message: "【后台任务：写报告】\n完成了" });
    expect(attach).not.toHaveBeenCalled();
  });

  it("keeps worker slot names out of the relay and the result file", async () => {
    const short = await workerOutcomeRelay(
      { prisma: {} as never },
      run,
      "π",
      "已完成（由后台4执行），后台3个任务都结束了。",
    );
    expect(short.message).toBe("【后台任务：π】\n已完成，后台3个任务都结束了。");
    await workerOutcomeRelay(
      { prisma: {} as never, artifacts: {} as never },
      run,
      "写报告",
      `由后台2执行。${long}`,
    );
    const bytes = (attach.mock.calls[0]![1] as { bytes: Uint8Array }).bytes;
    expect(new TextDecoder().decode(bytes)).not.toMatch(/后台\s*2/);
  });

  it("still clamps a non-worker (no title) message", async () => {
    const relay = await workerOutcomeRelay(
      { prisma: {} as never, artifacts: {} as never },
      run,
      undefined,
      "x".repeat(BOT_MESSAGE_MAX_LENGTH + 500),
    );
    expect(relay.message.length).toBeLessThanOrEqual(BOT_MESSAGE_MAX_LENGTH);
    expect(relay.attachments).toBeUndefined();
    expect(attach).not.toHaveBeenCalled();
  });

  it("attaches an over-long worker result whole as result-<REF>.md, owned by the dispatcher", async () => {
    const relay = await workerOutcomeRelay(
      { prisma: {} as never, artifacts: {} as never },
      run,
      "写报告",
      long,
      "dispatcher",
    );
    expect(relay.attachments).toEqual([block]);
    expect(relay.message).toContain("【后台任务：写报告】");
    expect(relay.message).toContain("result-AB12CD34.md");
    expect(relay.message).toContain(`${long.trim().length} 字`);
    expect(relay.message).toContain("文件：\n- ./jobs/x/out/report.md");
    expect(relay.message.length).toBeLessThan(1_000);
    const [, input] = attach.mock.calls[0]!;
    expect(input).toMatchObject({ botId: "dispatcher", filePath: "result-AB12CD34.md" });
    expect(new TextDecoder().decode(input.bytes)).toBe(`【后台任务：写报告】\n${long.trim()}\n`);
  });

  it("falls back to a clamped, labelled message without an artifact store", async () => {
    const relay = await workerOutcomeRelay({ prisma: {} as never }, run, "写报告", long);
    expect(relay.attachments).toBeUndefined();
    expect(relay.message.length).toBeLessThanOrEqual(BOT_MESSAGE_MAX_LENGTH);
    expect(relay.message).toContain("已截断");
    expect(relay.message).toContain("文件：\n- ./jobs/x/out/report.md");
  });

  it("falls back when attaching fails", async () => {
    attach.mockRejectedValueOnce(new Error("quota"));
    const relay = await workerOutcomeRelay(
      { prisma: {} as never, artifacts: {} as never },
      run,
      "写报告",
      long,
    );
    expect(relay.attachments).toBeUndefined();
    expect(relay.message).toContain("已截断");
  });
});

describe("helpers", () => {
  it("names the file by task ref, else the run", () => {
    expect(resultFileName("AB12CD34", "run_1")).toBe("result-AB12CD34.md");
    expect(resultFileName(null, "run_abcdefgh12")).toBe("result-cdefgh12.md");
  });
  it("keeps only a bounded 文件： section", () => {
    expect(reportFilesSection("正文\n文件：\n- a.png")).toBe("文件：\n- a.png");
    expect(reportFilesSection("正文")).toBe("");
    expect(reportFilesSection(`文件：\n${"x".repeat(3_000)}`)).toBe("");
  });
});

describe("forwardWorkerRelayAttachments", () => {
  function prisma(opts: { worker: boolean; published?: string[] }) {
    return {
      bot: { findFirst: vi.fn(async () => (opts.worker ? { id: "w" } : null)) },
      message: {
        findUnique: vi.fn(async () => ({
          blocks: [
            { kind: "text", text: "note" },
            { kind: "file", artifactId: "art_1", name: "result-A.md" },
            { kind: "image", artifactId: "art_2" },
          ],
        })),
        findMany: vi.fn(async () =>
          (opts.published ?? []).map((artifactId) => ({
            blocks: [{ kind: "file", artifactId, name: "x" }],
          })),
        ),
      },
    } as never;
  }
  const relayRun = { id: "run_d", threadId: "t", sourceMessageId: "m" };

  it("publishes a hidden worker's relay attachments once", async () => {
    const publish = vi.fn(async () => undefined);
    const ids = await forwardWorkerRelayAttachments({
      prisma: prisma({ worker: true, published: ["art_2"] }),
      run: relayRun,
      bot: { id: "d" },
      report: { fromBotId: "w" },
      publish,
    });
    expect(ids).toEqual(["art_1"]);
    expect(publish).toHaveBeenCalledWith([
      { kind: "file", artifactId: "art_1", name: "result-A.md" },
    ]);
  });

  it("ignores bots that are not this dispatcher's workers", async () => {
    const publish = vi.fn(async () => undefined);
    const ids = await forwardWorkerRelayAttachments({
      prisma: prisma({ worker: false }),
      run: relayRun,
      bot: { id: "d" },
      report: { fromBotId: "other" },
      publish,
    });
    expect(ids).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });
});
