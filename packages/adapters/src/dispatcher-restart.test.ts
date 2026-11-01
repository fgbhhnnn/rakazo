import { describe, expect, it, vi } from "vitest";
import { restartDispatcherTurn } from "./dispatcher-mode.js";

const failed = {
  id: "run-1",
  spaceId: "s",
  botId: "b",
  threadId: "t",
  taskId: "task-1",
  userId: "u",
  trigger: "user",
  sourceMessageId: null,
};

function harness(status: string, existingRetry: { id: string } | null = null) {
  const tx = {
    run: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string; status?: { in: string[] } } }) => {
        if (where.id === undefined) return existingRetry;
        return where.status?.in.includes(status) ? { id: failed.id } : null;
      }),
      create: vi.fn(async () => ({ id: "retry-1" })),
    },
    task: { create: vi.fn(async () => ({ id: "retry-task" })) },
    steeringMessage: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  const enqueue = vi.fn(async () => undefined);
  const deps = {
    prisma: {
      run: { findUnique: vi.fn(async () => ({ retryOfRunId: null })) },
      task: { findUnique: vi.fn(async () => ({ prompt: "hi" })) },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
    jobs: { enqueue },
  };
  return { tx, enqueue, deps };
}

describe("restartDispatcherTurn", () => {
  it("restarts a turn whose failure is recorded", async () => {
    const h = harness("failed");
    await expect(restartDispatcherTurn(h.deps as never, failed, false)).resolves.toBe(true);
    expect(h.tx.run.create).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it("never starts the retry before the failure is marked", async () => {
    const h = harness("running");
    await expect(restartDispatcherTurn(h.deps as never, failed, false)).resolves.toBe(false);
    expect(h.tx.run.create).not.toHaveBeenCalled();
    expect(h.tx.steeringMessage.updateMany).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("retries a failed turn only once", async () => {
    const h = harness("failed", { id: "retry-0" });
    await expect(restartDispatcherTurn(h.deps as never, failed, false)).resolves.toBe(true);
    expect(h.tx.run.create).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
