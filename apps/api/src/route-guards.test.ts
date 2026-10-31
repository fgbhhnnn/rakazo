import { createRouterClient, isProcedure } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

/**
 * Every owner/admin guard the router carries, checked by calling the real procedures.
 * The router split moved these into routes/*.ts; a dropped `ownerManaged` or admin check
 * fails here, and a new model/voice/MCP procedure must be classified before it can ship.
 */

const LOCK_MESSAGE = "Your administrator manages this setting.";

/** Model, voice, MCP and approval changes a locked deployment reserves for its owner. */
const OWNER_MANAGED = [
  "models.setRole",
  "models.setBackups",
  "models.connect",
  "models.probeOpenAiCompatible",
  "models.probeCatalog",
  "models.beginOAuth",
  "models.submitOAuthCode",
  "models.completeOAuth",
  "models.finishOAuth",
  "models.setDefault",
  "models.rename",
  "models.disconnect",
  "voice.connect",
  "voice.disconnect",
  "voice.setVoice",
  "voice.setSpeechModel",
  "mcp.servers.create",
  "mcp.servers.update",
  "mcp.servers.remove",
  "mcp.assignments.approve",
  "mcp.assignments.replace",
  "mcp.oauth.begin",
  "mcp.oauth.complete",
  "mcp.oauth.disconnect",
  "approvalRules.set",
  "approvalRules.remove",
] as const;

/**
 * Changes a locked deployment still leaves to each member, for their own account only. The
 * approval mode (Never ask / Auto / Ask) is the member's choice; the allow/block lists stay above.
 */
const MEMBER_OWN = ["autoReview.set"] as const;

/** Reads (and cancels/tests that change nothing stored) a locked member still needs. */
const MEMBER_OPEN = [
  "models.backups",
  "models.cancelOAuth",
  "models.credentials",
  "models.forRole",
  "models.list",
  "models.role",
  "voice.catalog",
  "voice.credentials",
  "voice.prepare",
  "voice.status",
  "voice.voices",
  "mcp.assignments.all",
  "mcp.assignments.dismiss",
  "mcp.assignments.list",
  "mcp.servers.list",
  "mcp.servers.test",
  "approvalRules.list",
  "approvalRules.preview",
  "autoReview.get",
] as const;

/** Only RAKAZO_ADMIN_EMAILS admins may call these. */
const ADMIN_ONLY = ["deployment.get", "deployment.update"] as const;

/** Agent import is refused unless RAKAZO_AGENT_IMPORT_ENABLED=true. */
const AGENT_IMPORT = ["bots.importPreview", "bots.importCreate", "bots.importSetupState"] as const;

/** No app account has authority over these. */
const NOBODY = ["security.events"] as const;

const ADMIN = { userId: "admin-1", email: "admin@example.com" };
const MEMBER = { userId: "member-1", email: "member@example.com" };
const STORED_OWNER = { userId: "owner-1", email: "owner@example.com" };

function deps(): RouterDeps {
  const row = {
    id: "default",
    ownerUserId: STORED_OWNER.userId,
    lockMemberSettings: true,
    shareOwnerModels: null,
    signupsEnabled: true,
    signupAllowlist: "",
  };
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        email: [ADMIN, MEMBER, STORED_OWNER].find((user) => user.userId === where.id)?.email,
      })),
    },
    deploymentSettings: {
      findUnique: vi.fn().mockResolvedValue(row),
      upsert: vi.fn().mockResolvedValue(row),
    },
  } as unknown as PrismaClient;
  return {
    prisma,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
}

function procedurePaths(node: unknown, prefix: string[] = []): string[] {
  if (isProcedure(node)) return [prefix.join(".")];
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, child]) => procedurePaths(child, [...prefix, key]));
}

function call(user: { userId: string; email: string }, path: string, input: unknown = {}) {
  const actor = { spaceId: "space-1", ...user, isDeploymentOwner: false } satisfies Actor;
  const client = createRouterClient(createRouter(deps()), { context: { actor } });
  const procedure = path
    .split(".")
    .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], client) as (
    input: unknown,
  ) => Promise<unknown>;
  return procedure(input);
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as { code?: string; message?: string };
  }
}

