import { afterEach, describe, expect, it, vi } from "vitest";
import { userTimeZone } from "./schedule-tools.js";

// Routines a bot creates without a timezone use the user's zone (upstream), then the
// deployment default RAKAZO_DEFAULT_TIMEZONE (ours, same as run time display), then UTC.
describe("routine default timezone", () => {
  afterEach(() => vi.unstubAllEnvs());
  const prisma = (timezone: string | null) =>
    ({ user: { findUnique: vi.fn(async () => ({ timezone })) } }) as never;

  it("keeps the user's own saved timezone first", async () => {
    vi.stubEnv("RAKAZO_DEFAULT_TIMEZONE", "Asia/Shanghai");
    await expect(userTimeZone(prisma("Europe/Paris"), "u")).resolves.toBe("Europe/Paris");
  });

  it("falls back to the deployment default before UTC", async () => {
    vi.stubEnv("RAKAZO_DEFAULT_TIMEZONE", "Asia/Shanghai");
    await expect(userTimeZone(prisma(null), "u")).resolves.toBe("Asia/Shanghai");
    await expect(userTimeZone(prisma("Mars/Olympus_Mons"), "u")).resolves.toBe("Asia/Shanghai");
  });

  it("uses UTC when neither is set or the default is invalid", async () => {
    vi.stubEnv("RAKAZO_DEFAULT_TIMEZONE", "");
    await expect(userTimeZone(prisma(null), "u")).resolves.toBe("UTC");
    vi.stubEnv("RAKAZO_DEFAULT_TIMEZONE", "Not/AZone");
    await expect(userTimeZone(prisma(null), "u")).resolves.toBe("UTC");
  });
});
