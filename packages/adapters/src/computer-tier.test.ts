import { afterEach, describe, expect, it, vi } from "vitest";
import { computerTierFor } from "./computer-tier.js";

describe("computerTierFor", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { email: "admin@example.test", tier: "large" },
    { email: " SECOND@example.test ", tier: "large" },
    { email: "member@example.test", tier: "standard" },
    { email: "not-admin@example.test", tier: "standard" },
    { email: "", tier: "standard" },
    { email: null, tier: "standard" },
    { email: undefined, tier: "standard" },
  ])("selects $tier for $email", ({ email, tier }) => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", " ADMIN@example.test, second@example.test ");
    expect(computerTierFor({ email })).toBe(tier);
  });

  it("defaults to standard when deployment admins are unset", () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", undefined);
    expect(computerTierFor({ email: "admin@example.test" })).toBe("standard");
    expect(computerTierFor({})).toBe("standard");
  });
});
