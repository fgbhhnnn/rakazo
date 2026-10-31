import { describe, expect, it, vi } from "vitest";
import { interruptedTeamRun } from "./group-team-run-interrupted.js";

function fixture() {
  const db = {
    message: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "stop"
          ? { createdAt: new Date(100) }
          : { seq: 1, blocks: [{ kind: "text", text: " Original request " }] },
      ),
      findFirst: vi.fn(async () => null),
    },
    groupTeamRun: {
      findMany: vi.fn(async () => [{ id: "r1", originMessageId: "original" }]),
    },
  };
  const find = () => interruptedTeamRun(db as never, "thread", { id: "stop", seq: 3 });
  return { db, find };
}

describe("interrupted team request", () => {
  it("returns the same request for leader context and stop propagation", async () => {
    const { db, find } = fixture();
    expect(await find()).toEqual({
      id: "r1",
      originMessageId: "original",
      goal: "Original request",
    });
    expect(db.groupTeamRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread",
          status: "superseded",
          originMessageId: { not: "stop" },
          endedAt: { gte: new Date(100) },
        },
      }),
    );
  });

  it("does not cross an intervening human message", async () => {
    const { db, find } = fixture();
    db.message.findFirst.mockResolvedValueOnce({
      id: "follow-up",
      seq: 2,
      role: "user",
      botId: null,
      blocks: [],
    } as never);
    expect(await find()).toBeUndefined();
  });

  it("does not attribute a newer request to an older human message", async () => {
    const { db, find } = fixture();
    db.message.findUnique.mockResolvedValueOnce({ createdAt: new Date(100) } as never);
    db.message.findUnique.mockResolvedValueOnce({ seq: 4, blocks: [] } as never);
    expect(await find()).toBeUndefined();
    expect(db.message.findFirst).not.toHaveBeenCalled();
  });

  it("preserves an interrupted request with no text", async () => {
    const { db, find } = fixture();
    db.message.findUnique.mockResolvedValueOnce({ createdAt: new Date(100) } as never);
    db.message.findUnique.mockResolvedValueOnce({ seq: 1, blocks: [] } as never);
    expect(await find()).toMatchObject({ id: "r1", goal: " " });
  });

  it("ignores a missing anchor", async () => {
    const { db, find } = fixture();
    db.message.findUnique.mockResolvedValueOnce(null as never);
    expect(await find()).toBeUndefined();
    expect(db.groupTeamRun.findMany).not.toHaveBeenCalled();
  });
});
