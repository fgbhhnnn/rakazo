import { afterEach, describe, expect, it } from "vitest";
import {
  isProviderConcurrencyLimit,
  noteProviderConcurrencyLimit,
  noteProviderOk,
  resetProviderLanesForTest,
  waitForProviderLane,
  workerPauseRemainingMs,
} from "./provider-lanes.js";

afterEach(() => resetProviderLanesForTest());

describe("provider lanes", () => {
  it("recognises the provider concurrency limit", () => {
    expect(
      isProviderConcurrencyLimit({
        errorMessage: "Concurrency limit exceeded for account, please retry later",
      }),
    ).toBe(true);
    expect(isProviderConcurrencyLimit(new Error("context length exceeded"))).toBe(false);
  });

  it("pauses background workers with a growing backoff, never main turns", async () => {
    const now = Date.now();
    noteProviderConcurrencyLimit(now);
    const first = workerPauseRemainingMs(now);
    noteProviderConcurrencyLimit(now);
    expect(first).toBe(5_000);
    expect(workerPauseRemainingMs(now)).toBe(10_000);
    const started = Date.now();
    await waitForProviderLane("main");
    expect(Date.now() - started).toBeLessThan(50);
    const abort = new AbortController();
    const waiting = waitForProviderLane("background", abort.signal);
    abort.abort();
    await waiting;
    noteProviderOk();
  });
});
