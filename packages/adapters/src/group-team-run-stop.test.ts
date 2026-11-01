import { describe, expect, it, vi } from "vitest";
import {
  endTeamRunAndCancel,
  refuseStoppedTeamRunWork,
  stoppedTeamRunForWork,
  teamRunOwningWork,
  teamWorkMustStop,
} from "./group-team-run-stop.js";

function fixture(status = "stopped") {
  const team = {
    id: "team",
    groupId: "group",
    threadId: "thread",
    originMessageId: "origin",
    status,
  };
  const runs: Record<string, Record<string, unknown>> = {
    leader: {
      id: "leader",
      botId: "planner",
      threadId: "thread",
      thread: { groupId: "group" },
      sourceMessageId: "origin",
    },
    writer: {
      id: "writer",
      threadId: "thread",
      sourceMessage: { clientNonce: "group-handoff:leader" },
    },
    retry: { id: "retry", retryOfRunId: "writer" },
    worker: { id: "worker", sourceMessage: { clientNonce: "bot-message:bgtask:task:1" } },
    relay: {
      id: "relay",
      sourceMessage: { blocks: [{ kind: "bot_message_received", returnToMessageId: "outbound" }] },
    },
    question: {
      id: "question",
      threadId: "thread",
      sourceMessage: { clientNonce: "group-question:writer" },
    },
    hold: { id: "hold", sourceMessage: { runId: "writer" } },
    unrelated: { id: "unrelated", botId: "planner", threadId: "thread" },
    private: {
      id: "private",
      threadId: "private",
      thread: { groupId: null },
      sourceMessageId: "origin",
    },
    otherGroup: {
      id: "otherGroup",
      threadId: "other-thread",
      sourceMessage: { clientNonce: "group-handoff:leader" },
    },
    loop: { id: "loop", retryOfRunId: "loop" },
  };
  const db = {
    run: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => runs[where.id] ?? null),
    },
    groupTeamRun: { findUnique: vi.fn(async () => team) },
    chatGroupMember: { findUnique: vi.fn(async () => ({ botId: "planner" })) },
    backgroundTaskQueue: { findUnique: vi.fn(async () => ({ runId: "writer" })) },
    message: { findUnique: vi.fn(async () => ({ runId: "worker" })) },
  };
  return { db, team };
}

describe("team work provenance", () => {
  it.each(["leader", "writer", "retry", "worker", "relay", "question", "hold"])(
    "follows %s to its original team",
    async (id) => {
      const { db, team } = fixture();
      expect(await teamRunOwningWork(db as never, id)).toEqual(team);
    },
  );
  it.each(["unrelated", "private", "otherGroup", "loop", "missing"])(
    "does not attribute %s to the team",
    async (id) => {
      const { db } = fixture();
      expect(await teamRunOwningWork(db as never, id)).toBeUndefined();
    },
  );
  it("requires the direct origin recipient to belong to the group", async () => {
    const { db } = fixture();
    db.chatGroupMember.findUnique.mockResolvedValueOnce(null as never);
    expect(await teamRunOwningWork(db as never, "leader")).toBeUndefined();
  });
  it("recognizes legacy posted reminders by their source nonce", async () => {
    const { db, team } = fixture();
    db.run.findUnique.mockResolvedValueOnce({
      id: "legacy-nudge",
      botId: "planner",
      threadId: "thread",
      sourceMessage: { clientNonce: "team-nudge:team:leader" },
    });
    expect(await stoppedTeamRunForWork(db as never, "legacy-nudge")).toEqual(team);
  });
  it.each(["active", "completed", "paused", "answered", "superseded"])(
    "does not block %s work",
    async (status) => {
      const { db } = fixture(status);
      expect(await stoppedTeamRunForWork(db as never, "writer")).toBeUndefined();
      expect(teamWorkMustStop(status)).toBe(false);
    },
  );
  it.each(["stopped"])("blocks %s work without interpreting human text", async (status) => {
    const { db, team } = fixture(status);
    expect(await stoppedTeamRunForWork(db as never, "writer")).toEqual(team);
  });
});

describe("stopped work fast path", () => {
  const context = { threadId: "thread", createdAt: new Date(), groupId: "group" };

  it("does not read the database for a private turn", async () => {
    expect(
      await refuseStoppedTeamRunWork({} as never, "private", { ...context, groupId: null }),
    ).toBe(false);
  });

  it("only probes once when there is no relevant stopped team run", async () => {
    const db = { $queryRaw: vi.fn(async () => []), run: { findUnique: vi.fn() } };
    expect(await refuseStoppedTeamRunWork(db as never, "leader", context)).toBe(false);
    expect(db.$queryRaw).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      context.threadId,
      context.createdAt,
      "leader",
    );
    expect(db.run.findUnique).not.toHaveBeenCalled();
  });

  it("checks provenance when the probe finds a possible stop", async () => {
    const { db } = fixture("superseded");
    const prisma = { ...db, $queryRaw: vi.fn(async () => [{ id: "other-stopped-team" }]) };
    expect(await refuseStoppedTeamRunWork(prisma as never, "writer", context)).toBe(false);
    expect(db.run.findUnique).toHaveBeenCalled();
  });

  it("does not cancel member runs or background work on supersession", async () => {
    const db = {
      $queryRaw: vi.fn(),
      groupTeamRun: {
        findUnique: vi.fn(async () => ({ threadId: "thread" })),
        updateManyAndReturn: vi.fn(async () => [
          { id: "team", threadId: "thread", originMessageId: "origin" },
        ]),
      },
      run: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
      backgroundTaskQueue: { updateMany: vi.fn() },
      message: { findMany: vi.fn(async () => []) },
    };
    expect(await endTeamRunAndCancel(db as never, "team", "superseded", "human_message")).toBe(
      true,
    );
    // Existing stale-reminder/recheck cleanup still runs; linked work cancellation does not.
    expect(db.run.findMany).toHaveBeenCalledTimes(2);
    expect(db.run.updateMany).not.toHaveBeenCalled();
    expect(db.backgroundTaskQueue.updateMany).not.toHaveBeenCalled();
  });
});
