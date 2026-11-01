import type { BotSecretDestination } from "@rakazo/contracts";
import { encodeLoginSecret } from "@rakazo/contracts";
import { createStreamingRedactor, redactSecrets } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { storeBotSecret } from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import { applyDispatcherToolPolicy } from "./dispatcher-mode.js";
import { passwordRevealAllowed, revealSecret } from "./reveal-secret.js";
import { redactRevealedContent } from "./reveal-secret-redaction.js";
import type { RunContext } from "./run-context.js";
import { persistTurnCheckpoint } from "./run-context.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";
import { TOOL_HANDLERS } from "./run-tools.js";
import { EncryptedSecretStore } from "./secrets.js";
import { toolCompletionAuditPayload } from "./tool-completion-audit.js";
import { withholdUserFacingTools } from "./worker-user-facing-tools.js";

const scope = { userId: "user-1", spaceId: "space-1", botId: "ordinary-bot" };
const password = 'fake-password+"\\/123';
const destination: BotSecretDestination = {
  name: "login",
  origin: "https://example.test",
  auth: { type: "login" },
};
const store = new EncryptedSecretStore("fake-test-encryption-key");
async function fixture(enabled = false) {
  const db = fakeDatabase();
  const users = new Map([
    [scope.userId, enabled],
    ["other", false],
  ]);
  const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => ({
    allowBotPasswordReveal: users.get(where.id),
  }));
  Object.assign(db.prisma, { user: { findUnique } });
  await storeBotSecret({
    prisma: db.prisma,
    secretStore: store,
    scope,
    destination,
    plaintext: encodeLoginSecret({
      fields: [
        { label: "Username", value: "fake-user", hidden: false },
        { label: "Password", value: password, hidden: true },
      ],
    }),
  });
  const snapshot = vi.fn(async () => ({ url: `${destination.origin}/login` }));
  const finish = vi.fn(async (result: unknown) => result);
  const ctx = {
    deps: { prisma: db.prisma, secretStore: store },
    secretScope: { ...scope },
    run: { ...scope, id: "run" },
    bot: { id: "ordinary-bot", dev: false },
    context: { signal: new AbortController().signal },
    computer: { get: vi.fn(async () => ({})), heldForTakeover: false },
    providers: { browser: { snapshot } },
    state: { reply: { pendingProgress: "", redactor: createStreamingRedactor([]) } },
    secrets: [] as string[],
  } as unknown as RunContext;
  const call = (args: Record<string, unknown> = { name: "login", origin: destination.origin }) =>
    revealSecret(ctx, { args, finish } as never);
  return { ...db, ctx, users, snapshot, finish, call, findUnique };
}

