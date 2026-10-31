import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DISPATCHER_TURN_HARD_CAP_DEFAULT_MS,
  dispatcherTurnHardCapMs,
  startDispatcherIdleWatchdog,
} from "./dispatcher-idle-watchdog.js";
import { DispatcherTurnTimeout, startDispatcherWatchdog } from "./dispatcher-mode.js";

// A dispatcher turn used to be cut off 90 s after it started, even while the model was still
// streaming (slow image turns hit it on every retry). It now stops only a turn that went quiet,
// plus an absolute ceiling.

afterEach(() => {
  vi.useRealTimers();
});

describe("dispatcher idle watchdog", () => {
  it("keeps a turn that makes progress alive past the idle limit", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onFire = vi.fn();
    const watchdog = startDispatcherIdleWatchdog(
      controller,
      onFire,
      1_000,
      10_000,
      (ms) => new DispatcherTurnTimeout(ms),
    );
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(900);
      watchdog.touch();
    }
    expect(controller.signal.aborted).toBe(false);
    expect(onFire).not.toHaveBeenCalled();
    watchdog();
  });

  it("stops a turn that goes quiet for the idle limit", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onFire = vi.fn();
    const watchdog = startDispatcherIdleWatchdog(
      controller,
      onFire,
      1_000,
      10_000,
      (ms) => new DispatcherTurnTimeout(ms),
    );
    vi.advanceTimersByTime(500);
    watchdog.touch();
    vi.advanceTimersByTime(999);
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledOnce();
    expect(controller.signal.reason).toBeInstanceOf(DispatcherTurnTimeout);
    expect((controller.signal.reason as Error).message).toBe(
      "The reply took longer than 1 s and was stopped.",
    );
  });

  it("stops a turn at the absolute cap however steadily it streams", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onFire = vi.fn();
    const watchdog = startDispatcherIdleWatchdog(
      controller,
      onFire,
      1_000,
      5_000,
      (ms) => new DispatcherTurnTimeout(ms),
    );
    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(500);
      watchdog.touch();
    }
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(500);
    expect(onFire).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
    // Late progress after the stop changes nothing.
    watchdog.touch();
    vi.advanceTimersByTime(5_000);
    expect(onFire).toHaveBeenCalledOnce();
  });

  it("never fires once cleared or once the turn was aborted elsewhere", () => {
    vi.useFakeTimers();
    const cleared = new AbortController();
    const onFire = vi.fn();
    const watchdog = startDispatcherIdleWatchdog(cleared, onFire, 1_000, 5_000, () => new Error());
    watchdog();
    watchdog.touch();
    vi.advanceTimersByTime(10_000);
    expect(cleared.signal.aborted).toBe(false);

    const aborted = new AbortController();
    startDispatcherIdleWatchdog(aborted, onFire, 1_000, 5_000, () => new Error());
    aborted.abort();
    vi.advanceTimersByTime(10_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("startDispatcherWatchdog uses the idle limit and still clears like before", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onFire = vi.fn();
    const clear = startDispatcherWatchdog(controller, onFire, 1_000);
    vi.advanceTimersByTime(800);
    clear.touch();
    vi.advanceTimersByTime(800);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onFire).toHaveBeenCalledOnce();
    expect(controller.signal.reason).toBeInstanceOf(DispatcherTurnTimeout);
  });

  it("reads the absolute cap from the environment, never below the idle limit", () => {
    expect(dispatcherTurnHardCapMs(90_000, {})).toBe(DISPATCHER_TURN_HARD_CAP_DEFAULT_MS);
    expect(DISPATCHER_TURN_HARD_CAP_DEFAULT_MS).toBe(300_000);
    expect(dispatcherTurnHardCapMs(90_000, { RAKAZO_DISPATCHER_TURN_HARD_CAP_MS: "600000" })).toBe(
      600_000,
    );
    expect(dispatcherTurnHardCapMs(90_000, { RAKAZO_DISPATCHER_TURN_HARD_CAP_MS: "60000" })).toBe(
      90_000,
    );
    expect(dispatcherTurnHardCapMs(90_000, { RAKAZO_DISPATCHER_TURN_HARD_CAP_MS: "abc" })).toBe(
      300_000,
    );
    expect(dispatcherTurnHardCapMs(90_000, { RAKAZO_DISPATCHER_TURN_HARD_CAP_MS: "10" })).toBe(
      300_000,
    );
  });
});
