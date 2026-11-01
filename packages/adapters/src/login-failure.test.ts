import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { encodeLoginSecret } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveLoginFill } from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import { browserActFromTool } from "./browser-tools.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import {
  DISPATCHER_LOGIN_FAILURE_GUIDANCE,
  WORKER_LOGIN_FAILURE_GUIDANCE,
} from "./login-failure.js";
import { userTurnInstructions } from "./run-instructions.js";
import { applyTool } from "./run-tools.js";

const computer: ComputerRef = {
  id: "computer",
  botId: "bot",
  kind: "fake",
  providerRef: "computer",
};
const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  userId: "user",
  spaceId: "space",
  signal: new AbortController().signal,
};
const origin = "https://example.test";
const actions = [{ kind: "fill_secret", ref: "e1", secret: "login", field: "Password" }];
const resolveSecretFill = async () => ({ text: "fake-value", origin, hidden: true });

describe("structured login failures", () => {
  it.each(["browser_act", "browser_navigate", "browser_snapshot"])(
    "carries no_page_browser through the dispatcher gate for %s",
    async (name) => {
      const ctx = {
        context,
        state: {},
        bot: {},
        tools: { disabled: new Set() },
        computer: { pageBrowserAllowed: false },
      };
      expect(await applyTool(ctx as never, name, { actions }, "execution")).toEqual({
        error: "Page browser is unavailable on this computer.",
        reason: "no_page_browser",
      });
    },
  );

  it("returns no_page_browser before resolving or typing a secret", async () => {
    const browser = new FakeBrowserProvider();
    vi.spyOn(browser, "describe").mockReturnValue({
      ...browser.describe(),
      capabilities: { ...browser.describe().capabilities, page: false },
    });
    const resolve = vi.fn(resolveSecretFill);
    const act = vi.spyOn(browser, "act");
    expect(
      await browserActFromTool(
        browser,
        computer,
        context,
        { actions },
        { resolveSecretFill: resolve },
      ),
    ).toMatchObject({ reason: "no_page_browser", completed: 0 });
    expect(resolve).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });
  it("carries a known credential field error through fill_secret", async () => {
    const browser = new FakeBrowserProvider();
    expect(
      await browserActFromTool(
        browser,
        computer,
        context,
        { actions },
        {
          resolveSecretFill: async () => ({
            error: "No such login field.",
            reason: "field_not_found",
          }),
        },
      ),
    ).toMatchObject({ error: "No such login field.", reason: "field_not_found", completed: 0 });
  });
  it("reports a stale ref as field_not_found, never password_rejected", async () => {
    const browser = new FakeBrowserProvider();
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions },
      { resolveSecretFill },
    );
    expect(result).toMatchObject({ reason: "field_not_found", completed: 0, uncertain: false });
  });
  it("reports a refused field as unknown and leaves it empty", async () => {
    const browser = new FakeBrowserProvider({
      pages: { [origin]: { html: '<input aria-label="Public text" />' } },
    });
    await browser.navigate(computer, { url: origin }, context);
    const snapshot = await browser.snapshot(computer, {}, context);
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      {
        actions: [{ ...actions[0], ref: snapshot.elements![0]!.ref }],
      },
      { resolveSecretFill, redactions: () => ["fake-value"] },
    );
    expect(result).toMatchObject({ reason: "unknown", completed: 0, uncertain: false });
    expect(JSON.stringify(result)).not.toContain("fake-value");
  });
  it("redacts exception messages from the browser after resolving a secret", async () => {
    const browser = new FakeBrowserProvider();
    browser.actError = new Error("Browser echoed fake-value");
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions },
      { resolveSecretFill, redactions: () => ["fake-value"] },
    );
    expect(result).toMatchObject({
      reason: "unknown",
      uncertain: true,
      error: "Browser echoed [redacted]",
    });
  });
  it("does not add a login reason to unrelated browser actions", async () => {
    const browser = new FakeBrowserProvider();
    expect(
      await browserActFromTool(browser, computer, context, {
        actions: [{ kind: "click", ref: "missing" }],
      }),
    ).not.toHaveProperty("reason");
  });
  it("reports a missing credential field without exposing stored fields", async () => {
    const { prisma } = fakeDatabase();
    vi.mocked(prisma.vaultCredential.findFirst).mockResolvedValue({
      name: "login",
      origin,
      auth: { type: "login" },
      id: "credential",
      ciphertext: "sealed",
    } as never);
    const result = await resolveLoginFill({
      prisma,
      secretStore: {
        load: async () =>
          encodeLoginSecret({ fields: [{ label: "Password", hidden: true, value: "fake-value" }] }),
      } as never,
      scope: { spaceId: "space", userId: "user" },
      runId: "run",
      name: "login",
      field: "Missing",
    });
    expect(result).toMatchObject({ reason: "field_not_found" });
    expect(JSON.stringify(result)).not.toContain("fake-value");
  });
  it("returns unknown when a saved login is unavailable", async () => {
    const { prisma } = fakeDatabase();
    expect(
      await resolveLoginFill({
        prisma,
        secretStore: {} as never,
        scope: { spaceId: "space", userId: "user" },
        runId: "run",
        name: "missing",
        field: "Password",
      }),
    ).toMatchObject({ reason: "unknown", error: expect.any(String) });
  });
  it.each([true, false])(
    "wires the appropriate report guidance (dispatcher=%s)",
    (dispatcherRun) => {
      const instructions = userTurnInstructions({ dispatcherRun } as never);
      expect(instructions).toContain(
        dispatcherRun ? DISPATCHER_LOGIN_FAILURE_GUIDANCE : WORKER_LOGIN_FAILURE_GUIDANCE,
      );
    },
  );
});