describe("direct saved password access", () => {
  it("is absent by default and refused even if invoked directly", async () => {
    const f = await fixture();
    expect(await passwordRevealAllowed(f.prisma, scope.userId)).toBe(false);
    expect(selected().some((t) => t.name === "reveal_secret")).toBe(false);
    expect(await f.call()).toHaveProperty("error");
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(TOOL_HANDLERS.get("reveal_secret")).toBe(revealSecret);
  });
  it("offers it without a dev restriction, including workers and team turns", () => {
    for (const groupId of [null, "team"]) {
      expect(selected(true, groupId).some((t) => t.name === "reveal_secret")).toBe(true);
    }
    const dispatcherDisabled = new Set<string>();
    applyDispatcherToolPolicy(true, {}, dispatcherDisabled, selected(true));
    expect(dispatcherDisabled.has("reveal_secret")).toBe(false);
    const disabled = new Set<string>();
    withholdUserFacingTools({ spawnKey: "bg-worker:parent:1" }, disabled);
    expect(disabled.has("reveal_secret")).toBe(false);
    expect(selected(true, null, ["reveal_secret"]).some((t) => t.name === "reveal_secret")).toBe(
      false,
    );
  });
  it("returns plaintext to an ordinary bot, persists a placeholder and redacts replies, audits and checkpoints", async () => {
    const f = await fixture(true);
    expect(await f.call()).toEqual({ value: password, origin: destination.origin });
    expect(f.finish).toHaveBeenCalledWith({ value: "[redacted]", origin: destination.origin });
    expect(redactSecrets(`Typed ${password}`, f.ctx.secrets)).toBe("Typed [redacted]");
    const transcript = {
      messages: [
        {
          role: "toolResult",
          content: [{ type: "text", text: JSON.stringify({ value: password }) }],
          details: { value: password },
        },
        { role: "assistant", content: [{ arguments: { text: password } }] },
      ],
    };
    const saved = JSON.stringify(redactRevealedContent(f.ctx, transcript));
    expect(saved).not.toContain(password);
    expect(saved).not.toContain("fake-password");
    expect(saved).toContain("[redacted]");
    expect(
      JSON.stringify(
        toolCompletionAuditPayload(
          { name: "reveal_secret", executionId: "e", durationMs: 1, result: { value: password } },
          f.ctx.secrets,
        ),
      ),
    ).not.toContain("fake-password");
  });
  it("rechecks consent on every call and fails closed on a settings outage", async () => {
    const f = await fixture(true);
    expect(await f.call()).toHaveProperty("value", password);
    f.users.set(scope.userId, false);
    expect(await f.call()).toHaveProperty("error");
    f.findUnique.mockRejectedValueOnce(new Error(password));
    expect(await f.call()).toHaveProperty("error");
  });
  it("scrubs the checkpoint actually written to the database after a reveal", async () => {
    const f = await fixture(true);
    await f.call();
    const upsert = vi.fn(async () => ({}));
    Object.assign(f.prisma, {
      externalEffect: { upsert },
      run: { updateMany: async () => ({ count: 1 }) },
    });
    Object.assign(f.ctx, { workerId: "worker", fence: 1 });
    f.ctx.state.effects = {
      occurrences: [],
      pendingTurnCheckpoints: new Map([
        [
          "pause",
          () =>
            JSON.stringify({
              messages: [
                { role: "toolResult", content: [{ text: JSON.stringify({ value: password }) }] },
              ],
            }),
        ],
      ]),
    } as unknown as RunContext["state"]["effects"];
    await persistTurnCheckpoint(f.ctx, "pause");
    expect(upsert).toHaveBeenCalledOnce();
    const stored = JSON.stringify(upsert.mock.calls);
    expect(stored).toContain("[redacted]");
    expect(stored).not.toContain("fake-password");
  });
  it("checks consent again after waiting for the browser", async () => {
    const f = await fixture(true);
    f.snapshot.mockImplementationOnce(async () => {
      f.users.set(scope.userId, false);
      return { url: destination.origin };
    });
    expect(await f.call()).toHaveProperty("error");
    expect(f.ctx.secrets).toEqual([]);
  });
  it("lets a non-dev hidden worker and a teammate use their account's same vault", async () => {
    const f = await fixture(true);
    for (const bot of [
      { id: "worker", spawnKey: "bg-worker:ordinary-bot:1", dev: false },
      { id: "teammate", dev: false },
    ]) {
      Object.assign(f.ctx.bot, bot);
      f.ctx.secretScope.botId = "ordinary-bot";
      expect(await f.call()).toHaveProperty("value", password);
    }
  });
  it("isolates accounts, Space overrides and credential names", async () => {
    const f = await fixture(true);
    f.ctx.secretScope.userId = "other";
    f.users.set("other", true);
    expect(await f.call()).toHaveProperty("error");
    f.ctx.secretScope.userId = scope.userId;
    f.useOwnVault(scope.spaceId);
    expect(await f.call()).toHaveProperty("error");
    await storeBotSecret({
      prisma: f.prisma,
      secretStore: store,
      scope: { ...scope, vault: "space" },
      destination,
      plaintext: encodeLoginSecret({
        fields: [{ label: "Password", value: "space-password", hidden: true }],
      }),
    });
    expect(await f.call()).toHaveProperty("value", "space-password");
    expect(await f.call({ name: "missing", origin: destination.origin })).toHaveProperty("error");
  });
  it("refuses the wrong actual page, supplied domain, HTTP, non-login credentials and missing fields", async () => {
    const f = await fixture(true);
    for (const origin of ["https://other.test", "http://example.test"]) {
      expect(await f.call({ name: "login", origin })).toHaveProperty("error");
    }
    f.snapshot.mockResolvedValueOnce({ url: "https://other.test/login" });
    expect(await f.call()).toHaveProperty("error");
    expect(
      await f.call({ name: "login", origin: destination.origin, field: "missing" }),
    ).toHaveProperty("error");
    await storeBotSecret({
      prisma: f.prisma,
      secretStore: store,
      scope,
      destination: { ...destination, name: "api", auth: { type: "bearer" } },
      plaintext: "fake-api-key",
    });
    expect(await f.call({ name: "api", origin: destination.origin })).toHaveProperty("error");
  });
  it("contains store/browser errors without exposing their messages", async () => {
    const f = await fixture(true);
    f.snapshot.mockRejectedValueOnce(new Error(password));
    expect(await f.call()).toEqual({ error: "The saved login could not be revealed." });
    f.ctx.computer.heldForTakeover = true;
    expect(await f.call()).toHaveProperty("error");
  });
});

function selected(
  allowBotPasswordReveal?: boolean,
  groupId: string | null = null,
  disabledBuiltinTools: string[] = [],
) {
  return selectBuiltinToolsForRun({
    allowBotPasswordReveal,
    groupId,
    disabledBuiltinTools,
    graphicalToolsAllowed: true,
    trigger: "user",
    semanticMemoryEnabled: false,
    messagingChannelRun: false,
  });
}
