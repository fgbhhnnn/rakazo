import { afterEach, describe, expect, it, vi } from "vitest";
import { startDispatcherIdleWatchdog } from "./dispatcher-idle-watchdog.js";
import { DispatcherTurnTimeout, startDispatcherWatchdog } from "./dispatcher-mode.js";
import {
  DISPATCHER_MODEL_WAIT_DEFAULT_MS,
  dispatcherModelWaitMs,
  streamActivityKindOf,
} from "./dispatcher-model-wait.js";

// Reasoning models think silently before their first token (60–90 s and more in production), so
// a live dispatcher turn was cut off at the 90 s idle limit and retried from scratch. A pending
// model call now gets a longer wait; output brings the normal idle limit back.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const start = (onFire = vi.fn(), modelWaitMs?: number) => {
  const controller = new AbortController();
  const watchdog = startDispatcherIdleWatchdog(
    controller,
    onFire,
    1_000,
    10_000,
    (ms) => new DispatcherTurnTimeout(ms),
    modelWaitMs === undefined ? undefined : { modelWaitMs },
  );
  return { controller, watchdog, onFire };
};

describe("dispatcher model wait", () => {
  it("defaults to 3 minutes, within the idle limit and the hard cap", () => {
    expect(DISPATCHER_MODEL_WAIT_DEFAULT_MS).toBe(180_000);
    expect(dispatcherModelWaitMs(90_000, 300_000, {})).toBe(180_000);
    expect(
      dispatcherModelWaitMs(90_000, 300_000, { RAKAZO_DISPATCHER_MODEL_WAIT_MAX_MS: "240000" }),
    ).toBe(240_000);
    // Never shorter than the idle limit, never longer than the hard cap.
    expect(
      dispatcherModelWaitMs(90_000, 300_000, { RAKAZO_DISPATCHER_MODEL_WAIT_MAX_MS: "10000" }),
    ).toBe(90_000);
    expect(dispatcherModelWaitMs(90_000, 120_000, {})).toBe(120_000);
    for (const bad of ["", "abc", "-1", "100"]) {
      expect(
        dispatcherModelWaitMs(90_000, 300_000, { RAKAZO_DISPATCHER_MODEL_WAIT_MAX_MS: bad }),
      ).toBe(180_000);
    }
  });

  it("classifies agent events", () => {
    expect(streamActivityKindOf("turn_start")).toBe("model_wait");
    expect(streamActivityKindOf("message_start")).toBe("model_wait");
    for (const type of [
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ]) {
      expect(streamActivityKindOf(type)).toBe("output");
    }
    expect(streamActivityKindOf("agent_start")).toBeUndefined();
    expect(streamActivityKindOf("turn_end")).toBeUndefined();
  });

  it("lets a turn waiting on the model stay silent past the idle limit", () => {
    vi.useFakeTimers();
    const { controller, watchdog, onFire } = start(vi.fn(), 5_000);
    watchdog.touch("model_wait");
    vi.advanceTimersByTime(4_900);
    expect(controller.signal.aborted).toBe(false);
    // The first token arrives: the normal idle limit applies again.
    watchdog.touch("output");
    vi.advanceTimersByTime(999);
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(2);
    expect(onFire).toHaveBeenCalledOnce();
    expect(controller.signal.reason).toBeInstanceOf(DispatcherTurnTimeout);
  });

  it("still stops a model call that never answers within the wait", () => {
    vi.useFakeTimers();
    const { controller, watchdog, onFire } = start(vi.fn(), 5_000);
    watchdog.touch("model_wait");
    vi.advanceTimersByTime(5_001);
    expect(onFire).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
  });

  it("keeps the current window for activity without a kind", () => {
    vi.useFakeTimers();
    const { controller, watchdog } = start(vi.fn(), 5_000);
    watchdog.touch("model_wait");
    vi.advanceTimersByTime(3_000);
    watchdog.touch();
    vi.advanceTimersByTime(4_900);
    expect(controller.signal.aborted).toBe(false);
    watchdog();
  });

  it("starts in the idle window: setup before the first model call keeps the idle limit", () => {
    vi.useFakeTimers();
    const { controller } = start(vi.fn(), 5_000);
    vi.advanceTimersByTime(1_001);
    expect(controller.signal.aborted).toBe(true);
  });

  it("never outlasts the hard cap", () => {
    vi.useFakeTimers();
    const { controller, watchdog } = start(vi.fn(), 50_000);
    for (let i = 0; i < 4; i++) {
      watchdog.touch("model_wait");
      vi.advanceTimersByTime(2_400);
    }
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(500);
    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as DispatcherTurnTimeout).message).toContain("10");
  });

  it("without a model wait behaves as before", () => {
    vi.useFakeTimers();
    const { controller, watchdog } = start();
    watchdog.touch("model_wait");
    vi.advanceTimersByTime(1_001);
    expect(controller.signal.aborted).toBe(true);
  });

  it("the dispatcher watchdog applies the configured model wait", () => {
    vi.useFakeTimers();
    vi.stubEnv("RAKAZO_DISPATCHER_TURN_MAX_MS", "5000");
    vi.stubEnv("RAKAZO_DISPATCHER_MODEL_WAIT_MAX_MS", "20000");
    vi.stubEnv("RAKAZO_DISPATCHER_TURN_HARD_CAP_MS", "60000");
    const controller = new AbortController();
    const watchdog = startDispatcherWatchdog(controller, vi.fn());
    watchdog.touch("model_wait");
    vi.advanceTimersByTime(19_000);
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1_001);
    expect(controller.signal.aborted).toBe(true);
  });
});
