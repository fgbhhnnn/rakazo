import { getVoiceChatNative } from "./voice-chat-native-compat";

/** The "Start Voice Chat" Shortcuts action, which opens a bot's chat and asks it to call. */
const native = getVoiceChatNative();

/** True once, when the action asked to call this bot. */
export function takeShortcutVoiceChat(botId: string): boolean {
  return native?.takePendingVoiceChat(botId) ?? false;
}

/** Covers a chat that was already open when the action ran. */
export function onShortcutVoiceChat(listener: () => void): () => void {
  const subscription = native?.addListener("onPendingVoiceChat", listener);
  return () => subscription?.remove();
}
