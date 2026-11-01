import { StyleSheet, Text, View } from "react-native";
import { useComposerDictation } from "../lib/composer-dictation";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

export function ComposerDictateButton({
  onText,
  disabled,
}: {
  onText: (text: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const dictation = useComposerDictation(onText, disabled);
  if (!dictation.available) return null;
  return (
    <View style={styles.control}>
      {dictation.notice || dictation.listening ? (
        <View
          style={[styles.preview, { backgroundColor: tokens.card, borderColor: tokens.border }]}
        >
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: dictation.notice ? tokens.destructive : tokens.foreground }}
          >
            {dictation.notice || dictation.transcript || t("Listening…")}
          </Text>
        </View>
      ) : null}
      <NativeActionButton
        accessibilityLabel={dictation.listening ? t("Stop dictation") : t("Dictate")}
        icon={
          dictation.listening
            ? { ios: "stop.fill", android: "stop", size: 16 }
            : { ios: "mic", android: "mic-outline", size: 16 }
        }
        prominence="quiet"
        disabled={disabled}
        selected={dictation.listening}
        onPress={() => void dictation.toggle()}
        style={styles.button}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  control: { marginBottom: 8 },
  button: { width: 32, height: 28, alignItems: "center", justifyContent: "center" },
  preview: {
    position: "absolute",
    bottom: 40,
    end: 0,
    width: 220,
    padding: 8,
    borderWidth: 1,
    borderRadius: 8,
  },
});
