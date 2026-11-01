import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { isBuiltinToolName } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { browserSnapshotFromTool } from "./browser-tools.js";
import { builtinAgentTools } from "./builtin-tools.js";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { pageBrowserRecoveryGuidance } from "./page-browser-recovery-prompt.js";
import { PAGE_BROWSER_RECOVERY_SOURCE } from "./page-browser-recovery-source.js";
import { PAGE_BROWSER_TOOL_NAMES } from "./run-tool-selection.js";
import { pageBrowserTool } from "./run-tools-computer.js";

it("checks timeout recovery, one retry, partial mutations and profile restart with offline CDP doubles", () => {
  const tests = fileURLToPath(
    new URL("../../../infra/sandboxes/computer/test_page_browser_recovery.py", import.meta.url),
  );
  expect(() => execFileSync("python3", [tests], { timeout: 10_000, stdio: "pipe" })).not.toThrow();
});

it("embeds exactly the recovery module shipped on Docker computers", () => {
  expect(PAGE_BROWSER_RECOVERY_SOURCE).toBe(
    readFileSync(
      new URL("../../../infra/sandboxes/computer/rakazo_page_browser_recovery.py", import.meta.url),
      "utf8",
    ),
  );
});

const computer: ComputerRef = { id: "c1", botId: "b1", kind: "e2b", providerRef: "c1" };
const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "s",
  userId: "u",
  signal: new AbortController().signal,
};

describe("browser_restart", () => {
  it("is offered and uses the sandbox-owned browser command", async () => {
    expect(isBuiltinToolName("browser_restart")).toBe(true);
    expect(PAGE_BROWSER_TOOL_NAMES.has("browser_restart")).toBe(true);
    expect(builtinAgentTools.find((tool) => tool.name === "browser_restart")).toBeDefined();
    const liveDriver = vi.fn(async () => ({ ok: true, url: "about:blank", title: "" }));
    const browser = new ComputerBrowserProvider({ liveDriver });
    expect(await browser.restart(computer, context)).toMatchObject({ ok: true });
    expect(liveDriver).toHaveBeenCalledWith(computer, { command: "restart" }, context);
  });

  it.each(["takeover", "teaching", "free"])("respects screen ownership: %s", async (mode) => {
    const restart = vi.fn(async () => ({ ok: true }));
    const dirty = vi.fn();
    const get = vi.fn(async () => computer);
    const ctx = {
      deps: {
        prisma: {
          taughtSkill: { findFirst: async () => (mode === "teaching" ? { id: "skill" } : null) },
        },
      },
      run: { spaceId: "s", botId: "b1" },
      bot: { id: "b1" },
      context,
      computer: { heldForTakeover: mode === "takeover", checkpoint: { markDirty: dirty }, get },
      providers: { browser: { restart } },
      secrets: new Set<string>(),
      state: { screen: { unchangedVisualStreak: { count: 3 } } },
    };
    const result = await pageBrowserTool(
      ctx as never,
      { name: "browser_restart", args: {}, finish: async (value: unknown) => value } as never,
    );
    expect(restart).toHaveBeenCalledTimes(mode === "free" ? 1 : 0);
    expect(dirty).toHaveBeenCalledTimes(mode === "free" ? 1 : 0);
    expect(get).toHaveBeenCalledTimes(mode === "free" ? 1 : 0);
    if (mode !== "free") expect(result).toHaveProperty("error");
    else expect(ctx.state.screen.unchangedVisualStreak.count).toBe(0);
  });
});

it("adds login recovery guidance only when those tools are available", () => {
  expect(pageBrowserRecoveryGuidance(false)).toBeUndefined();
  expect(pageBrowserRecoveryGuidance(true, new Set(["browser_act"]))).toBeUndefined();
  expect(pageBrowserRecoveryGuidance(true)).toContain(
    "After two consecutive page-browser timeouts, call browser_restart",
  );
  expect(pageBrowserRecoveryGuidance(true)).toContain("fill_secret cannot see that browser");
  expect(pageBrowserRecoveryGuidance(true, new Set(["browser_restart"]))).not.toContain(
    "call browser_restart",
  );
});

it.each([true, false])(
  "keeps timeout fallback advice on browser restart (desktop tools: %s)",
  async (desktopTools) => {
    const browser = new FakeBrowserProvider();
    browser.forceFallback =
      "Page browser timed out and could not recover. Call browser_restart before continuing.";
    const result = await browserSnapshotFromTool(browser, computer, context, {}, { desktopTools });
    expect(result).toMatchObject({
      note: "Call browser_restart before continuing. Do not replay completed or uncertain actions.",
    });
    if (!desktopTools) expect(result).not.toHaveProperty("fallback");
  },
);
