// @vitest-environment jsdom

import type { ComponentType } from "react";
import { act, lazy, Suspense } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const plugins = vi.hoisted(() => ({ onOpenMcp: undefined as undefined | (() => void) }));

vi.mock("../../components/ErrorBoundary", () => ({
  lazyOverlay: <P extends object>(load: () => Promise<ComponentType<P>>) => {
    const Loaded = lazy(async () => ({ default: await load() }));
    return (props: P) => (
      <Suspense fallback={null}>
        <Loaded {...props} />
      </Suspense>
    );
  },
}));
vi.mock("../PluginsOverlay", () => ({
  PluginsOverlay: (props: { onOpenMcp?: () => void }) => {
    plugins.onOpenMcp = props.onOpenMcp;
    return <div data-testid="plugins-overlay" />;
  },
}));
vi.mock("../McpServersOverlay", () => ({
  McpServersOverlay: () => <div data-testid="mcp-overlay" />,
}));
vi.mock("../../lib/query", () => ({ queryClient: {} }));

import { AppOverlays } from "./shell-overlays";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  plugins.onOpenMcp = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(overlay: Parameters<typeof AppOverlays>[0]["overlay"], locked: boolean) {
  const setOverlay = vi.fn();
  await act(async () =>
    root.render(
      <AppOverlays
        overlay={overlay}
        setOverlay={setOverlay}
        activeBotId="bot-1"
        stdioEnabled={false}
        memberSettingsLocked={locked}
        onConnectedAppsChange={() => undefined}
      />,
    ),
  );
  // Let the lazy overlay modules settle.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return setOverlay;
}

it("lets an unlocked member open their MCP servers from integrations", async () => {
  const setOverlay = await render({ kind: "integrations" }, false);
  expect(container.querySelector('[data-testid="plugins-overlay"]')).not.toBeNull();
  plugins.onOpenMcp?.();
  expect(setOverlay).toHaveBeenCalledWith({ kind: "mcp" });

  await render({ kind: "mcp" }, false);
  expect(container.querySelector('[data-testid="mcp-overlay"]')).not.toBeNull();
});

it("gives a locked member no way into MCP servers, even from a direct link", async () => {
  await render({ kind: "integrations" }, true);
  expect(container.querySelector('[data-testid="plugins-overlay"]')).not.toBeNull();
  expect(plugins.onOpenMcp).toBeUndefined();

  await render({ kind: "mcp" }, true);
  expect(container.querySelector('[data-testid="mcp-overlay"]')).toBeNull();
});
