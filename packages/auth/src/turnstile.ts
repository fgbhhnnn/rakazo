/** Same header better-auth's captcha plugin reads, so clients need no new convention. */
export const CAPTCHA_HEADER = "x-captcha-response";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileSecret = { secretKey: string };

/** Asks Cloudflare whether a Turnstile token is valid. Any failure is a rejection. */
export async function verifyTurnstileToken(
  secretKey: string,
  token: string | null | undefined,
  remoteIp?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!token) return false;
  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const result = (await response.json()) as { success?: unknown };
    return result.success === true;
  } catch {
    return false;
  }
}
