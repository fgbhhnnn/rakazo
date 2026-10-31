import { randomUUID } from "node:crypto";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createDb, runAsSystem } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;

type Policy = {
  ownerUserId: string | null;
  lockMemberSettings: boolean | null;
  shareOwnerModels: boolean | null;
};

/**
 * Auto stays available to a locked member when the approval model their runs use can run: the
 * owner's shared one, on the owner's connection. With no connection anywhere it is unavailable.
 */
describePostgres("Auto's approval model for a member on shared models (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<{ actor: Actor }>;
  let previous: Policy | null = null;
  const users: string[] = [];
  const spaces: string[] = [];
  let owner: Actor;
  let member: Actor;

  async function account(label: string): Promise<Actor> {
    const id = randomUUID();
    const email = `${label}-${id}@example.test`;
    users.push(id);
    await system.user.create({ data: { id, name: label, email, emailVerified: true } });
    const { spaceId } = await runAsSystem("member auto checker fixture", () =>
      bootstrapUserSpace(prisma, { id }, { signupsEnabled: "true", signupAllowlist: "" }),
    );
    spaces.push(spaceId);
    return { userId: id, spaceId, email, isDeploymentOwner: false };
  }

  async function checkerAvailable(actor: Actor, scope?: "account" | "space") {
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/autoReview/get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: scope ? { scope } : {} }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(response!.status).toBe(200);
    const body = (await response!.json()) as { json: { checkerAvailable: boolean } };
    return body.json.checkerAvailable;
  }

  const everyPage = (actor: Actor) =>
    Promise.all([
      checkerAvailable(actor),
      checkerAvailable(actor, "account"),
      checkerAvailable(actor, "space"),
    ]);

  async function policy(lockMemberSettings: boolean, shareOwnerModels: boolean | null) {
    await system.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ownerUserId: owner.userId, lockMemberSettings, shareOwnerModels },
      update: { ownerUserId: owner.userId, lockMemberSettings, shareOwnerModels },
    });
  }

  async function connect(actor: Actor, provider: string) {
    return system.userModelCredential.create({
      data: { userId: actor.userId, provider, label: provider, secretId: randomUUID() },
    });
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    owner = await account("owner");
    member = await account("member");
    previous = await system.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true, lockMemberSettings: true, shareOwnerModels: true },
    });
    handler = new RPCHandler(createRouter({ prisma, env: {} } as unknown as RouterDeps));
  });

  beforeEach(async () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "");
    // The deployment's checker, which the environment holds no key for (as on a self-host).
    vi.stubEnv("RAKAZO_AUTO_REVIEW_PROVIDER", "openai-compatible");
    vi.stubEnv("RAKAZO_AUTO_REVIEW_MODEL", "grok-4.7");
    vi.stubEnv("RAKAZO_LOCAL_MODELS", "");
    vi.stubEnv("PI_DEFAULT_PROVIDER", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await system.userModelRoleChoice.deleteMany({ where: { userId: { in: users } } });
    await system.userModelCredential.deleteMany({ where: { userId: { in: users } } });
    // The owner runs on a main model, so a member on shared models reads the owner's account.
    const main = await connect(owner, "openai-compatible");
    await system.userModelRoleChoice.create({
      data: {
        userId: owner.userId,
        role: "main",
        position: 0,
        provider: "openai-compatible",
        modelId: "grok-4.7",
        credentialId: main.id,
      },
    });
    await policy(true, null);
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    if (!prisma) return;
    await system.deploymentSettings.update({
      where: { id: "default" },
      data: previous ?? { ownerUserId: null, lockMemberSettings: null, shareOwnerModels: null },
    });
    await system.organization.deleteMany({
      where: { spaces: { some: { id: { in: spaces } } } },
    });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("a locked member can use Auto on the owner's connection for the deployment's checker", async () => {
    expect(await everyPage(member)).toEqual([true, true, true]);
    expect(await everyPage(owner)).toEqual([true, true, true]);
  });

  it("a locked member can use Auto on the owner's own approval model", async () => {
    vi.stubEnv("RAKAZO_AUTO_REVIEW_PROVIDER", "");
    vi.stubEnv("RAKAZO_AUTO_REVIEW_MODEL", "");
    const checker = await connect(owner, "anthropic");
    await system.userModelRoleChoice.create({
      data: {
        userId: owner.userId,
        role: "approval",
        position: 0,
        provider: "anthropic",
        modelId: "claude-test",
        credentialId: checker.id,
      },
    });
    expect(await everyPage(member)).toEqual([true, true, true]);
  });

  it("stays unavailable with no connection for the checker anywhere", async () => {
    await system.userModelRoleChoice.deleteMany({ where: { userId: owner.userId } });
    await system.userModelCredential.deleteMany({ where: { userId: owner.userId } });
    expect(await everyPage(member)).toEqual([false, false, false]);
    expect(await everyPage(owner)).toEqual([false, false, false]);
  });

  it("a member not on shared models is judged on their own connections", async () => {
    await policy(false, false);
    expect(await everyPage(member)).toEqual([false, false, false]);
    await connect(member, "openai-compatible");
    expect(await everyPage(member)).toEqual([true, true, true]);
    // The owner's connections never count for them.
    await system.userModelCredential.deleteMany({ where: { userId: member.userId } });
    expect(await everyPage(member)).toEqual([false, false, false]);
    expect(await everyPage(owner)).toEqual([true, true, true]);
  });
});
