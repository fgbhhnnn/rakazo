import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { sharedModelScope } from "./member-settings.js";
import { getModelRole } from "./model-roles.js";
import { asSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

// Role writes no longer mirror into the default preference, so a member borrowing the
// deployment owner's models must find the owner's main role under row-level security.
describePostgres("members on the owner's main model role (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const owner = `shared-model-owner-${suffix}`;
  const member = `shared-model-member-${suffix}`;
  const organizationId = `shared-model-org-${suffix}`;
  const ownerSpace = `shared-model-owner-space-${suffix}`;
  const ownerOtherSpace = `shared-model-owner-other-${suffix}`;
  const memberSpace = `shared-model-member-space-${suffix}`;
  const credentialId = `shared-model-credential-${suffix}`;
  let db: ReturnType<typeof createDb>;
  let fixtures: PrismaClient;
  let previousSettings: unknown = null;

  const asMember = <T>(fn: () => Promise<T>) =>
    runAsTenant({ userId: member, spaceId: memberSpace }, fn);
  const mainRole = (spaceId: string, modelId: string) =>
    fixtures.spaceModelRoleChoice.create({
      data: {
        spaceId,
        userId: owner,
        role: "main",
        position: 0,
        provider: "openai-compatible",
        modelId,
        credentialId,
      },
    });

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    fixtures = asSystem(db.prisma);
    const createdAt = new Date();
    for (const id of [owner, member]) {
      await fixtures.user.create({
        data: { id, name: id, email: `${id}@rakazo.test`, emailVerified: false },
      });
    }
    await fixtures.organization.create({
      data: { id: organizationId, name: "Shared", slug: organizationId, createdAt },
    });
    for (const [userId, role] of [
      [owner, "owner"],
      [member, "member"],
    ] as const) {
      await fixtures.member.create({
        data: { id: `${userId}-member`, organizationId, userId, role, createdAt },
      });
    }
    for (const [spaceId, userId] of [
      [ownerSpace, owner],
      [ownerOtherSpace, owner],
      [memberSpace, member],
    ] as const) {
      await fixtures.space.create({
        data: { id: spaceId, organizationId, name: spaceId, createdByUserId: userId },
      });
      await fixtures.spaceMember.create({
        data: { id: `${spaceId}-m`, spaceId, organizationId, userId, createdAt },
      });
    }
    await fixtures.secret.create({
      data: { id: credentialId, userId: owner, kind: "model", ciphertext: "fake-ciphertext" },
    });
    await fixtures.userModelCredential.create({
      data: {
        id: credentialId,
        userId: owner,
        provider: "openai-compatible",
        label: "OpenAI-compatible",
        secretId: credentialId,
      },
    });
    previousSettings = await fixtures.deploymentSettings.findUnique({ where: { id: "default" } });
    await fixtures.deploymentSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        ownerUserId: owner,
        lockMemberSettings: true,
        shareOwnerModels: true,
      },
      update: { ownerUserId: owner, lockMemberSettings: true, shareOwnerModels: true },
    });
  });

  beforeEach(async () => {
    await fixtures.spaceModelRoleChoice.deleteMany({ where: { userId: owner } });
    await fixtures.spaceModelPreference.deleteMany({ where: { userId: owner } });
  });

  afterAll(async () => {
    if (!fixtures) return;
    if (previousSettings) {
      const { id: _id, ...data } = previousSettings as { id: string } & Record<string, unknown>;
      await fixtures.deploymentSettings.update({ where: { id: "default" }, data: data as never });
    } else {
      await fixtures.deploymentSettings.deleteMany({ where: { id: "default" } });
    }
    await fixtures.organization.deleteMany({ where: { id: organizationId } });
    await fixtures.user.deleteMany({ where: { id: { in: [owner, member] } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("runs a member on the owner's main role when no legacy default exists", async () => {
    await mainRole(ownerSpace, "grok-4.7");
    const resolved = await asMember(async () => {
      const scope = await sharedModelScope(db.prisma, { userId: member, spaceId: memberSpace });
      return { scope, main: await getModelRole(db.prisma, scope, "main") };
    });
    expect(resolved.scope).toEqual({ userId: owner, spaceId: ownerSpace });
    expect(resolved.main.primary).toMatchObject({
      provider: "openai-compatible",
      modelId: "grok-4.7",
      credentialId,
    });
  });

  it("keeps the Space of the owner's frozen default when it still has a main role", async () => {
    await mainRole(ownerSpace, "grok-4.7");
    await mainRole(ownerOtherSpace, "other-model");
    // Sorts after ownerSpace, so only the legacy default can pick it.
    await fixtures.spaceModelPreference.create({
      data: {
        spaceId: ownerOtherSpace,
        userId: owner,
        credentialId,
        modelId: "other-model",
        isDefault: true,
      },
    });
    const scope = await asMember(() =>
      sharedModelScope(db.prisma, { userId: member, spaceId: memberSpace }),
    );
    expect(scope).toEqual({ userId: owner, spaceId: ownerOtherSpace });
  });

  it("prefers a Space with a main role over a frozen default without one", async () => {
    await mainRole(ownerOtherSpace, "grok-4.7");
    await fixtures.spaceModelPreference.create({
      data: { spaceId: ownerSpace, userId: owner, credentialId, modelId: "old", isDefault: true },
    });
    const scope = await asMember(() =>
      sharedModelScope(db.prisma, { userId: member, spaceId: memberSpace }),
    );
    expect(scope).toEqual({ userId: owner, spaceId: ownerOtherSpace });
  });
});
