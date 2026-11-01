import { afterEach, describe, expect, it, vi } from "vitest";
import { DispatcherTurnTimeout } from "./dispatcher-mode.js";
import { dispatcherTimeoutNotice, dispatcherWatchdogTimeout } from "./dispatcher-timeout-label.js";

describe("dispatcher timeout label", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("records the limit that actually fired (the cap), not the idle limit", () => {
    const controller = new AbortController();
    controller.abort(new DispatcherTurnTimeout(600_000));
    const timeout = dispatcherWatchdogTimeout(controller.signal);
    expect(timeout.message).toBe("The reply took longer than 600 s and was stopped.");
    expect(dispatcherTimeoutNotice(new Error("Request was aborted"), controller.signal)).toBe(
      "回复超时（超过 600 秒），已重试仍未完成。请再发一次消息。",
    );
  });

  it("keeps a thrown timeout's own limit and falls back to the idle limit", () => {
    expect(dispatcherTimeoutNotice(new DispatcherTurnTimeout(90_000), undefined)).toContain(
      "超过 90 秒",
    );
    const fallback = dispatcherWatchdogTimeout(new AbortController().signal);
    expect(fallback).toBeInstanceOf(DispatcherTurnTimeout);
    expect(fallback.ms).toBeGreaterThan(0);
  });
});
