import type { BrowserSnapshotResult } from "@rakazo/adapter-kit";
import { encodeLoginSecret } from "@rakazo/contracts";
import { createStreamingRedactor } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { storeBotSecret } from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { revealSecret } from "./reveal-secret.js";
import { pageHasSecretOrigin } from "./reveal-secret-origin.js";
import type { RunContext } from "./run-context.js";
import { EncryptedSecretStore } from "./secrets.js";

const savedOrigin = "https://idmsa.apple.com";
const page: BrowserSnapshotResult = {
  url: "https://account.apple.com/",
  title: "Sign in",
  tree: "",
  elements: [],
  frameOrigins: [savedOrigin],
};

describe("saved login origin evidence", () => {
  it("allows the saved HTTPS origin in the top page or a current cross-origin frame", () => {
    expect(
      pageHasSecretOrigin({ ...page, url: `${savedOrigin}/login`, frameOrigins: [] }, savedOrigin),
    ).toBe(true);
    expect(pageHasSecretOrigin(page, savedOrigin)).toBe(true);
  });

  it.each([
    undefined,
    [],
    ["https://apple.com"],
    ["https://appleid.apple.com"],
    ["https://idmsa.apple.com.attacker.test"],
    ["https://idmsa.apple.com:8443"],
    ["http://idmsa.apple.com"],
    ["null"],
  ])("refuses absent frames and origins other than the exact saved origin: %j", (frameOrigins) => {
    expect(pageHasSecretOrigin({ ...page, frameOrigins }, savedOrigin)).toBe(false);
  });

  it("does not use frame headers or URLs in page content as evidence", () => {
    expect(
      pageHasSecretOrigin(
        { ...page, frameOrigins: [], tree: `[frame ${savedOrigin}]` },
        savedOrigin,
      ),
    ).toBe(false);
  });

  it.each([
    { url: "http://account.apple.com/" },
    { url: "about:blank" },
    { url: "invalid" },
    { error: "Snapshot failed" },
    { fallback: "computer_act" as const },
  ])("fails closed on insecure pages or unavailable snapshots: %j", (change) => {
    expect(pageHasSecretOrigin({ ...page, ...change }, savedOrigin)).toBe(false);
  });

  it.each(["http://idmsa.apple.com", "invalid"])("refuses insecure credentials: %s", (origin) => {
    expect(pageHasSecretOrigin(page, origin)).toBe(false);
  });
});

async function fixture() {
  const { prisma } = fakeDatabase();
  const scope = { userId: "user", spaceId: "space", botId: "bot" };
  Object.assign(prisma, { user: { findUnique: async () => ({ allowBotPasswordReveal: true }) } });
  const secretStore = new EncryptedSecretStore("fake-test-encryption-key");
  await storeBotSecret({
    prisma,
    secretStore,
    scope,
    destination: { name: "login", origin: savedOrigin, auth: { type: "login" } },
    plaintext: encodeLoginSecret({
      fields: [{ label: "Password", value: "fake-apple-password", hidden: true }],
    }),
  });
  // Exercise the live snapshot adapter too: it must retain the helper's structured frame evidence.
  const liveDriver = vi.fn(async () => ({ ok: true, ...page }));
  const finish = vi.fn(async (result: unknown) => result);
  const ctx = {
    deps: { prisma, secretStore },
    secretScope: scope,
    run: { ...scope, id: "run" },
    context: { signal: new AbortController().signal },
    computer: { get: async () => ({ id: "computer", kind: "docker" }), heldForTakeover: false },
    providers: { browser: new ComputerBrowserProvider({ liveDriver }) },
    state: { reply: { pendingProgress: "", redactor: createStreamingRedactor([]) } },
    secrets: [] as string[],
  } as unknown as RunContext;
  const call = () =>
    revealSecret(ctx, { args: { name: "login", origin: savedOrigin }, finish } as never);
  return { liveDriver, finish, ctx, call };
}

describe("reveal_secret with live frame snapshots", () => {
  it("reveals an Apple login only while the matching frame is present", async () => {
    const f = await fixture();
    expect(await f.call()).toEqual({ value: "fake-apple-password", origin: savedOrigin });
    expect(f.finish).toHaveBeenCalledWith({ value: "[redacted]", origin: savedOrigin });
    f.liveDriver.mockResolvedValueOnce({ ok: true, ...page, frameOrigins: [] });
    expect(await f.call()).toHaveProperty("error");
    expect(f.liveDriver).toHaveBeenCalledTimes(2);
  });

  it.each([
    { frameOrigins: undefined },
    { frameOrigins: ["https://appleid.apple.com"] },
    { frameOrigins: ["http://idmsa.apple.com"] },
    { url: "http://account.apple.com/" },
    { error: "Snapshot failed" },
  ])("withholds plaintext when the browser cannot establish the origin: %j", async (change) => {
    const f = await fixture();
    f.liveDriver.mockResolvedValueOnce({ ok: true, ...page, ...change });
    expect(await f.call()).toHaveProperty("error");
    expect(f.ctx.secrets).toEqual([]);
    expect(JSON.stringify(f.finish.mock.calls)).not.toContain("fake-apple-password");
  });

  it("refuses a supplied HTTP origin before accessing the browser", async () => {
    const f = await fixture();
    expect(
      await revealSecret(f.ctx, {
        args: { name: "login", origin: "http://idmsa.apple.com" },
        finish: f.finish,
      } as never),
    ).toHaveProperty("error");
    expect(f.liveDriver).not.toHaveBeenCalled();
  });
});
