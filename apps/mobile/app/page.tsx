import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown, useNativeLinkConfirm } from "@rakazo/chat-ui/native";
import type { Page, PageDetail } from "@rakazo/contracts";
import { pageLayout } from "@rakazo/contracts";
import { pageCopyRequest, pageCopyResult, pageLinkRequest, pageReplyText } from "@rakazo/core";
import { typeScale, webTokensForAppearance } from "@rakazo/ui-tokens";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSymbol } from "../components/native-symbol";
import { PageLoadFailure } from "../components/pages/page-load-failure";
import { SandboxedHtmlPreview } from "../components/sandboxed-html-preview";
import { SheetCloseButton } from "../components/sheet-close-button";
import { currentApiBase } from "../lib/api";
import { dateLocaleForUi } from "../lib/i18n";
import { native, useMobileTokens, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { HEADER_CONTROL_SIZE } from "../lib/native-controls";
import {
  getLatestPage,
  getPage,
  isPageConflict,
  offerPageReply,
  pageActionAllowed,
  pageChat,
  pageDocument,
  pageMessage,
  pageShareLink,
  pageTapStart,
  savePage,
  sectionScrollY,
} from "../lib/pages";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

type Loaded =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; page: PageDetail; document: string };

/** Existing report cards pass a title; interactive page cards open with just their id. */
export default function PageScreen() {
  const { title } = useLocalSearchParams<{ title?: string }>();
  return title === undefined ? <InteractivePageScreen /> : <ReportPageScreen />;
}

