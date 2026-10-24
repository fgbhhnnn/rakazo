import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { loadMessagePage, shouldForwardPeerThreadEvent } from "./thread-message-pages.js";

const card = {
  kind: "child_bot",
  botId: "worker-2",
  name: "后台任务：斐波那契20万项 #TJ0TX4IZ",
  title: "任务 #TJ0TX4IZ · 点开看实时进度",
  status: "created",
};

describe("task cards posted by a relay (bot_message) run", () => {
  it("stay on normal pages while the run's activity is dropped", async () => {
    const rows = [
      { id: "activity", blocks: [{ kind: "steps", steps: [{ label: "Tool", count: 1 }] }] },
      { id: "card", blocks: [card] },
    ].map((row, index) => ({
      ...row,
      threadId: "thread-1",
      seq: 2 - index,
      role: "bot",
      botId: "dispatcher",
      replyToMessageId: null,
      runId: "run-relay",
      createdAt: new Date("2026-10-24T06:57:12.000Z"),
    }));
    const prisma = {
      message: { findMany: vi.fn(async () => rows) },
      run: { findMany: vi.fn(async () => [{ id: "run-relay", trigger: "bot_message" }]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages.map((message) => message.id)).toEqual(["card"]);
    expect(page.messages[0]?.blocks).toEqual([card]);
  });

  it.each(["thread.message.created", "thread.message.updated"])(
    "reach an open thread live (%s)",
    (type) => {
      expect(shouldForwardPeerThreadEvent({ type, payload: { blocks: [card] } })).toBe(true);
    },
  );
});
