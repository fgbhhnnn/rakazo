import { afterEach, describe, expect, it, vi } from "vitest";
import { backgroundWorkerSpawnKey } from "./background-tasks.js";
import { defersTerminalCheckpoint } from "./worker-checkpoint.js";

describe("defersTerminalCheckpoint", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lets a background worker reply before the slow workspace export", () => {
    expect(defersTerminalCheckpoint({ spawnKey: backgroundWorkerSpawnKey("bot", 1) })).toBe(true);
  });

  it("keeps the checkpoint for ordinary bots and spawned children", () => {
    expect(defersTerminalCheckpoint({ spawnKey: null })).toBe(false);
    expect(defersTerminalCheckpoint({})).toBe(false);
    expect(defersTerminalCheckpoint({ spawnKey: "spawn:run:1" })).toBe(false);
  });

  it("keeps the checkpoint when idle sleep is off, since nothing would checkpoint later", () => {
    vi.stubEnv("SANDBOX_IDLE_MS", "0");
    expect(defersTerminalCheckpoint({ spawnKey: backgroundWorkerSpawnKey("bot", 1) })).toBe(false);
  });
});