/** A page full screen: the page itself under a close button and a share button. */
function InteractivePageScreen() {
  const { pageId } = useLocalSearchParams<{ pageId: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const theme = useResolvedAppearance();
  // Pages paint the web palette's background; the screen around them matches it.
  const pageBackground = webTokensForAppearance(theme).background;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [reportId, setReportId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // iOS keeps the native glass button as it is; Android's bordered button becomes a card circle.
  const round =
    Platform.OS === "ios" ? undefined : [styles.round, { backgroundColor: tokens.card }];

  useEffect(() => {
    let active = true;
    // A tap on the page before it reloads is not one on the new page.
    tappedAt.current = null;
    setLoaded({ status: "loading" });
    void getLatestPage(pageId, { refresh: true })
      .then(async (page) => {
        // A report's shared link may arrive without the title its chat card passes.
        if ("markdown" in page && typeof page.markdown === "string") {
          if (active) setReportId(pageId);
          return;
        }
        const document = await pageDocument(
          currentApiBase(),
          page.code,
          theme,
          t`This page couldn't be shown.`,
          { reply: pageChat(page) !== null },
        );
        if (!active) return;
        setLoaded({ status: "ready", page, document });
      })
      .catch((error: unknown) => {
        if (active) setLoaded({ status: "error", error });
      });
    return () => {
      active = false;
    };
  }, [pageId, theme, t, attempt]);

  const openLink = useNativeLinkConfirm();
  // The app sees every touch on the WebView too (React Native's root handler, on iOS and Android),
  // and the page can't fake one.
  const tapStart = useRef<ReturnType<typeof pageTapStart>>(null);
  const tappedAt = useRef<number | null>(null);
  const receive = useCallback(
    (data: string, answer: (message: object) => void) => {
      if (!pageActionAllowed(tappedAt.current, Date.now())) return;
      const message = pageMessage(data) as { type?: unknown; text?: unknown } | null;
      const reply = message?.type === "rakazo-page:reply" ? pageReplyText(message.text) : null;
      const page = loaded.status === "ready" ? loaded.page : null;
      const chat = reply && page ? pageChat(page) : null;
      const url = pageLinkRequest(message);
      const copy = pageCopyRequest(message);
      if (!(reply && page && chat) && !url && !copy) return;
      // One tap, one action: anything else the page asks for after it waits for the next tap.
      tappedAt.current = null;
      if (reply && page && chat) {
        // Into the page's chat, as on the web: back to it when it is right under the page.
        offerPageReply(chat.threadKey, { text: reply, page: { id: page.id, title: page.title } });
        const state = navigation.getState();
        const below = state?.routes[state.index - 1];
        const params = below?.params as Record<string, unknown> | undefined;
        if (`/${below?.name}` === chat.pathname && params?.[chat.key] === chat.threadKey) {
          router.back();
        } else {
          router.replace({ pathname: chat.pathname, params: { [chat.key]: chat.threadKey } });
        }
      } else if (url) {
        openLink(url);
      } else if (copy) {
        void Clipboard.setStringAsync(copy.text)
          .catch(() => false)
          .then((ok) => answer(pageCopyResult(copy.id, ok !== false)));
      }
    },
    [openLink, loaded, navigation, router],
  );

  if (reportId === pageId) return <ReportPageScreen />;

  return (
    <View style={[styles.screen, { backgroundColor: pageBackground }]}>
      {loaded.status === "ready" ? (
        // The page starts below the round buttons; its own top padding keeps the title clear.
        <View
          style={[styles.screen, { paddingTop: insets.top + HEADER_CONTROL_SIZE }]}
          onTouchStart={({ nativeEvent }) => {
            // A second finger makes it a pinch.
            const { pageX, pageY, touches } = nativeEvent;
            tapStart.current = touches.length === 1 ? { pageX, pageY } : null;
          }}
          onTouchMove={({ nativeEvent }) => {
            tapStart.current = pageTapStart(tapStart.current, nativeEvent);
          }}
          onTouchEnd={({ nativeEvent }) => {
            if (pageTapStart(tapStart.current, nativeEvent)) tappedAt.current = Date.now();
          }}
          onTouchCancel={() => {
            tapStart.current = null;
          }}
        >
          <SandboxedHtmlPreview
            html={loaded.document}
            background={pageBackground}
            onMessage={receive}
          />
        </View>
      ) : loaded.status === "error" ? (
        <View style={styles.center}>
          <PageLoadFailure
            error={loaded.error}
            fallback={t`Could not load this page.`}
            gone={t`This page isn't available`}
            onRetry={() => setAttempt((count) => count + 1)}
          />
        </View>
      ) : (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.mutedForeground} />
        </View>
      )}
      <View pointerEvents="box-none" style={[styles.controls, { top: insets.top + 6 }]}>
        <NativeActionButton
          accessibilityLabel={t`Close`}
          icon={{ ios: "xmark", android: "close", size: 20 }}
          prominence="secondary"
          style={round}
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        />
        {loaded.status === "ready" ? (
          <NativeActionButton
            accessibilityLabel={t`Share`}
            icon={{ ios: "square.and.arrow.up", android: "share-outline", size: 20 }}
            prominence="secondary"
            style={round}
            onPress={() => router.push({ pathname: "/page-share", params: { pageId } })}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  controls: {
    position: "absolute",
    left: 12,
    right: 12,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  round: {
    width: HEADER_CONTROL_SIZE,
    minHeight: HEADER_CONTROL_SIZE,
    borderRadius: HEADER_CONTROL_SIZE / 2,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
});

type LoadState =
  | { status: "loading" }
  | { status: "ready"; page: Page }
  | { status: "error"; message: string };

const MONO_FONT = Platform.select({ ios: "Menlo", default: "monospace" });

function ReportPageScreen() {
  const { pageId, title: initialTitle } = useLocalSearchParams<{
    pageId: string;
    title?: string;
  }>();
  const navigation = useNavigation();
  const router = useRouter();
  const { t } = useLingui();
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
          setState({ status: "error", message: errorText(error, t`Could not open this page.`) });
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
      Alert.alert(t`Could not share this page`, errorText(error, t`Try again.`));
    }
  }

  async function save() {
    if (!page || draft === null || saving) return;
    if (!draft.trim()) {
      Alert.alert(t`A page can't be empty.`);
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
        t`Could not save this page`,
        isPageConflict(error)
          ? t`This page changed since you opened it. Close it and open it again to edit the latest version.`
          : errorText(error, t`Try again.`),
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
      headerShown: true,
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
              <Text style={styles.headerText}>{t`Cancel`}</Text>
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
                <Text style={[styles.headerText, styles.headerTextStrong]}>{t`Save`}</Text>
              )}
            </Pressable>
          </View>
        ) : page ? (
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t`Edit`}
              hitSlop={8}
              onPress={() => setDraft(page.markdown)}
              style={styles.headerButton}
            >
              <NativeSymbol ios="pencil" android="create-outline" size={19} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t`Share`}
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
          accessibilityLabel={t`Page markdown`}
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
      <Text style={styles.updated}>{t`Updated ${updated}`}</Text>
      {layout.contents.length > 1 ? (
        <View style={styles.contents} accessibilityRole="menu" accessibilityLabel={t`On this page`}>
          <Text style={styles.contentsLabel}>{t`On this page`}</Text>
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
