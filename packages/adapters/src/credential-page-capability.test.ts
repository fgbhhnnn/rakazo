import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { requestWithBotSecret } from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  credentialToolsForPageCapability,
  passwordSubmissionNote,
  WEBSITE_LOGIN_UNAVAILABLE,
} from "./credential-page-capability.js";
import { dockerComputerToolInstruction, userTurnInstructions } from "./run-instructions.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";
import { secretTools } from "./run-tools-secrets.js";

describe("credential tools without a page browser", () => {
  const tools = selectBuiltinToolsForRun({
    graphicalToolsAllowed: true,
    pageBrowserAllowed: false,
    groupId: null,
    trigger: "user",
    semanticMemoryEnabled: false,
    messagingChannelRun: false,
    paymentWalletEnabled: true,
  });

  it("offers API and command credentials and connector codes, but no website login", () => {
    const tool = tools.find((tool) => tool.name === "request_secret")!;
    const schema = z.fromJSONSchema(tool.inputSchema);
    const args = { label: "Service", purpose: "password" };
    for (const auth of [
      { type: "command" },
      { type: "bearer" },
      { type: "basic", username: "example" },
      { type: "header", name: "X-Key" },
    ]) {
      expect(
        schema.safeParse({
          ...args,
          credential: { name: "service", origin: "https://example.test", auth },
        }).success,
      ).toBe(true);
    }
    expect(
      schema.safeParse({ ...args, credential: { name: "service", auth: { type: "login" } } })
        .success,
    ).toBe(false);
    expect(schema.safeParse({ ...args, connectionId: "connection" }).success).toBe(true);
    const generate = z.fromJSONSchema(
      tools.find((tool) => tool.name === "generate_secret")!.inputSchema,
    );
    expect(generate.safeParse({ name: "new-key", type: "command" }).success).toBe(true);
    expect(
      generate.safeParse({
        name: "new-key",
        type: "login",
        origin: "https://example.test",
        username: "example",
      }).success,
    ).toBe(false);
  });

  it("removes unavailable page tool identifiers from every offered tool description", () => {
    const surface = JSON.stringify(tools);
    expect(surface).not.toContain("fill_secret");
    expect(surface).not.toContain("browser_act");
    expect(surface).not.toContain("browser_navigate");
    expect(surface).not.toContain("browser_snapshot");
    expect(credentialToolsForPageCapability(builtinAgentTools, true)).toBe(builtinAgentTools);
    expect(builtinAgentTools.find((tool) => tool.name === "request_secret")!.description).toContain(
      "fill_secret",
    );
  });

  it.each([false, true])(
    "rejects a login before vault reads, reuse or replacement (replace=%s)",
    async (replace) => {
      const findFirst = vi.fn();
      const pauseRunForInput = vi.fn();
      const result = await secretTools.request_secret!(
        {
          computer: { pageBrowserAllowed: false },
          deps: { prisma: { vaultCredential: { findFirst } }, events: { pauseRunForInput } },
          state: {},
        } as never,
        {
          args: {
            credential: {
              name: "site-login",
              origin: "https://example.test",
              auth: { type: "login" },
            },
            replace,
          },
          finish: async (result: unknown) => result,
        } as never,
      );
      expect(result).toEqual({ error: WEBSITE_LOGIN_UNAVAILABLE });
      expect(findFirst).not.toHaveBeenCalled();
      expect(pauseRunForInput).not.toHaveBeenCalled();
    },
  );

  it("rejects generating an unusable website login before any storage", async () => {
    const result = await secretTools.generate_secret!(
      { computer: { pageBrowserAllowed: false } } as never,
      {
        args: { type: "login" },
        finish: async (result: unknown) => result,
      } as never,
    );
    expect(result).toEqual({ error: WEBSITE_LOGIN_UNAVAILABLE });
  });

  it.each([
    [false, "command"],
    [false, "bearer"],
    [true, "login"],
  ] as const)("reuses allowed credentials (page=%s, type=%s)", async (pageBrowserAllowed, type) => {
    const db = fakeDatabase();
    const destination = {
      name: "service",
      origin: type === "command" ? "" : "https://example.test",
      auth: { type },
    };
    vi.mocked(db.prisma.vaultCredential.findFirst).mockResolvedValue(destination as never);
    const load = vi.fn();
    const result = await secretTools.request_secret!(
      {
        computer: { pageBrowserAllowed },
        deps: { prisma: db.prisma, secretStore: { load } },
        run: { userId: "user-1", spaceId: "space-1" },
        runId: "run",
        state: {},
      } as never,
      {
        args: { credential: destination },
        finish: async (result: unknown) => result,
      } as never,
    );
    expect(result).toMatchObject({ saved: true, name: "service", auth: { type } });
    if (type === "command") {
      expect(result).toHaveProperty("variable", "SERVICE");
      expect(result).not.toHaveProperty("origin");
    } else {
      expect(result).toHaveProperty("origin", "https://example.test");
    }
    expect(load).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "gives capability-specific guidance for an existing login in secret_request (page=%s)",
    async (pageBrowserAllowed) => {
      const db = fakeDatabase();
      vi.mocked(db.prisma.vaultCredential.findFirst).mockResolvedValue({
        name: "site-login",
        origin: "https://example.test",
        auth: { type: "login" },
      } as never);
      const load = vi.fn();
      const fetch = vi.fn();
      const result = await requestWithBotSecret({
        prisma: db.prisma,
        scope: { userId: "user-1", spaceId: "space-1" },
        secretStore: { load } as never,
        request: { name: "site-login", url: "https://example.test" },
        signal: new AbortController().signal,
        remote: { fetch },
        pageBrowserAllowed,
      });
      expect(result).toEqual({
        error: pageBrowserAllowed
          ? "Website logins can only be filled into their site with browser_act."
          : WEBSITE_LOGIN_UNAVAILABLE,
      });
      expect(load).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps page identifiers out of one-shot password guidance without the capability", () => {
    expect(passwordSubmissionNote(false)).not.toMatch(/fill_secret|browser_act/);
    expect(passwordSubmissionNote(true)).toContain("browser_act fill_secret");
    expect(dockerComputerToolInstruction("docker", undefined, false)).not.toContain("browser_act");
  });
});

const instructionParts = {
  botInstructions: "Bot",
  groupContext: undefined,
  messagingContext: undefined,
  redactedMemoryContext: undefined,
  redactedScratchpadContext: undefined,
  hasHistoricalContext: false,
  computerInstruction: "Computer",
  pageBrowserAllowed: false,
  workspaceInstruction: "Workspace",
  agentEnvironmentInstruction: undefined,
  botDirectory: undefined,
  pluginLine: undefined,
  agentSkillsLine: undefined,
  taughtSkillsLine: undefined,
  replyGuidance: "Reply",
};

describe("credential turn instructions", () => {
  it.each([false, true])(
    "gates page tool identifiers on capability (page=%s)",
    (pageBrowserAllowed) => {
      const text = userTurnInstructions({ ...instructionParts, pageBrowserAllowed }).join("\n");
      for (const identifier of ["browser_act", "fill_secret"]) {
        expect(text.includes(identifier)).toBe(pageBrowserAllowed);
      }
    },
  );
});
