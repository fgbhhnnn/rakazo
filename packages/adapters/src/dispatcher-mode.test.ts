import { describe, expect, it } from "vitest";
import {
  DISPATCHER_TOOL_NAMES,
  dispatcherModeEnabled,
  dispatcherTurnMaxMs,
  isDispatcherBot,
} from "./executor.js";

describe("dispatcher mode", () => {
  it("is on unless turned off", () => {
    expect(dispatcherModeEnabled({})).toBe(true);
    for (const v of ["0", "false", "off"]) {
      expect(dispatcherModeEnabled({ RAKAZO_DISPATCHER_MODE: v })).toBe(false);
    }
  });
  it("bounds the main-turn watchdog", () => {
    expect(dispatcherTurnMaxMs({})).toBe(90_000);
    expect(dispatcherTurnMaxMs({ RAKAZO_DISPATCHER_TURN_MAX_MS: "10" })).toBe(90_000);
  });
  it("covers user bots but never hidden workers", () => {
    expect(isDispatcherBot({ spawnKey: null, disabledBuiltinTools: [] })).toBe(true);
    expect(isDispatcherBot({ spawnKey: "bg-worker:b:1", disabledBuiltinTools: [] })).toBe(false);
    expect(isDispatcherBot({ spawnKey: null, disabledBuiltinTools: ["background_task"] })).toBe(
      false,
    );
  });
  it("gives the dispatcher only talk and dispatch tools", () => {
    for (const name of ["run_command", "generate_image", "computer", "list_files"]) {
      expect(DISPATCHER_TOOL_NAMES.has(name)).toBe(false);
    }
    expect(DISPATCHER_TOOL_NAMES.has("background_task_cancel")).toBe(true);
  });
});
