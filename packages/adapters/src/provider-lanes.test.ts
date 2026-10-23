import { afterEach, describe, expect, it } from "vitest";
import {
  acquireProviderLane,
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

describe("worker model concurrency", () => {
  it("caps background model calls and never blocks main turns", async () => {
    const env = process.env.RAKAZO_WORKER_MODEL_CONCURRENCY;
    process.env.RAKAZO_WORKER_MODEL_CONCURRENCY = "2";
    try {
      const a = await acquireProviderLane("background");
      const b = await acquireProviderLane("background");
      let third = false;
      const pending = acquireProviderLane("background").then((release) => {
        third = true;
        return release;
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(third).toBe(false);
      const started = Date.now();
      (await acquireProviderLane("main"))();
      expect(Date.now() - started).toBeLessThan(50);
      a();
      const c = await pending;
      expect(third).toBe(true);
      b();
      c();
    } finally {
      if (env === undefined) delete process.env.RAKAZO_WORKER_MODEL_CONCURRENCY;
      else process.env.RAKAZO_WORKER_MODEL_CONCURRENCY = env;
    }
  });
});

describe("global model limiter", () => {
  it("serves waiting main turns before workers and keeps a slot for main", async () => {
    const saved = { ...process.env };
    process.env.RAKAZO_MODEL_MAX_CONCURRENCY = "3";
    process.env.RAKAZO_WORKER_MODEL_CONCURRENCY = "5";
    try {
      const w1 = await acquireProviderLane("background");
      const w2 = await acquireProviderLane("background");
      // Workers never take the last slot.
      let w3Started = false;
      const w3 = acquireProviderLane("background").then((r) => {
        w3Started = true;
        return r;
      });
      const m1 = await acquireProviderLane("main");
      await new Promise((r) => setTimeout(r, 30));
      expect(w3Started).toBe(false);
      // Full: a main turn waits, and gets the next free slot ahead of the waiting worker.
      let mainStarted = false;
      const m2 = acquireProviderLane("main").then((r) => {
        mainStarted = true;
        return r;
      });
      w1();
      await m2;
      expect(mainStarted).toBe(true);
      expect(w3Started).toBe(false);
      m1();
      (await m2)();
      (await w3)();
      w2();
    } finally {
      process.env = saved;
    }
  });
});
