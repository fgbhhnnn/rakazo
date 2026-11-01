import { useMemo, useRef } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { parseTurnstileMessage, turnstileHtml } from "../lib/turnstile";

/** Cloudflare Turnstile check; reports a token, or null when it expires or fails. */
export function TurnstileWidget({
  siteKey,
  baseUrl,
  dark,
  onToken,
  onError,
}: {
  siteKey: string;
  /** Origin Cloudflare should see; must be a hostname allowed for this site key. */
  baseUrl: string;
  dark?: boolean;
  onToken: (token: string | null) => void;
  onError: (code: string | undefined) => void;
}) {
  const html = useMemo(() => turnstileHtml(siteKey, dark ? "dark" : "light"), [siteKey, dark]);
  const origin = useMemo(() => {
    try {
      return new URL(baseUrl).origin + "/";
    } catch {
      return baseUrl;
    }
  }, [baseUrl]);
  const handlers = useRef({ onToken, onError });
  handlers.current = { onToken, onError };
  return (
    <View style={{ height: 70, marginTop: 12, overflow: "hidden" }} testID="turnstile-widget">
      <WebView
        source={{ html, baseUrl: origin }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        style={{ backgroundColor: "transparent" }}
        onMessage={(event) => {
          const message = parseTurnstileMessage(event.nativeEvent.data);
          if (!message) return;
          if (message.type === "token") handlers.current.onToken(message.token);
          else {
            handlers.current.onToken(null);
            if (message.type === "error") handlers.current.onError(message.code);
          }
        }}
        onError={() => {
          handlers.current.onToken(null);
          handlers.current.onError("load");
        }}
      />
    </View>
  );
}
