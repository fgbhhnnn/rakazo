import { describe, expect, it, vi } from "vitest";
import { provisionWhenNotBusy } from "./computer-busy-retry.js";
import { ComputerBusyError } from "./computer-lifecycle.js";

describe("provisionWhenNotBusy", () => {
  it("waits out a sibling's boot instead of failing the tool call", async () => {
    const provision = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ComputerBusyError())
      .mockRejectedValueOnce(new ComputerBusyError())
      .mockResolvedValue("computer");
    await expect(provisionWhenNotBusy(provision, { pollMs: 1, waitMs: 1_000 })).resolves.toBe(
      "computer",
    );
    expect(provision).toHaveBeenCalledTimes(3);
  });

  it("gives up with ComputerBusyError after the wait, so the run still requeues", async () => {
    const provision = vi.fn(async () => {
      throw new ComputerBusyError();
    });
    await expect(provisionWhenNotBusy(provision, { pollMs: 5, waitMs: 20 })).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect(provision.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not retry other errors", async () => {
    const provision = vi.fn(async () => {
      throw new Error("provider down");
    });
    await expect(provisionWhenNotBusy(provision, { pollMs: 1 })).rejects.toThrow("provider down");
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the run is cancelled", async () => {
    const controller = new AbortController();
    const provision = vi.fn(async () => {
      throw new ComputerBusyError();
    });
    const waiting = provisionWhenNotBusy(provision, {
      signal: controller.signal,
      pollMs: 10_000,
      waitMs: 60_000,
    });
    setTimeout(() => controller.abort(new Error("cancelled")), 5);
    await expect(waiting).rejects.toThrow("cancelled");
  });
});
