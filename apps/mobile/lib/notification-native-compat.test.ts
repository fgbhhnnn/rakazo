import { describe, expect, it, vi } from "vitest";
import { withNotificationArity } from "./notification-native-compat";

describe("notification bridge compatibility", () => {
  it.each([4, 5, 6])("supports a setSettings bridge with %i arguments", async (arity) => {
    const args = [{ liveConnection: true }, "https://example.test", "token", "space", "de", "{}"];
    const call = vi.fn(async (...received: unknown[]) => {
      if (received.length !== arity)
        throw new Error(`Received ${received.length} arguments, but ${arity} was expected`);
      return "saved";
    });
    await expect(withNotificationArity(call, args)).resolves.toBe("saved");
    expect(call.mock.calls).toEqual(
      Array.from({ length: 7 - arity }, (_, index) => args.slice(0, args.length - index)),
    );
  });

  it.each([3, 4, 5])("supports a resume bridge with %i arguments", async (arity) => {
    const args = ["https://example.test", "token", "space", "de", "{}"];
    const call = vi.fn(async (...received: string[]) => {
      if (received.length !== arity)
        throw new Error(`Received ${received.length} arguments, but ${arity} was expected`);
    });
    await withNotificationArity(call, args);
    expect(call).toHaveBeenLastCalledWith(...args.slice(0, arity));
    expect(call).toHaveBeenCalledTimes(6 - arity);
  });

  it("does not retry a native failure unrelated to argument count", async () => {
    const call = vi.fn(async (..._args: string[]) => {
      throw new Error("poller failed");
    });
    await expect(
      withNotificationArity(call, ["server", "token", "space", "de", "{}"]),
    ).rejects.toThrow("poller failed");
    expect(call).toHaveBeenCalledTimes(1);
  });
});
