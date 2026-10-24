import { describe, expect, it, vi } from "vitest";
import { verifyTurnstileToken } from "./turnstile.js";

describe("verifyTurnstileToken", () => {
  it("rejects a missing token without calling Cloudflare", async () => {
    const fetchImpl = vi.fn();
    expect(await verifyTurnstileToken("secret", "", null, fetchImpl)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts only an explicit success", async () => {
    const ok = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ success: true }),
    );
    const no = vi.fn(async () => Response.json({ success: false }));
    expect(await verifyTurnstileToken("secret", "token", "203.0.113.1", ok)).toBe(true);
    expect(await verifyTurnstileToken("secret", "token", null, no)).toBe(false);
    const body = ok.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("remoteip")).toBe("203.0.113.1");
  });

  it("treats network errors as a rejection", async () => {
    const fails = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await verifyTurnstileToken("secret", "token", null, fails)).toBe(false);
  });
});
