import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter, lockedForActor, type RouterDeps } from "./router.js";

const OWNER = "owner-1";
const MEMBER = "member-1";

function me(
  userId: string,
  settings: { ownerUserId: string | null; lockMemberSettings: boolean | null } | null,
) {
  const row = settings ? { id: "default", shareOwnerModels: null, ...settings } : null;
  const prisma = {
    user: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        email: `${userId}@rakazo.test`,
        name: "Test User",
        signupSurvey: null,
      }),
    },
    userModelCredential: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn() },
    spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
    spaceModelRoleChoice: { findMany: vi.fn().mockResolvedValue([]) },
    deploymentSettings: { findUnique: vi.fn().mockResolvedValue(row) },
  } as unknown as PrismaClient;
  const deps = {
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
  // App accounts never carry deployment authority; the owner is known from the settings row.
  const actor = {
    spaceId: "space-1",
    userId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  } satisfies Actor;
  return createRouterClient(createRouter(deps), { context: { actor } }).me();
}

describe("memberSettingsLocked on me", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never locks the deployment owner, even when the lock comes from the environment", async () => {
    vi.stubEnv("RAKAZO_LOCK_MEMBER_SETTINGS", "true");
    await expect(
      me(OWNER, { ownerUserId: OWNER, lockMemberSettings: null }),
    ).resolves.toMatchObject({ memberSettingsLocked: false });
    await expect(
      me(OWNER, { ownerUserId: OWNER, lockMemberSettings: true }),
    ).resolves.toMatchObject({ memberSettingsLocked: false });
  });

  it("locks other members while the lock is on", async () => {
    vi.stubEnv("RAKAZO_LOCK_MEMBER_SETTINGS", "true");
    await expect(
      me(MEMBER, { ownerUserId: OWNER, lockMemberSettings: null }),
    ).resolves.toMatchObject({ memberSettingsLocked: true });
    vi.stubEnv("RAKAZO_LOCK_MEMBER_SETTINGS", "");
    await expect(
      me(MEMBER, { ownerUserId: OWNER, lockMemberSettings: true }),
    ).resolves.toMatchObject({ memberSettingsLocked: true });
  });

  it("locks nobody when the lock is off", async () => {
    vi.stubEnv("RAKAZO_LOCK_MEMBER_SETTINGS", "");
    for (const userId of [OWNER, MEMBER]) {
      await expect(
        me(userId, { ownerUserId: OWNER, lockMemberSettings: null }),
      ).resolves.toMatchObject({ memberSettingsLocked: false });
      await expect(me(userId, null)).resolves.toMatchObject({ memberSettingsLocked: false });
    }
    vi.stubEnv("RAKAZO_LOCK_MEMBER_SETTINGS", "true");
    await expect(
      me(MEMBER, { ownerUserId: OWNER, lockMemberSettings: false }),
    ).resolves.toMatchObject({ memberSettingsLocked: false });
  });

  it("treats a lock without a recorded owner as applying to everyone", () => {
    expect(lockedForActor({ locked: true, ownerUserId: null }, { userId: OWNER })).toBe(true);
    expect(lockedForActor({ locked: true, ownerUserId: OWNER }, { userId: OWNER })).toBe(false);
    expect(lockedForActor({ locked: false, ownerUserId: null }, { userId: MEMBER })).toBe(false);
  });
});
