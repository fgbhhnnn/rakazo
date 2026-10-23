import { describe, expect, it, vi } from "vitest";
import { waitForEarlierDispatcherTurns } from "./executor.js";

const run = { id: "r2", botId: "b", threadId: "t", createdAt: new Date() };

describe("waitForEarlierDispatcherTurns", () => {
  it("waits while an earlier turn of the same bot and chat is still live", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({ id: "r1" })
      .mockResolvedValueOnce({ id: "r1" })
      .mockResolvedValueOnce(null);
    const sleep = vi.fn(async () => undefined);
    const ok = await waitForEarlierDispatcherTurns({ run: { findFirst } } as never, run, { sleep });
    expect(ok).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
    const where = findFirst.mock.calls[0]?.[0].where;
    expect(where).toMatchObject({ id: { not: "r2" }, botId: "b", threadId: "t" });
    expect(where.OR).toContainEqual({
      status: "queued",
      trigger: "bot_message",
      createdAt: { lt: run.createdAt },
    });
  });

  it("gives up after the bound so a lost job never blocks a wake", async () => {
    const findFirst = vi.fn(async () => ({ id: "r1" }));
    const ok = await waitForEarlierDispatcherTurns({ run: { findFirst } } as never, run, {
      maxWaitMs: 0,
      sleep: async () => undefined,
    });
    expect(ok).toBe(false);
  });
});
