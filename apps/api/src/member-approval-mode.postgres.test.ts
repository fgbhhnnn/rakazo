import { randomUUID } from "node:crypto";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createDb, runAsSystem } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;

const LOCK_MESSAGE = "Your administrator manages this setting.";

/**
 * On a locked deployment a member still picks their own approval mode (Never ask / Auto / Ask);
 * the write lands only in that member's copy. Models, voice, MCP and the allow/block lists stay
 * the owner's to change.
 */
describePostgres("member approval mode under the member lock (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<{ actor: Actor }>;
  let previous: { ownerUserId: string | null; lockMemberSettings: boolean | null } | null = null;
  const users: string[] = [];
  const spaces: string[] = [];
  let owner: Actor;
  let member: Actor;

  async function account(label: string): Promise<Actor> {
    const id = randomUUID();
    const email = `${label}-${id}@example.test`;
    users.push(id);
    await system.user.create({ data: { id, name: label, email, emailVerified: true } });
    const { spaceId } = await runAsSystem("member approval fixture", () =>
      bootstrapUserSpace(prisma, { id }, { signupsEnabled: "true", signupAllowlist: "" }),
    );
    spaces.push(spaceId);
    return { userId: id, spaceId, email, isDeploymentOwner: false };
  }

  async function rpc(actor: Actor, path: string, json: Record<string, unknown> = {}) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    const body = (await response!.json()) as { json?: Record<string, unknown> };
    return { status: response!.status, json: body.json ?? {} };
  }

  const accountPreference = (userId: string) =>
    system.userActionAutoReviewPreference.findUnique({ where: { userId } });

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    owner = await account("owner");
    member = await account("member");
    previous = await system.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true, lockMemberSettings: true },
    });
    await system.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ownerUserId: owner.userId, lockMemberSettings: true },
      update: { ownerUserId: owner.userId, lockMemberSettings: true },
    });
    handler = new RPCHandler(createRouter({ prisma, env: {} } as unknown as RouterDeps));
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    if (!prisma) return;
    await system.deploymentSettings.update({
      where: { id: "default" },
      data: previous ?? { ownerUserId: null, lockMemberSettings: null },
    });
    await system.organization.deleteMany({
      where: { spaces: { some: { id: { in: spaces } } } },
    });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("a locked member still saves their own account mode", async () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "");
    // The lock holds for this member: their model settings are refused.
    expect((await rpc(member, "models/setDefault")).json).toMatchObject({ message: LOCK_MESSAGE });

    for (const mode of ["never", "ask", "never"] as const) {
      const saved = await rpc(member, "autoReview/set", { scope: "account", mode });
      expect(saved.status, mode).toBe(200);
      expect(saved.json).toMatchObject({ mode });
    }
    expect(await accountPreference(member.userId)).toMatchObject({
      enabled: false,
      skipApprovals: true,
    });
    expect((await rpc(member, "autoReview/get", { scope: "account" })).json).toMatchObject({
      mode: "never",
    });
  });

  it("a member's save never lands on another user's settings", async () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "");
    const before = await accountPreference(owner.userId);
    const saved = await rpc(member, "autoReview/set", {
      scope: "account",
      mode: "never",
      userId: owner.userId,
      spaceId: owner.spaceId,
    });
    // Unknown keys are dropped: the save is the member's own, under the member's own Space.
    expect(saved.status).toBe(200);
    expect(await accountPreference(owner.userId)).toEqual(before);
    expect(
      await system.actionAutoReviewPreference.findMany({ where: { spaceId: owner.spaceId } }),
    ).toEqual([]);
    expect(await accountPreference(member.userId)).toMatchObject({ skipApprovals: true });

    // A Space-scoped save is also the member's own copy in their own Space.
    expect((await rpc(member, "autoReview/set", { scope: "space", mode: "ask" })).status).toBe(200);
    const spaceRows = await system.actionAutoReviewPreference.findMany({
      where: { userId: { in: [owner.userId, member.userId] } },
      select: { spaceId: true, userId: true },
    });
    expect(spaceRows).toEqual([{ spaceId: member.spaceId, userId: member.userId }]);
  });

  it("keeps models, voice, MCP, approval rules and Space copies behind the lock", async () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "");
    const refused: Array<[string, Record<string, unknown>]> = [
      ["models/setDefault", {}],
      ["models/disconnect", {}],
      ["models/connect", {}],
      ["voice/connect", {}],
      ["voice/setVoice", {}],
      ["mcp/servers/create", {}],
      [
        "approvalRules/set",
        { scope: "account", effect: "always_allow", matchKind: "site", matchValue: "example.com" },
      ],
      ["approvalRules/remove", { scope: "account", id: randomUUID() }],
      ["spaceSettings/setOverride", { setting: "confirmations", enabled: true }],
    ];
    for (const [path, input] of refused) {
      const result = await rpc(member, path, input);
      expect(result.status, path).toBe(403);
      expect(result.json, path).toMatchObject({ message: LOCK_MESSAGE });
    }
    expect(await system.userActionApprovalRule.count({ where: { userId: member.userId } })).toBe(0);
  });

  it("the owner keeps changing approval rules and their own mode", async () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "");
    const rule = await rpc(owner, "approvalRules/set", {
      scope: "account",
      effect: "always_allow",
      matchKind: "site",
      matchValue: "example.com",
    });
    expect(rule.status).toBe(200);
    const mode = await rpc(owner, "autoReview/set", { scope: "account", mode: "ask" });
    expect(mode.status).toBe(200);
    expect(await accountPreference(owner.userId)).toMatchObject({ skipApprovals: false });
    // The member's choice is untouched by the owner's.
    expect(await accountPreference(member.userId)).toMatchObject({ skipApprovals: true });
  });
});
