import { fileKindOf, filePreviewMarkdown, hasInAppFileViewer } from "@rakazo/chat-ui/file-kinds";
import { ChatMarkdown } from "@rakazo/chat-ui/native";
import { File } from "expo-file-system";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";
import { DocumentWebView } from "./document-webview";
import { SandboxedHtmlPreview } from "./sandboxed-html-preview";

type FileRef = { name?: string | null; mimeType?: string | null };

/** Files the mobile viewer opens in the app: the shared document kinds plus sandboxed HTML pages. */
export function hasMobileFileViewer(file: FileRef): boolean {
  return hasInAppFileViewer(file) || fileKindOf(file).viewer === "html";
}

/** The in-app view of a file already on disk (a cached artifact). */
export function FileViewerBody({
  uri,
  name,
  mimeType,
}: {
  uri: string;
  name: string;
  mimeType: string;
}) {
  const kind = fileKindOf({ name, mimeType });
  if (kind.viewer === "pdf" || kind.viewer === "spreadsheet" || kind.viewer === "docx") {
    return <DocumentWebView uri={uri} name={name} viewer={kind.viewer} />;
  }
  return (
    <TextFile
      uri={uri}
      html={kind.viewer === "html"}
      render={(text) => filePreviewMarkdown(kind, text)}
    />
  );
}

function TextFile({
  uri,
  html,
  render,
}: {
  uri: string;
  html: boolean;
  render: (text: string) => string;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const colorScheme = useResolvedAppearance();
  const [text, setText] = useState<string | null | Error>(null);
  useEffect(() => {
    let cancelled = false;
    setText(null);
    void new File(uri)
      .text()
      .then((value) => !cancelled && setText(value.replace(/^\uFEFF/, "")))
      .catch(
        (error: unknown) =>
          !cancelled && setText(error instanceof Error ? error : new Error(String(error))),
      );
    return () => {
      cancelled = true;
    };
  }, [uri]);
  if (text === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator
          color={tokens.mutedForeground}
          accessibilityLabel={t("Loading preview…")}
        />
      </View>
    );
  }
  if (text instanceof Error) {
    return (
      <View style={styles.center}>
        <Text style={{ color: tokens.mutedForeground, fontSize: 15 }}>
          {t("Could not load this file.")}
        </Text>
      </View>
    );
  }
  if (html) return <SandboxedHtmlPreview html={text} />;
  return (
    <ScrollView contentContainerStyle={styles.text} contentInsetAdjustmentBehavior="automatic">
      <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
        {render(text)}
      </ChatMarkdown>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  text: { paddingHorizontal: 20, paddingVertical: 24 },
});
