import { beforeEach, describe, expect, it, vi } from "vitest";
import { isNativeArgCountError, withLegacyArity } from "./native-arity-compat";

// The RakazoNotifications bridge as installed in app 1.0.7: four-argument setSettings/resume and no
// call service. Expo's Android bridge rejects extra arguments with this exact message.
const { legacy } = vi.hoisted(() => {
  const arity = (expected: number) =>
    vi.fn(async (...args: unknown[]): Promise<void> => {
      if (args.length > expected)
        throw new Error(`Received ${args.length} arguments, but ${expected} was expected`);
    });
  return {
    legacy: { setSettings: arity(4), resume: arity(3), stop: vi.fn(async () => undefined) },
  };
});

vi.mock("expo-modules-core", () => ({
  requireNativeModule: () => legacy,
  requireOptionalNativeModule: () => legacy,
}));
vi.mock("expo-notifications", () => ({ setNotificationHandler: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

const settings = { liveConnection: false } as never;
const endpoint = "https://rakazo.example.com";

describe("OTA on 1.0.7 native builds", () => {
  beforeEach(() => {
    legacy.setSettings.mockClear();
    legacy.resume.mockClear();
  });

  it("saves notification settings through the four-argument bridge", async () => {
    const { setLiveNotificationSettings } = await import("./live-notifications");
    await expect(
      setLiveNotificationSettings(settings, endpoint, "token", "space-1"),
    ).resolves.toBeUndefined();
    expect(legacy.setSettings).toHaveBeenCalledTimes(2);
    expect(legacy.setSettings.mock.calls[0]).toHaveLength(5);
    expect(legacy.setSettings.mock.calls[1]).toEqual([settings, endpoint, "token", "space-1"]);
  });

  it("resumes live notifications through the three-argument bridge", async () => {
    const { resumeLiveNotifications } = await import("./live-notifications");
    await expect(resumeLiveNotifications(endpoint, "token", "space-1")).resolves.toBeUndefined();
    expect(legacy.resume.mock.calls[1]).toEqual([endpoint, "token", "space-1"]);
  });

  it("reports no call service instead of calling a missing native function", async () => {
    const { startCallBackground, stopCallBackground } = await import("./call-background");
    await expect(startCallBackground("Ada")).resolves.toBe(false);
    await expect(stopCallBackground()).resolves.toBeUndefined();
  });
});

describe("withLegacyArity", () => {
  it("uses the current call when the native build accepts it", async () => {
    const legacyCall = vi.fn(async () => "old");
    await expect(withLegacyArity(async () => "new", legacyCall)).resolves.toBe("new");
    expect(legacyCall).not.toHaveBeenCalled();
  });

  it("rethrows any other native error", async () => {
    const legacyCall = vi.fn(async () => "old");
    await expect(
      withLegacyArity(async () => Promise.reject(new Error("token rejected")), legacyCall),
    ).rejects.toThrow("token rejected");
    expect(legacyCall).not.toHaveBeenCalled();
  });

  it("recognizes Expo's argument count errors only", () => {
    expect(
      isNativeArgCountError(
        new Error("Received 5 arguments, but 4 was expected and at least 4 is required"),
      ),
    ).toBe(true);
    expect(isNativeArgCountError(new Error("Method does not exist."))).toBe(false);
  });
});
