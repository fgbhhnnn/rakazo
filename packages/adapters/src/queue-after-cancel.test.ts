import { describe, expect, it, vi } from "vitest";
import { queueChangeAfterCancel } from "./queue-after-cancel.js";

describe("queueChangeAfterCancel", () => {
  it("reports queued tasks that took the freed slot and the remaining queue order", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "q1", ref: "TJ0N35OB", name: "泰坦尼克6步分析", status: "started" },
        { id: "q2", ref: "TJ0TX4IZ", name: "斐波那契20万项", status: "queued" },
      ])
      .mockResolvedValueOnce([{ id: "q2", ref: "TJ0TX4IZ", name: "斐波那契20万项" }]);
    const out = await queueChangeAfterCancel(
      { backgroundTaskQueue: { findMany } } as never,
      "dispatcher",
      ["q1", "q2"],
    );
    expect(out).toEqual({
      started_from_queue: [{ task_id: "TJ0N35OB", name: "泰坦尼克6步分析" }],
      still_queued: [{ task_id: "TJ0TX4IZ", name: "斐波那契20万项", position: 1 }],
    });
  });

  it("skips the lookup when nothing was queued", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const out = await queueChangeAfterCancel(
      { backgroundTaskQueue: { findMany } } as never,
      "dispatcher",
      [],
    );
    expect(out).toEqual({ started_from_queue: [], still_queued: [] });
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
