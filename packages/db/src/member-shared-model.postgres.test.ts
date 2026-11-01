import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { sharedModelScope } from "./member-settings.js";
import { appliedModelRole } from "./model-roles.js";
import { asSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

// Models are account-wide with per-Space overrides, so a member borrowing the deployment
// owner's models must find the owner's account copy, or an override, under row-level security.
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
  const accountMainRole = (modelId: string) =>
    fixtures.userModelRoleChoice.create({
      data: {
        userId: owner,
        role: "main",
        position: 0,
        provider: "openai-compatible",
        modelId,
        credentialId,
      },
    });
  const overrideModels = (spaceId: string) =>
    fixtures.spaceSettingOverride.create({ data: { spaceId, userId: owner, setting: "models" } });
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
    // The owner joined ownerSpace first, so it is the owner's first Space.
    const spaces: ReadonlyArray<readonly [string, string]> = [
      [ownerSpace, owner],
      [ownerOtherSpace, owner],
      [memberSpace, member],
    ];
    for (const [index, [spaceId, userId]] of spaces.entries()) {
      await fixtures.space.create({
        data: { id: spaceId, organizationId, name: spaceId, createdByUserId: userId },
      });
      await fixtures.spaceMember.create({
        data: {
          id: `${spaceId}-m`,
          spaceId,
          organizationId,
          userId,
          createdAt: new Date(createdAt.getTime() + index * 1000),
        },
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
    await fixtures.spaceSettingOverride.deleteMany({ where: { userId: owner } });
    await fixtures.spaceModelRoleChoice.deleteMany({ where: { userId: owner } });
    await fixtures.userModelRoleChoice.deleteMany({ where: { userId: owner } });
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

  it("runs a member on the owner's account main role", async () => {
    await accountMainRole("grok-4.7");
    const resolved = await asMember(async () => {
      const scope = await sharedModelScope(db.prisma, { userId: member, spaceId: memberSpace });
      return { scope, main: await appliedModelRole(db.prisma, scope, "main") };
    });
    expect(resolved.scope).toEqual({ userId: owner, spaceId: ownerSpace });
    expect(resolved.main.primary).toMatchObject({
      provider: "openai-compatible",
      modelId: "grok-4.7",
      credentialId,
    });
  });

  it("skips a Space whose override would hide the owner's account models", async () => {
    await accountMainRole("grok-4.7");
    await overrideModels(ownerSpace);
    await mainRole(ownerSpace, "space-only-model");
    const resolved = await asMember(async () => {
      const scope = await sharedModelScope(db.prisma, { userId: member, spaceId: memberSpace });
      return { scope, main: await appliedModelRole(db.prisma, scope, "main") };
    });
    expect(resolved.scope).toEqual({ userId: owner, spaceId: ownerOtherSpace });
    expect(resolved.main.primary).toMatchObject({ modelId: "grok-4.7" });
  });

  it("falls back to an overriding Space with its own main role when the account has none", async () => {
    await overrideModels(ownerOtherSpace);
    await mainRole(ownerOtherSpace, "other-model");
    const resolved = await asMember(async () => {
      const scope = await sharedModelScope(db.prisma, { userId: member, spaceId: memberSpace });
      // The override row is the owner's; it must be read as the owner, not the member.
      return { scope, main: await appliedModelRole(db.prisma, scope, "main") };
    });
    expect(resolved.scope).toEqual({ userId: owner, spaceId: ownerOtherSpace });
    expect(resolved.main.primary).toMatchObject({ modelId: "other-model", credentialId });
  });

  it("keeps the owner's first Space when nothing is set, so deployment defaults apply", async () => {
    const scope = await asMember(() =>
      sharedModelScope(db.prisma, { userId: member, spaceId: memberSpace }),
    );
    expect(scope).toEqual({ userId: owner, spaceId: ownerSpace });
  });
});
