import { type FileIcon, fileKindOf } from "@rakazo/chat-ui/file-kinds";
import type { ComponentProps } from "react";
import { Text, View } from "react-native";
import { NativeSymbol } from "./native-symbol";

type Symbol = Pick<ComponentProps<typeof NativeSymbol>, "ios" | "android">;

/** SF Symbol / Ionicons per shared file icon (colors and badges come from @rakazo/chat-ui/file-kinds). */
export const FILE_ICON_SYMBOLS: Record<FileIcon, Symbol> = {
  pdf: { ios: "doc.richtext", android: "document-text" },
  sheet: { ios: "tablecells", android: "grid" },
  doc: { ios: "doc.text", android: "document-text" },
  slides: { ios: "rectangle.on.rectangle", android: "easel" },
  text: { ios: "doc.plaintext", android: "document-outline" },
  markdown: { ios: "text.alignleft", android: "reader" },
  json: { ios: "curlybraces", android: "code-slash" },
  html: { ios: "globe", android: "globe-outline" },
  archive: { ios: "doc.zipper", android: "archive" },
  code: { ios: "chevron.left.forwardslash.chevron.right", android: "code-slash" },
  audio: { ios: "waveform", android: "musical-notes" },
  video: { ios: "film", android: "film" },
  image: { ios: "photo", android: "image" },
  file: { ios: "doc", android: "document" },
};

/** A tinted tile with the file type's icon and, from 28pt up, its colored type badge (PDF, XLSX, …). */
export function FileKindIcon({
  name,
  mimeType,
  size = 36,
}: {
  name?: string | null;
  mimeType?: string | null;
  size?: number;
}) {
  const kind = fileKindOf({ name, mimeType });
  const symbol = FILE_ICON_SYMBOLS[kind.icon];
  return (
    <View
      accessibilityLabel={kind.badge}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.24,
        backgroundColor: `${kind.color}1F`,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <NativeSymbol
        ios={symbol.ios}
        android={symbol.android}
        size={size * 0.5}
        color={kind.color}
      />
      {size >= 28 ? (
        <View
          style={{
            position: "absolute",
            bottom: -3,
            right: -5,
            borderRadius: 4,
            backgroundColor: kind.color,
            paddingHorizontal: 3,
            paddingVertical: 1,
          }}
        >
          <Text
            style={{ color: "#fff", fontSize: Math.max(7, size * 0.22), fontWeight: "700" }}
            numberOfLines={1}
          >
            {kind.badge}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
