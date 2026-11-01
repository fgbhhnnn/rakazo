import { describe, expect, it, vi } from "vitest";
import { cancelSupersededQueuedRuns } from "./thread-target.js";

describe("queued run human priority", () => {
  const human = { role: "user", botId: null, blocks: [{ kind: "text", text: "hello" }] };
  const relay = {
    ...human,
    blocks: [
      { kind: "bot_message_received", fromBotId: "worker" },
      { kind: "file", artifactId: "result" },
    ],
  };
  const candidate = (id: string, sourceMessage: unknown, trigger = "user") => ({
    id,
    taskId: `task-${id}`,
    trigger,
    sourceMessage,
  });
  function db(candidates: unknown[]) {
    return {
      $queryRaw: vi.fn(async () => []),
      externalEffect: { deleteMany: vi.fn() },
      run: {
        findMany: vi.fn().mockResolvedValueOnce(candidates).mockResolvedValue([]),
        updateMany: vi.fn(),
      },
      message: { findMany: vi.fn(async () => []) },
      task: { updateMany: vi.fn() },
      secret: { deleteMany: vi.fn() },
    };
  }
  const input = { threadId: "group-thread", botIds: ["frontend"], keepRunIds: ["new"] };

  it("keeps relay work while superseding real human messages and reactions", async () => {
    const tx = db([
      candidate("human", human),
      candidate("reaction", human, "reaction"),
      candidate("relay", relay),
      candidate("bot", { ...human, botId: "worker" }),
    ]);
    await cancelSupersededQueuedRuns(tx as never, input);
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["human", "reaction"] } } }),
    );
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["task-human", "task-reaction"] } },
      data: { status: "cancelled" },
    });
  });

  it("does not cancel tasks when every candidate is a relay", async () => {
    const tx = db([candidate("relay", relay)]);
    await cancelSupersededQueuedRuns(tx as never, input);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });
});
