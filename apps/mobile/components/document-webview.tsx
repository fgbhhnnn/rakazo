import { File } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { mobileTokens } from "../lib/appearance";
import { documentViewerHtml } from "../lib/document-viewer-assets";
import { useI18n } from "../lib/i18n";
import type { ViewerKind, ViewerMessage } from "../viewers/host";

/**
 * A PDF, spreadsheet or .docx rendered inside the app by an offline viewer page (pdf.js, SheetJS,
 * mammoth) in a WebView. The page has no network (CSP default-src 'none'), no file access and no
 * navigation; the file's bytes are handed over in memory once the page has loaded.
 */
export function DocumentWebView({
  uri,
  name,
  viewer,
}: {
  uri: string;
  name: string;
  viewer: ViewerKind;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const webview = useRef<WebView>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void documentViewerHtml(viewer === "pdf" ? "pdf" : "office")
      .then((page) => !cancelled && setHtml(page))
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, [viewer]);

  async function onMessage(event: WebViewMessageEvent) {
    let message: ViewerMessage;
    try {
      message = JSON.parse(event.nativeEvent.data) as ViewerMessage;
    } catch {
      return;
    }
    if (message.type === "error") return setState("error");
    if (message.type === "ready")
      return setState((current) => (current === "error" ? current : "ready"));
    try {
      const request = { viewer, name, base64: await new File(uri).base64() };
      webview.current?.injectJavaScript(`window.rakazoOpen(${JSON.stringify(request)});true;`);
    } catch {
      setState("error");
    }
  }

  return (
    <View style={styles.container}>
      {html && state !== "error" ? (
        <WebView
          ref={webview}
          source={{ html, baseUrl: "about:blank" }}
          originWhitelist={["about:*"]}
          style={styles.webview}
          onMessage={(event) => void onMessage(event)}
          javaScriptEnabled
          domStorageEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          setSupportMultipleWindows={false}
          thirdPartyCookiesEnabled={false}
          sharedCookiesEnabled={false}
          mixedContentMode="never"
          cacheEnabled={false}
          setBuiltInZoomControls
          setDisplayZoomControls={false}
          onShouldStartLoadWithRequest={({ url }) =>
            url === "about:blank" || url === "about:blank/"
          }
        />
      ) : null}
      {state === "loading" ? (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <ActivityIndicator
            color={tokens.mutedForeground}
            accessibilityLabel={t("Loading preview…")}
          />
        </View>
      ) : null}
      {state === "error" ? (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Text style={{ color: tokens.mutedForeground, fontSize: 15, textAlign: "center" }}>
            {t("Could not preview this file. Share it to open it in another app.")}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1, backgroundColor: "#f2f2f7" },
  center: { alignItems: "center", justifyContent: "center", padding: 24 },
});
