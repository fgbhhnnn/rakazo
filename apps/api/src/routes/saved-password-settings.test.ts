import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";

function fixture() {
  const users = new Map<string, boolean>([
    ["owner", false],
    ["other", true],
  ]);
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        users.has(where.id) ? { allowBotPasswordReveal: users.get(where.id) } : null,
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { allowBotPasswordReveal: boolean };
        }) => {
          users.set(where.id, data.allowBotPasswordReveal);
          return data;
        },
      ),
    },
  } as unknown as PrismaClient;
  const router = createRouter({ prisma, env: {}, dataDir: "/tmp/test" } as RouterDeps);
  const client = (userId: string | null, spaceId = "space-1") =>
    createRouterClient(router, {
      context: {
        actor: userId
          ? ({
              userId,
              spaceId,
              email: "fake@example.test",
              isDeploymentOwner: false,
            } satisfies Actor)
          : null,
      },
    }).savedPasswordSettings;
  return { client, prisma, users };
}

describe("account saved-password consent", () => {
  it("defaults off for unset or missing account settings", async () => {
    const f = fixture();
    await expect(f.client("owner").get()).resolves.toEqual({ allowBotPasswordReveal: false });
    await expect(f.client("missing").get()).resolves.toEqual({ allowBotPasswordReveal: false });
  });
  it("updates only the caller's account across Spaces and can revoke consent", async () => {
    const f = fixture();
    await expect(f.client("owner").update({ allowBotPasswordReveal: true })).resolves.toEqual({
      allowBotPasswordReveal: true,
    });
    await expect(f.client("owner", "space-2").get()).resolves.toEqual({
      allowBotPasswordReveal: true,
    });
    await f.client("owner").update({ allowBotPasswordReveal: false });
    expect(f.users.get("other")).toBe(true);
    expect(f.users.get("owner")).toBe(false);
  });
  it("rejects unauthenticated reads and writes and arbitrary owner IDs", async () => {
    const f = fixture();
    await expect(f.client(null).get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(f.client(null).update({ allowBotPasswordReveal: true })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      f.client("owner").update({ allowBotPasswordReveal: true, userId: "other" } as never),
    ).rejects.toThrow();
    await expect(
      f.client("owner").update({ allowBotPasswordReveal: "true" } as never),
    ).rejects.toThrow();
    expect(f.prisma.user.update).not.toHaveBeenCalled();
  });
});
