import { createStreamingRedactor } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import { passwordSubmissionNote, WEBSITE_LOGIN_UNAVAILABLE } from "./credential-page-capability.js";
import { runCredentialPageBrowserAllowed } from "./run-credential-capability.js";
import { userTurnInstructions } from "./run-instructions.js";
import { secretTools } from "./run-tools-secrets.js";

const destination = {
  name: "site-login",
  origin: "https://example.test",
  auth: { type: "login" },
};
const finish = async (result: unknown) => result;

describe("credential page capability context", () => {
  it.each([
    [false, undefined, false],
    [true, undefined, true],
    [false, true, true],
    [true, false, false],
  ])("resolves page=%s, credential=%s to %s", (page, credential, expected) => {
    expect(
      runCredentialPageBrowserAllowed({
        computer: { pageBrowserAllowed: page },
        credentialPageBrowserAllowed: credential,
      }),
    ).toBe(expected);
  });

  it.each([false, true])(
    "gates saved login reuse on the credential capability (%s)",
    async (page) => {
      const { prisma } = fakeDatabase();
      vi.mocked(prisma.vaultCredential.findFirst).mockResolvedValue(destination as never);
      const result = await secretTools.request_secret!(
        {
          computer: { pageBrowserAllowed: !page },
          credentialPageBrowserAllowed: page,
          deps: { prisma },
          run: { userId: "user-1", spaceId: "space-1" },
          runId: "run-1",
          state: {},
        } as never,
        { args: { credential: destination }, finish } as never,
      );
      expect(result).toEqual(
        page
          ? { saved: true, ...destination }
          : { error: WEBSITE_LOGIN_UNAVAILABLE, reason: "no_page_browser" },
      );
      expect(prisma.vaultCredential.findFirst).toHaveBeenCalledTimes(page ? 1 : 0);
    },
  );

  it.each([false, true])(
    "gates login generation on the credential capability (%s)",
    async (page) => {
      const { prisma } = fakeDatabase();
      vi.mocked(prisma.vaultCredential.findFirst).mockResolvedValue(destination as never);
      const result = await secretTools.generate_secret!(
        {
          computer: { pageBrowserAllowed: !page },
          credentialPageBrowserAllowed: page,
          deps: { prisma },
          run: { id: "run-1", userId: "user-1", spaceId: "space-1" },
        } as never,
        {
          args: {
            name: destination.name,
            origin: destination.origin,
            type: "login",
            username: "example",
          },
          finish,
        } as never,
      );
      expect(result).toMatchObject(page ? destination : { reason: "no_page_browser" });
      expect(prisma.vaultCredential.findFirst).toHaveBeenCalledTimes(page ? 1 : 0);
    },
  );

  it.each([false, true])(
    "uses the credential capability in authenticated request guidance (%s)",
    async (page) => {
      const { prisma } = fakeDatabase();
      vi.mocked(prisma.vaultCredential.findFirst).mockResolvedValue(destination as never);
      const result = await secretTools.secret_request!(
        {
          computer: { pageBrowserAllowed: !page },
          credentialPageBrowserAllowed: page,
          deps: { prisma },
          secretScope: { userId: "user-1", spaceId: "space-1" },
          context: { signal: new AbortController().signal },
        } as never,
        { args: { name: destination.name, url: destination.origin }, finish } as never,
      );
      expect(result).toEqual({
        error: page
          ? "Website logins can only be filled into their site with browser_act."
          : WEBSITE_LOGIN_UNAVAILABLE,
        reason: page ? "unknown" : "no_page_browser",
      });
    },
  );

  it.each([false, true])(
    "uses the credential capability after one-shot password submission (%s)",
    async (page) => {
      const { prisma } = fakeDatabase();
      vi.mocked(prisma.secret.findFirst).mockResolvedValue({
        id: "secret-1",
        ciphertext: "sealed",
      } as never);
      const result = await secretTools.request_secret!(
        {
          computer: { pageBrowserAllowed: !page },
          credentialPageBrowserAllowed: page,
          deps: {
            prisma: {
              ...prisma,
              secret: { ...prisma.secret, delete: vi.fn() },
              externalEffect: {
                findUnique: vi.fn(async () => null),
                findMany: vi.fn(async () => []),
                create: vi.fn(async () => ({ id: "effect-1" })),
              },
            },
            secretStore: { load: async () => "fixture-password" },
          },
          run: { id: "run-1", userId: "user-1", spaceId: "space-1" },
          runId: "run-1",
          secrets: [],
          state: { reply: { pendingProgress: "", redactor: createStreamingRedactor([]) } },
        } as never,
        {
          name: "request_secret",
          effectKey: "request-1",
          args: {
            purpose: "password",
            credential: { name: "command-key", auth: { type: "command" } },
          },
          persistEffectResult: async () => true,
          finish,
        } as never,
      );
      expect(result).toEqual({ ok: true, submitted: true, note: passwordSubmissionNote(page) });
    },
  );

  it.each([false, true])(
    "uses the credential capability only for secret instructions (%s)",
    (page) => {
      const instructions = userTurnInstructions({
        botInstructions: "Bot",
        computerInstruction: "Computer",
        pageBrowserAllowed: false,
        credentialPageBrowserAllowed: page,
        disabledBuiltinTools: new Set(["browser_act", "browser_navigate", "browser_snapshot"]),
        hasHistoricalContext: false,
        workspaceInstruction: "Workspace",
        replyGuidance: "Reply",
        groupContext: undefined,
        messagingContext: undefined,
        redactedMemoryContext: undefined,
        redactedScratchpadContext: undefined,
        agentEnvironmentInstruction: undefined,
        botDirectory: undefined,
        pluginLine: undefined,
        agentSkillsLine: undefined,
        taughtSkillsLine: undefined,
      }).join("\n");
      expect(instructions.includes("auth type login")).toBe(page);
      expect(instructions).not.toContain("browser_act");
      expect(instructions).not.toContain("browser_navigate");
      expect(instructions).not.toContain("fill_secret");
    },
  );
});
