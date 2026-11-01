import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { DispatcherTurnTimeout } from "./dispatcher-mode.js";
import {
  DISPATCHER_RETRY_ENTRY_CHARS,
  DISPATCHER_RETRY_HISTORY_ENTRIES,
  isDispatcherTimeoutRetry,
  lightenDispatcherRetryHistory,
} from "./dispatcher-retry-context.js";

type History = AgentRunRequest["history"];

const entry = (i: number, content = `message ${i}`, withImage = false): History[number] => ({
  id: `m${i}`,
  createdAt: "1970-01-01T00:00:00.000Z",
  role: i % 2 ? "assistant" : "user",
  content,
  ...(withImage
    ? { images: [{ name: `p${i}.png`, mimeType: "image/png" as const, data: new Uint8Array(4) }] }
    : {}),
});

function prismaWithError(error: string | null) {
  return { run: { findUnique: vi.fn(async () => (error === undefined ? null : { error })) } };
}

describe("dispatcher timeout retry detection", () => {
  it("is a timeout retry only when the failed run was stopped by the watchdog", async () => {
    const timedOut = prismaWithError(new DispatcherTurnTimeout(90_000).message);
    expect(await isDispatcherTimeoutRetry(timedOut as never, { retryOfRunId: "r0" })).toBe(true);
    expect(timedOut.run.findUnique).toHaveBeenCalledWith({
      where: { id: "r0" },
      select: { error: true },
    });

    const other = prismaWithError("The model returned no reply.");
    expect(await isDispatcherTimeoutRetry(other as never, { retryOfRunId: "r0" })).toBe(false);
    const missing = { run: { findUnique: vi.fn(async () => null) } };
    expect(await isDispatcherTimeoutRetry(missing as never, { retryOfRunId: "r0" })).toBe(false);
  });

  it("does not look anything up for a first attempt", async () => {
    const prisma = prismaWithError(null);
    expect(await isDispatcherTimeoutRetry(prisma as never, { retryOfRunId: null })).toBe(false);
    expect(prisma.run.findUnique).not.toHaveBeenCalled();
  });
});

describe("lightening a retried dispatcher turn", () => {
  it("drops every image and keeps only the newest entries", () => {
    const history = Array.from({ length: 30 }, (_, i) => entry(i, undefined, i % 3 === 0));
    const light = lightenDispatcherRetryHistory(history);
    expect(light).toHaveLength(DISPATCHER_RETRY_HISTORY_ENTRIES);
    expect(light.map((item) => item.id)).toEqual(history.slice(-12).map((item) => item.id));
    expect(light.some((item) => "images" in item)).toBe(false);
    // The input is not mutated.
    expect(history[0]?.images).toHaveLength(1);
  });

  it("keeps pinned leading context and shortens long entries from the end", () => {
    const long = `start ${"x".repeat(5_000)} the actual question`;
    const history = [entry(0, "summary"), ...Array.from({ length: 20 }, (_, i) => entry(i + 1))];
    history[20] = entry(20, long);
    const light = lightenDispatcherRetryHistory(history, { pinned: 1 });
    expect(light[0]?.content).toBe("summary");
    expect(light).toHaveLength(1 + DISPATCHER_RETRY_HISTORY_ENTRIES);
    const last = light.at(-1)?.content ?? "";
    expect(last.length).toBe(DISPATCHER_RETRY_ENTRY_CHARS);
    expect(last.startsWith("…[trimmed for the retry]")).toBe(true);
    expect(last.endsWith("the actual question")).toBe(true);
  });

  it("leaves short histories intact apart from images", () => {
    const history = [entry(0, "hi", true), entry(1, "hello")];
    expect(lightenDispatcherRetryHistory(history)).toEqual([
      { id: "m0", createdAt: "1970-01-01T00:00:00.000Z", role: "user", content: "hi" },
      { id: "m1", createdAt: "1970-01-01T00:00:00.000Z", role: "assistant", content: "hello" },
    ]);
  });
});
