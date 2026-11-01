import { beforeEach, describe, expect, it, vi } from "vitest";

// App 1.0.8 accepts locale but predates custom headers. Match Expo's native arity rejection.
const { native } = vi.hoisted(() => {
  const arity = (expected: number) =>
    vi.fn(async (...args: unknown[]): Promise<void> => {
      if (args.length !== expected) {
        throw new Error(`Received ${args.length} arguments, but ${expected} was expected`);
      }
    });
  return { native: { setSettings: arity(5), resume: arity(4) } };
});

vi.mock("expo-modules-core", () => ({ requireNativeModule: () => native }));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: async () => ({ granted: true }),
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("./i18n", () => ({ getActiveUiLocale: () => "de", t: (text: string) => text }));
vi.mock("./server-headers", () => ({ serverHeaders: () => ({ "X-Test-Access": "fake-value" }) }));

import { resumeLiveNotifications, setLiveNotificationSettings } from "./live-notifications";

describe("OTA on the shipped 1.0.8 Android bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const endpoint = "https://app.example.test";
  const headers = JSON.stringify({ "X-Test-Access": "fake-value" });

  it("saves enabled notifications with locale through the five-argument bridge", async () => {
    const settings = {
      liveConnection: true,
      messages: true,
      scheduledTasks: true,
      needsAttention: false,
    };
    await expect(
      setLiveNotificationSettings(settings, endpoint, "fake-token", "space-1"),
    ).resolves.toBeUndefined();
    expect(native.setSettings.mock.calls).toEqual([
      [settings, endpoint, "fake-token", "space-1", "de", headers],
      [settings, endpoint, "fake-token", "space-1", "de"],
    ]);
  });

  it("resumes through the four-argument bridge without losing the locale", async () => {
    await expect(
      resumeLiveNotifications(`${endpoint}/api/`, "fake-token", "space-1"),
    ).resolves.toBeUndefined();
    expect(native.resume.mock.calls).toEqual([
      [endpoint, "fake-token", "space-1", "de", headers],
      [endpoint, "fake-token", "space-1", "de"],
    ]);
  });
});
