// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CHAT_CARD_RADIUS } from "./chat-card-shell";

const push = vi.hoisted(() => vi.fn());
vi.mock("expo-router", () => ({ useRouter: () => ({ push }) }));
vi.mock("react-native", () => {
  type Props = {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
    style?: unknown;
  };
  return {
    Pressable: ({ children, accessibilityLabel, onPress, style }: Props) => {
      const styleFor = (pressed: boolean) =>
        JSON.stringify(typeof style === "function" ? style({ pressed }) : style);
      return createElement(
        "rn-pressable",
        {
          "aria-label": accessibilityLabel,
          onClick: onPress,
          "data-style": styleFor(false),
          "data-pressed-style": styleFor(true),
        },
        children,
      );
    },
    Text: ({ children }: Props) => createElement("rn-text", null, children),
    View: ({ children }: Props) => createElement("rn-view", null, children),
  };
});
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios }: { ios: string }) => createElement("rn-symbol", { "data-ios": ios }),
}));
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
}));
vi.mock("./pages", () => ({
  pageRoute: ({ pageId }: { pageId: string }) => `/pages/${pageId}`,
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (message: string) => message }) }));

import { PageCard } from "../components/page-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let unmount: () => void = () => undefined;
afterEach(() => {
  unmount();
  push.mockReset();
});

function mount(props: Parameters<typeof PageCard>[0]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<PageCard {...props} />));
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
  expect(push).toHaveBeenCalledExactlyOnceWith("/pages/page-1");
});

it("takes the page background inside a message bubble, whose muted fill matches the card", () => {
  const card = mount({ pageId: "page-1", title: "Weekly report", inBubble: true });
  const style = JSON.parse(card.dataset.style!) as Record<string, unknown>;
  expect(style).toMatchObject({ borderRadius: CHAT_CARD_RADIUS, backgroundColor: "page-bg" });
  expect(style).not.toHaveProperty("borderWidth");
  expect(JSON.parse(card.dataset.pressedStyle!).backgroundColor).toBe("accent");
});