describe("router owner/admin guards", () => {
  afterEach(() => vi.unstubAllEnvs());

  const paths = procedurePaths(createRouter(deps()));

  it("enumerates the procedures each guard list names", () => {
    for (const path of [
      ...OWNER_MANAGED,
      ...MEMBER_OPEN,
      ...MEMBER_OWN,
      ...ADMIN_ONLY,
      ...NOBODY,
      ...AGENT_IMPORT,
    ]) {
      expect(paths, path).toContain(path);
    }
  });

  it("classifies every model, voice, MCP and approval procedure", () => {
    const classified = new Set<string>([...OWNER_MANAGED, ...MEMBER_OPEN, ...MEMBER_OWN]);
    const unclassified = paths.filter(
      (path) =>
        /^(models|voice|mcp|approvalRules|autoReview)\./.test(path) && !classified.has(path),
    );
    expect(unclassified).toEqual([]);
  });

  it.each(OWNER_MANAGED)("%s rejects a member of a locked deployment", async (path) => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", ADMIN.email);
    const error = await failure(call(MEMBER, path));
    expect(error).toMatchObject({ code: "FORBIDDEN", message: LOCK_MESSAGE });
  });

  it.each(OWNER_MANAGED)("%s lets an admin past the lock", async (path) => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", ADMIN.email);
    const error = await failure(call(ADMIN, path));
    expect(error?.message).not.toBe(LOCK_MESSAGE);
  });

  it.each(MEMBER_OPEN)("%s is not behind the member lock", async (path) => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", ADMIN.email);
    const error = await failure(call(MEMBER, path));
    expect(error?.message).not.toBe(LOCK_MESSAGE);
  });

  it.each(MEMBER_OWN)("%s lets a member of a locked deployment change their own", async (path) => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", ADMIN.email);
    const error = await failure(call(MEMBER, path, { scope: "account", mode: "never" }));
    expect(error?.message).not.toBe(LOCK_MESSAGE);
  });

  it("keeps the member lock on every model, voice, MCP and approval-rule change", () => {
    expect(OWNER_MANAGED.filter((path) => /^(models|voice|mcp)\./.test(path))).toHaveLength(24);
    expect(OWNER_MANAGED).toEqual(
      expect.arrayContaining(["approvalRules.set", "approvalRules.remove"]),
    );
    expect(OWNER_MANAGED).not.toContain("autoReview.set");
  });

  it.each(ADMIN_ONLY)("%s is admin-only", async (path) => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", ADMIN.email);
    for (const user of [MEMBER, STORED_OWNER]) {
      expect(await failure(call(user, path)), user.userId).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await failure(call(ADMIN, path))).toBeNull();
  });

  it.each(ADMIN_ONLY)("%s denies everyone while no admin is configured", async (path) => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "");
    expect(await failure(call(STORED_OWNER, path))).toMatchObject({ code: "FORBIDDEN" });
  });

  it.each(NOBODY)("%s is refused to every app account", async (path) => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", ADMIN.email);
    for (const user of [ADMIN, MEMBER, STORED_OWNER]) {
      expect(await failure(call(user, path)), user.userId).toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("gates every agent import procedure on the server flag", () => {
    expect(paths.filter((path) => path.startsWith("bots.import"))).toEqual([...AGENT_IMPORT]);
    // Upstream retired these with the move to importing a new bot in Settings.
    expect(paths).not.toContain("bots.importInfo");
    expect(paths).not.toContain("bots.importUndo");
  });

  it.each(AGENT_IMPORT)("%s is refused while agent import is off", async (path) => {
    vi.stubEnv("RAKAZO_AGENT_IMPORT_ENABLED", "");
    for (const user of [ADMIN, MEMBER]) {
      expect(await failure(call(user, path)), user.userId).toMatchObject({
        code: "NOT_FOUND",
        message: "Agent import is not available.",
      });
    }
  });

  it.each(AGENT_IMPORT)("%s gets past the flag once agent import is on", async (path) => {
    vi.stubEnv("RAKAZO_AGENT_IMPORT_ENABLED", "true");
    expect((await failure(call(MEMBER, path)))?.message).not.toBe("Agent import is not available.");
  });

  it("keeps Space copies of models, voice and confirmations behind the lock", async () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", ADMIN.email);
    for (const setting of ["models", "voice", "confirmations"]) {
      expect(
        await failure(call(MEMBER, "spaceSettings.setOverride", { setting, enabled: true })),
        setting,
      ).toMatchObject({ code: "FORBIDDEN", message: LOCK_MESSAGE });
      expect(
        (await failure(call(ADMIN, "spaceSettings.setOverride", { setting, enabled: true })))
          ?.message,
      ).not.toBe(LOCK_MESSAGE);
    }
  });
});
