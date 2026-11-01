import { beforeEach, describe, expect, it, vi } from "vitest";

const { bridge } = vi.hoisted(() => ({ bridge: { native: null as unknown } }));
vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: vi.fn(() => bridge.native),
}));

describe("voice-chat native compatibility", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it.each([
    null,
    {},
    { takePendingVoiceChat: () => true },
    { addListener: () => ({ remove: () => undefined }) },
    { takePendingVoiceChat: true, addListener: true },
  ])("ignores shortcuts when the installed bridge is incomplete (%j)", async (native) => {
    bridge.native = native;
    const { takeShortcutVoiceChat, onShortcutVoiceChat } = await import("./voice-chat-intent");
    const listener = vi.fn();
    expect(takeShortcutVoiceChat("bot-1")).toBe(false);
    expect(() => onShortcutVoiceChat(listener)()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("consumes requests and unsubscribes through a complete native bridge", async () => {
    const remove = vi.fn();
    const listener = vi.fn();
    const native = {
      takePendingVoiceChat: vi.fn(function (this: unknown, botId: string) {
        expect(this).toBe(native);
        return botId === "bot-1";
      }),
      addListener: vi.fn(function (this: unknown, _event: string, onPending: () => void) {
        expect(this).toBe(native);
        onPending();
        return { remove };
      }),
    };
    bridge.native = native;
    const { takeShortcutVoiceChat, onShortcutVoiceChat } = await import("./voice-chat-intent");
    expect(takeShortcutVoiceChat("bot-1")).toBe(true);
    expect(takeShortcutVoiceChat("bot-2")).toBe(false);
    const unsubscribe = onShortcutVoiceChat(listener);
    expect(native.addListener).toHaveBeenCalledWith("onPendingVoiceChat", listener);
    expect(listener).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    unsubscribe();
    expect(remove).toHaveBeenCalledOnce();
  });
});
