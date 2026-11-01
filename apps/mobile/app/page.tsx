import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { Page } from "@rakazo/contracts";
import { pageLayout } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { NativeSymbol } from "../components/native-symbol";
import { SheetCloseButton } from "../components/sheet-close-button";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { native, useMobileTokens, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { getPage, isPageConflict, pageShareLink, savePage, sectionScrollY } from "../lib/pages";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; page: Page }
  | { status: "error"; message: string };

const MONO_FONT = Platform.select({ ios: "Menlo", default: "monospace" });

export default function PageScreen() {
  const { pageId, title: initialTitle } = useLocalSearchParams<{
    pageId: string;
    title?: string;
  }>();
  const navigation = useNavigation();
  const router = useRouter();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const styles = useThemedStyles(createStyles);
  const sideInsets = useSideInsets();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const scroller = useRef<ScrollView>(null);
  const bodyTop = useRef(0);
  const sectionOffsets = useRef(new Map<string, number>());

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void getPage(pageId)
      .then((page) => {
        if (!cancelled) setState({ status: "ready", page });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setState({ status: "error", message: errorText(error, t("Could not open this page.")) });
      });
    return () => {
      cancelled = true;
    };
  }, [pageId, t]);

  const page = state.status === "ready" ? state.page : null;
  const layout = useMemo(() => (page ? pageLayout(page.markdown, page.title) : null), [page]);

  function jumpTo(sectionId: string) {
    const y = sectionScrollY(sectionOffsets.current, sectionId, bodyTop.current);
    if (y !== null) scroller.current?.scrollTo({ y, animated: true });
  }

  async function share() {
    const link = pageShareLink(pageId);
    try {
      await Share.share(
        Platform.OS === "ios"
          ? { url: link, title: page?.title }
          : { message: link, title: page?.title },
      );
    } catch (error) {
      Alert.alert(t("Could not share this page"), errorText(error, t("Try again.")));
    }
  }

  async function save() {
    if (!page || draft === null || saving) return;
    if (!draft.trim()) {
      Alert.alert(t("A page can't be empty."));
      return;
    }
    setSaving(true);
    try {
      const saved = await savePage({ pageId, markdown: draft, baseVersion: page.version });
      sectionOffsets.current.clear();
      setState({ status: "ready", page: saved });
      setDraft(null);
    } catch (error) {
      Alert.alert(
        t("Could not save this page"),
        isPageConflict(error)
          ? t(
              "This page changed since you opened it. Close it and open it again to edit the latest version.",
            )
          : errorText(error, t("Try again.")),
      );
    } finally {
      setSaving(false);
    }
  }

  const saveRef = useRef(save);
  saveRef.current = save;
  const shareRef = useRef(share);
  shareRef.current = share;

  useLayoutEffect(() => {
    navigation.setOptions({
      title: page?.title ?? initialTitle ?? "",
      headerLeft: () => <SheetCloseButton onPress={() => router.back()} />,
      headerRight: () =>
        draft !== null ? (
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              disabled={saving}
              onPress={() => setDraft(null)}
              style={styles.headerButton}
            >
              <Text style={styles.headerText}>{t("Cancel")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              disabled={saving}
              onPress={() => void saveRef.current()}
              style={styles.headerButton}
            >
              {saving ? (
                <ActivityIndicator color={native.secondaryLabel} />
              ) : (
                <Text style={[styles.headerText, styles.headerTextStrong]}>{t("Save")}</Text>
              )}
            </Pressable>
          </View>
        ) : page ? (
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Edit")}
              hitSlop={8}
              onPress={() => setDraft(page.markdown)}
              style={styles.headerButton}
            >
              <NativeSymbol ios="pencil" android="create-outline" size={19} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Share")}
              hitSlop={8}
              onPress={() => void shareRef.current()}
              style={styles.headerButton}
            >
              <NativeSymbol ios="square.and.arrow.up" android="share-social-outline" size={19} />
            </Pressable>
          </View>
        ) : null,
    });
  }, [draft, initialTitle, navigation, page, router, saving, styles, t]);

  if (state.status === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={native.secondaryLabel} />
      </View>
    );
  }
  if (state.status === "error" || !page || !layout) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{state.status === "error" ? state.message : ""}</Text>
      </View>
    );
  }
  if (draft !== null) {
    return (
      <View style={[styles.screen, sideInsets]}>
        <TextInput
          accessibilityLabel={t("Page markdown")}
          value={draft}
          onChangeText={setDraft}
          multiline
          autoFocus
          textAlignVertical="top"
          autoCapitalize="sentences"
          style={styles.editor}
          editable={!saving}
        />
      </View>
    );
  }

  const updated = new Date(page.updatedAt).toLocaleString(dateLocaleForUi(), {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <ScrollView
      ref={scroller}
      style={[styles.screen, sideInsets]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Text style={styles.title} accessibilityRole="header">
        {page.title}
      </Text>
      <Text style={styles.updated}>{t("Updated {date}", { date: updated })}</Text>
      {layout.contents.length > 1 ? (
        <View
          style={styles.contents}
          accessibilityRole="menu"
          accessibilityLabel={t("On this page")}
        >
          <Text style={styles.contentsLabel}>{t("On this page")}</Text>
          {layout.contents.map((section) => (
            <Pressable
              key={section.id}
              accessibilityRole="link"
              onPress={() => jumpTo(section.id)}
              style={({ pressed }) => [
                styles.contentsRow,
                { paddingLeft: 10 + section.depth * 14 },
                pressed ? { backgroundColor: native.fillPressed } : null,
              ]}
            >
              <Text numberOfLines={1} style={styles.contentsText}>
                {section.title}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View
        style={styles.body}
        onLayout={(event) => {
          bodyTop.current = event.nativeEvent.layout.y;
        }}
      >
        {layout.intro ? (
          <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
            {layout.intro}
          </ChatMarkdown>
        ) : null}
        {layout.sections.map((section, index) => (
          <View
            key={section.id}
            style={index === 0 && !layout.intro ? null : styles.section}
            onLayout={(event) => {
              sectionOffsets.current.set(section.id, event.nativeEvent.layout.y);
            }}
          >
            <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
              {section.markdown}
            </ChatMarkdown>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      backgroundColor: native.page,
    },
    errorText: { color: native.secondaryLabel, fontSize: 14, textAlign: "center" },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 4 },
    headerButton: { padding: 8 },
    headerText: { color: native.label, ...typeScale.body },
    headerTextStrong: { fontWeight: "600" },
    content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 64 },
    title: { color: native.label, fontSize: 28, lineHeight: 34, fontWeight: "700" },
    updated: { color: native.secondaryLabel, ...typeScale.footnote, marginTop: 6 },
    contents: {
      marginTop: 18,
      paddingVertical: 10,
      paddingHorizontal: 6,
      borderRadius: 14,
      backgroundColor: native.fill,
    },
    contentsLabel: {
      color: native.secondaryLabel,
      ...typeScale.footnote,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.4,
      paddingHorizontal: 10,
      paddingBottom: 4,
    },
    contentsRow: { paddingVertical: 7, paddingRight: 10, borderRadius: 8 },
    contentsText: { color: native.label, ...typeScale.secondary },
    body: { marginTop: 22 },
    section: { marginTop: 22 },
    editor: {
      flex: 1,
      color: native.label,
      fontFamily: MONO_FONT,
      fontSize: 14,
      lineHeight: 21,
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 32,
    },
  });
}
