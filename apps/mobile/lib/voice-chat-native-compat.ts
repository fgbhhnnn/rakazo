import type { EventSubscription } from "expo-modules-core";
import { requireOptionalNativeModule } from "expo-modules-core";

type VoiceChatNative = {
  takePendingVoiceChat(botId: string): boolean;
  addListener(event: "onPendingVoiceChat", listener: () => void): EventSubscription;
};

/** Shortcuts are unavailable until a binary ships both sides of the voice-chat bridge. */
export function getVoiceChatNative(): VoiceChatNative | null {
  const native = requireOptionalNativeModule<Partial<VoiceChatNative>>("RakazoVoiceChat");
  return typeof native?.takePendingVoiceChat === "function" &&
    typeof native.addListener === "function"
    ? (native as VoiceChatNative)
    : null;
}
