import { typeScale } from "@rakazo/ui-tokens";
import { useRouter } from "expo-router";
import type { PressableProps } from "react-native";
import { Pressable, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { pageRoute } from "../lib/pages";
import { NativeSymbol } from "./native-symbol";

type PageCardProps = {
  pageId: string;
  title: string;
  snippet?: string;
  /** Long-press and accessibility actions from the message row. */
  pressableProps?: Omit<PressableProps, "onPress" | "style" | "children">;
  width?: number;
};

/** A bot's report or plan in chat: the title and a preview, opening the full page. */
export function PageCard({ pageId, title, snippet, pressableProps, width }: PageCardProps) {
  const router = useRouter();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  return (
    <Pressable
      {...pressableProps}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={t("Opens the page")}
      onPress={() => router.push(pageRoute({ pageId, title }))}
      style={({ pressed }) => ({
        width,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 12,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: pressed ? tokens.accent : tokens.card,
        paddingHorizontal: 14,
        paddingVertical: 12,
      })}
    >
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <NativeSymbol
          ios="doc.richtext"
          android="document-text-outline"
          size={19}
          color={tokens.mutedForeground}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={2}
          style={{ color: tokens.foreground, ...typeScale.secondary, fontWeight: "600" }}
        >
          {title}
        </Text>
        {snippet ? (
          <Text
            numberOfLines={2}
            style={{ color: tokens.mutedForeground, ...typeScale.caption, marginTop: 3 }}
          >
            {snippet}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
