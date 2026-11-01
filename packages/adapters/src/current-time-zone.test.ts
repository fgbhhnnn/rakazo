import { describe, expect, it, vi } from "vitest";
import { formatInstantForUser, resolveRunTimeZone } from "./current-time.js";

function prisma(user: string | null, owner: string | null) {
  return {
    user: { findUnique: vi.fn(async () => ({ timezone: user })) },
    space: { findUnique: vi.fn(async () => ({ createdByUser: { timezone: owner } })) },
  };
}

describe("resolveRunTimeZone", () => {
  const run = { userId: "u", spaceId: "s" };
  it("prefers the user's own zone", async () => {
    expect(await resolveRunTimeZone(prisma("Europe/Paris", "Asia/Shanghai"), run, {})).toBe(
      "Europe/Paris",
    );
  });
  it("falls back to the Space owner, then the deployment default", async () => {
    expect(await resolveRunTimeZone(prisma(null, "Asia/Shanghai"), run, {})).toBe("Asia/Shanghai");
    expect(
      await resolveRunTimeZone(prisma(null, null), run, { RAKAZO_DEFAULT_TIMEZONE: "Asia/Tokyo" }),
    ).toBe("Asia/Tokyo");
    expect(await resolveRunTimeZone(prisma("Not/AZone", null), run, {})).toBeUndefined();
  });
});

describe("formatInstantForUser", () => {
  it("labels local times with their offset", () => {
    const at = new Date("2026-10-23T17:48:27Z");
    expect(formatInstantForUser(at, "Asia/Shanghai")).toBe("2026-10-24 01:48:27 (UTC+08:00)");
    expect(formatInstantForUser(at)).toBe("2026-10-23T17:48:27 (UTC)");
  });
});
