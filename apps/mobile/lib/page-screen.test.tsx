// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  setOptions: vi.fn(),
  back: vi.fn(),
  share: vi.fn(),
  alert: vi.fn(),
  scrollTo: vi.fn(),
  layoutY: 0,
}));

vi.mock("./api", () => ({
  rpc: mocks.rpc,
  currentApiBase: () => "https://server.example.test",
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ pageId: "page-1", title: "Launch plan" }),
  useNavigation: () => ({ setOptions: mocks.setOptions }),
  useRouter: () => ({ back: mocks.back }),
}));
vi.mock("react-native", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  type Props = {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    onPress?: () => void;
    onLayout?: (event: { nativeEvent: { layout: { y: number } } }) => void;
  };
  const View = ({ children, onLayout, accessibilityLabel, accessibilityRole }: Props) => {
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
    Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
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
    StyleSheet: { create: (styles: unknown) => styles },
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
vi.mock("@rakazo/chat-ui/native", () => ({
  ChatMarkdown: ({ children }: { children: string }) =>
    createElement("rn-markdown", null, children),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
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
vi.mock("./native", () => ({
  native: { page: "page", label: "label", secondaryLabel: "secondary", fill: "fill" },
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "dark",
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));

import PageScreen from "../app/page";

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

let root: ReturnType<typeof createRoot>;
let header: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let headerContainer: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.layoutY = 0;
  for (const mock of [mocks.setOptions, mocks.back, mocks.alert, mocks.scrollTo]) mock.mockReset();
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
