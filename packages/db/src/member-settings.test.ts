import { describe, expect, it } from "vitest";
import { envFlag, memberSettingsPolicy } from "./member-settings.js";

describe("memberSettingsPolicy", () => {
  it("is open by default", () => {
    expect(memberSettingsPolicy(null, {})).toEqual({
      ownerUserId: null,
      locked: false,
      shareOwner: false,
    });
  });

  it("shares the owner's models whenever members are locked", () => {
    const row = { ownerUserId: "owner", lockMemberSettings: true, shareOwnerModels: null };
    expect(memberSettingsPolicy(row, {})).toMatchObject({ locked: true, shareOwner: true });
  });

  it("falls back to the environment only for unset columns", () => {
    const env = { RAKAZO_LOCK_MEMBER_SETTINGS: "1", RAKAZO_SHARE_OWNER_MODELS: "true" };
    expect(memberSettingsPolicy(null, env)).toMatchObject({ locked: true, shareOwner: true });
    const row = { ownerUserId: "owner", lockMemberSettings: false, shareOwnerModels: false };
    expect(memberSettingsPolicy(row, env)).toMatchObject({ locked: false, shareOwner: false });
  });

  it("reads common false spellings", () => {
    expect(envFlag("off")).toBe(false);
    expect(envFlag("0")).toBe(false);
    expect(envFlag("")).toBeUndefined();
    expect(envFlag("yes")).toBe(true);
  });
});
