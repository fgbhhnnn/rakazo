import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Modal, SafeAreaView, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import {
  artifactFileUri,
  type MobileArtifactTarget,
  openMobileArtifact,
} from "../lib/artifact-open";
import { useI18n } from "../lib/i18n";
import { iosAtLeast } from "../lib/native-controls";
import { errorText } from "../lib/user-error";
import { FileKindIcon } from "./file-kind-icon";
import { FileViewerBody } from "./file-viewer";
import { GlassIconButton } from "./glass-icon-button";

export type FileArtifactViewerTarget = { artifactId: string; name: string; mimeType: string };

/** Full-screen in-app view of a chat attachment, with share (save / open in another app) kept at hand. */
export function FileArtifactViewer({
  threadTarget,
  target,
  onClose,
}: {
  threadTarget: MobileArtifactTarget;
  target: FileArtifactViewerTarget;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const [file, setFile] = useState<{ uri: string } | { error: string } | null>(null);
  const botId = "botId" in threadTarget ? threadTarget.botId : undefined;
  const groupId = "groupId" in threadTarget ? threadTarget.groupId : undefined;

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    const scope: MobileArtifactTarget = botId !== undefined ? { botId } : { groupId: groupId! };
    void artifactFileUri(scope, target.artifactId, target.mimeType)
      .then((uri) => !cancelled && setFile({ uri }))
      .catch(
        (error: unknown) =>
          !cancelled && setFile({ error: errorText(error, t("Could not load this file.")) }),
      );
    return () => {
      cancelled = true;
    };
  }, [botId, groupId, target.artifactId, target.mimeType]);

  return (
    <Modal animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
        <View
          style={{
            height: 54,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            borderBottomWidth: iosAtLeast(26) ? 0 : 1,
            borderBottomColor: tokens.border,
            paddingHorizontal: 12,
          }}
        >
          <FileKindIcon name={target.name} mimeType={target.mimeType} size={30} />
          <Text
            numberOfLines={1}
            style={{ flex: 1, color: tokens.foreground, fontSize: 15, fontWeight: "500" }}
          >
            {target.name}
          </Text>
          <GlassIconButton
            accessibilityLabel={t("Share {name}", { name: target.name })}
            ios="square.and.arrow.up"
            android="share-social-outline"
            onPress={() =>
              void openMobileArtifact(
                threadTarget,
                target.artifactId,
                target.name,
                target.mimeType,
              ).catch((error) =>
                Alert.alert(t("Could not share file"), errorText(error, t("Try again."))),
              )
            }
          />
          <GlassIconButton
            accessibilityLabel={t("Close preview")}
            ios="xmark"
            android="close"
            onPress={onClose}
          />
        </View>
        {file === null ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator
              color={tokens.mutedForeground}
              accessibilityLabel={t("Loading preview…")}
            />
          </View>
        ) : "error" in file ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
            <Text style={{ color: tokens.destructive, fontSize: 15 }}>{file.error}</Text>
          </View>
        ) : (
          <FileViewerBody uri={file.uri} name={target.name} mimeType={target.mimeType} />
        )}
      </SafeAreaView>
    </Modal>
  );
}
