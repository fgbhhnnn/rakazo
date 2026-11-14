// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_CARD_RADIUS } from "./chat-card-shell";

const host = vi.hoisted(() => ({
  detail: null as unknown,
  runtimeFails: false,
  pressed: [] as unknown[],
  press: undefined as (() => void) | undefined,
}));

const push = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({
  Pressable: ({
    children,
    onPress,
    onLayout,
    disabled,
    accessibilityLabel,
    style,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    style?: unknown;
  }) => {
    host.press = disabled ? undefined : onPress;
    useEffect(() => onLayout?.({ nativeEvent: { layout: { width: 320 } } }), [onLayout]);
    const styleFor = (pressed: boolean) =>
      JSON.stringify(typeof style === "function" ? style({ pressed }) : style);
    return createElement(
      "rn-pressable",
      {
        "aria-label": accessibilityLabel,
        onClick: disabled ? undefined : onPress,
        "data-style": styleFor(false),
        "data-pressed-style": styleFor(true),
      },
      children,
    );
  },
  Text: ({ children }: { children?: ReactNode }) => createElement("rn-text", {}, children),
  View: ({ children }: { children?: ReactNode }) => createElement("rn-view", {}, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("react-native-svg", () => ({
  default: () => null,
  Defs: () => null,
  LinearGradient: () => null,
  Rect: () => null,
  Stop: () => null,
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({
    push: (href: unknown) => {
      push(href);
      host.pressed.push(href);
    },
  }),
}));
vi.mock("@rakazo/chat-ui/native", () => ({ PageIcon: () => null }));
vi.mock("../components/sandboxed-html-preview", () => ({
  SandboxedHtmlPreview: () => createElement("iframe"),
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({ currentApiBase: () => "https://app.example", rpc: vi.fn() }));
vi.mock("./session", () => ({ registerSessionDiskCache: () => undefined }));
vi.mock("./page-runtime", () => ({ loadPageRuntime: async () => "" }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({
    accent: "accent",
    background: "page-bg",
    border: "border",
    card: "card",
    foreground: "fg",
    muted: "muted-fill",
    mutedForeground: "muted",
  }),
  useResolvedAppearance: () => "light",
}));
vi.mock("./page-card-detail", () => ({ usePageCardDetail: () => host.detail }));
vi.mock("./pages", async (original) => ({
  ...(await original<typeof import("./pages")>()),
  pageDocument: async () => {
    if (host.runtimeFails) throw new Error("Page runtime returned 503");
    return "<p>page</p>";
  },
}));

vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios }: { ios: string }) => createElement("rn-symbol", { "data-ios": ios }),
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (message: string) => message }) }));
const { PageCard } = await import("../components/pages/page-card");
const { PageCard: MarkdownPageCard } = await import("../components/page-card");

async function card() {
  const container = document.createElement("div");
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () =>
    root.render(
      createElement(PageCard, {
        block: { kind: "page", pageId: "page-1", version: 1, title: "Plan" },
        messageId: "m1",
      }),
    ),
  );
  return { container, unmount: () => act(() => root.unmount()) };
}

it("says a preview could not load instead of showing a blank card, and still opens the page", async () => {
  host.detail = { id: "page-1", title: "Plan", code: "code", currentVersion: 1 };
  host.runtimeFails = true;
  const failed = await card();
  expect(failed.container.textContent).toContain("This page couldn't load");
  host.press?.();
  expect(host.pressed).toEqual([{ pathname: "/page", params: { pageId: "page-1" } }]);
  failed.unmount();

  // A page whose details could not be read says the same.
  host.detail = "failed";
  const unread = await card();
  expect(unread.container.textContent).toContain("This page couldn't load");
  unread.unmount();

  host.detail = { id: "page-1", title: "Plan", code: "code", currentVersion: 1 };
  host.runtimeFails = false;
  const shown = await card();
  expect(shown.container.textContent).not.toContain("couldn't load");
  shown.unmount();
});

it("drops a shown preview when a refresh of the page fails", async () => {
  host.runtimeFails = false;
  host.detail = { id: "page-1", title: "Plan", code: "code", currentVersion: 1 };
  const container = document.createElement("div");
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const render = () =>
    act(async () =>
      root.render(
        createElement(PageCard, {
          block: { kind: "page", pageId: "page-1", version: 1, title: "Plan" },
          messageId: "m1",
        }),
      ),
    );
  await render();
  expect(container.querySelector("iframe")).not.toBeNull();

  host.detail = "failed";
  await render();
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.textContent).toContain("This page couldn't load");

  // A newer version whose preview cannot build drops the older one too.
  host.detail = { id: "page-1", title: "Plan", code: "code", currentVersion: 1 };
  await render();
  expect(container.querySelector("iframe")).not.toBeNull();
  host.runtimeFails = true;
  host.detail = { id: "page-1", title: "Plan", code: "code-2", currentVersion: 2 };
  await render();
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.textContent).toContain("This page couldn't load");
  act(() => root.unmount());
});

describe("editable Markdown page cards", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  let unmount: () => void = () => undefined;
  afterEach(() => {
    unmount();
    push.mockReset();
  });

  function mount(props: Parameters<typeof MarkdownPageCard>[0]) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<MarkdownPageCard {...props} />));
    unmount = () => {
      act(() => root.unmount());
      container.remove();
    };
    return container.querySelector<HTMLElement>('rn-pressable[aria-label="Weekly report"]')!;
  }

  it("draws the borderless chat-card shell at the width it is given, highlighting on press", () => {
    const card = mount({
      pageId: "page-1",
      title: "Weekly report",
      snippet: "Revenue grew.",
      width: 331,
    });
    const style = JSON.parse(card.dataset.style!) as Record<string, unknown>;
    const pressed = JSON.parse(card.dataset.pressedStyle!) as Record<string, unknown>;
    expect(style).toMatchObject({
      width: 331,
      borderRadius: CHAT_CARD_RADIUS,
      backgroundColor: "card",
    });
    expect(pressed.backgroundColor).toBe("accent");
    for (const shell of [style, pressed]) {
      expect(shell).not.toHaveProperty("borderWidth");
      expect(shell).not.toHaveProperty("borderColor");
    }
    expect(card.querySelector('rn-symbol[data-ios="chevron.right"]')).toBeNull();
    expect(card.textContent).toBe("Weekly reportRevenue grew.");
  });

  it("opens the page when tapped", () => {
    mount({ pageId: "page-1", title: "Weekly report" }).click();
    expect(push).toHaveBeenCalledExactlyOnceWith({
      pathname: "/page",
      params: { pageId: "page-1", title: "Weekly report" },
    });
  });

  it("takes the page background inside a message bubble, whose muted fill matches the card", () => {
    const card = mount({ pageId: "page-1", title: "Weekly report", inBubble: true });
    const style = JSON.parse(card.dataset.style!) as Record<string, unknown>;
    expect(style).toMatchObject({ borderRadius: CHAT_CARD_RADIUS, backgroundColor: "page-bg" });
    expect(style).not.toHaveProperty("borderWidth");
    expect(JSON.parse(card.dataset.pressedStyle!).backgroundColor).toBe("accent");
  });
});
