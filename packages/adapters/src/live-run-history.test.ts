import { describe, expect, it, vi } from "vitest";
import { withoutMessagesOwnedByOtherLiveRuns } from "./executor.js";

const run = { botId: "main", threadId: "t1" };

describe("withoutMessagesOwnedByOtherLiveRuns", () => {
  it("leaves worker results and user messages owned by another live turn to that turn", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "wake-2" }, { id: "user-run" }]);
    const messages = [
      { id: "m1", role: "user", runId: "done-run" },
      { id: "m2", role: "user", runId: "wake-1" },
      { id: "m3", role: "user", runId: "wake-2" },
      { id: "m4", role: "user", runId: "user-run" },
      { id: "m5", role: "bot", runId: "wake-2" },
    ];
    const kept = await withoutMessagesOwnedByOtherLiveRuns(
      { run: { findMany } } as never,
      run,
      "wake-1",
      messages,
    );
    expect(kept.map((m) => m.id)).toEqual(["m1", "m2", "m5"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["done-run", "wake-2", "user-run"] },
          botId: "main",
          threadId: "t1",
          status: { in: ["queued", "running"] },
        }),
      }),
    );
  });

  it("keeps everything when no other turn is live", async () => {
    const messages = [{ id: "m1", role: "user", runId: "old" }];
    const findMany = vi.fn().mockResolvedValue([]);
    expect(
      await withoutMessagesOwnedByOtherLiveRuns({ run: { findMany } } as never, run, "r", messages),
    ).toEqual(messages);
  });
});
