import type { SharePayload } from "expo-sharing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSharedPayloads, getSharedPayloads } from "./native-incoming-share";

const native = vi.hoisted(() => ({ require: vi.fn() }));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: native.require }));

beforeEach(() => {
  native.require.mockReset();
});

describe("native incoming-share compatibility", () => {
  it.each([null, {}, { shareAsync: vi.fn() }])(
    "ignores absent incoming-share native APIs (%j)",
    (module) => {
      native.require.mockReturnValue(module);
      expect(getSharedPayloads()).toEqual([]);
      expect(() => clearSharedPayloads()).not.toThrow();
      expect(native.require).toHaveBeenCalledWith("ExpoSharing");
    },
  );

  it("checks each native method before calling it", () => {
    native.require.mockReturnValue({ getSharedPayloads: true, clearSharedPayloads: true });
    expect(getSharedPayloads()).toEqual([]);
    expect(() => clearSharedPayloads()).not.toThrow();
  });

  it("preserves supported payloads and clears native state", () => {
    const payloads: SharePayload[] = [
      { value: "https://example.com", shareType: "url", mimeType: "text/plain" },
      { value: "content://media/1", shareType: "image", mimeType: "image/png" },
    ];
    const module = {
      payloads,
      getSharedPayloads() {
        return this.payloads;
      },
      clearSharedPayloads: vi.fn(),
    };
    native.require.mockReturnValue(module);
    expect(getSharedPayloads()).toBe(payloads);
    clearSharedPayloads();
    expect(module.clearSharedPayloads).toHaveBeenCalledOnce();
  });

  it("returns no payloads when the native plugin has received no share", () => {
    native.require.mockReturnValue({ getSharedPayloads: () => [], clearSharedPayloads: vi.fn() });
    expect(getSharedPayloads()).toEqual([]);
  });

  it("ignores native-module lookup failures", () => {
    native.require.mockImplementation(() => {
      throw new Error("Native bridge unavailable");
    });
    expect(getSharedPayloads()).toEqual([]);
    expect(() => clearSharedPayloads()).not.toThrow();
  });

  it("ignores native read and clear failures", () => {
    const unavailable = () => {
      throw new Error("Native method unavailable");
    };
    native.require.mockReturnValue({
      getSharedPayloads: unavailable,
      clearSharedPayloads: unavailable,
    });
    expect(getSharedPayloads()).toEqual([]);
    expect(() => clearSharedPayloads()).not.toThrow();
  });
});
