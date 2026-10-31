import { requireOptionalNativeModule } from "expo-modules-core";
import type { SharePayload } from "expo-sharing";

type NativeIncomingShare = {
  getSharedPayloads?: () => SharePayload[];
  clearSharedPayloads?: () => void;
};

/** OTA updates must also run on binaries without incoming-share native methods. */
export function getSharedPayloads(): SharePayload[] {
  try {
    const sharing = requireOptionalNativeModule<NativeIncomingShare>("ExpoSharing");
    return typeof sharing?.getSharedPayloads === "function" ? sharing.getSharedPayloads() : [];
  } catch {
    return [];
  }
}

export function clearSharedPayloads(): void {
  try {
    const sharing = requireOptionalNativeModule<NativeIncomingShare>("ExpoSharing");
    if (typeof sharing?.clearSharedPayloads === "function") sharing.clearSharedPayloads();
  } catch {
    // An unavailable native bridge must not break navigation or share cancellation.
  }
}
