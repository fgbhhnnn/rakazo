import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

const SECRET_RECORD_ID = "deployment:turnstile-secret";

type Row = {
  turnstileEnabled: boolean | null;
  turnstileSiteKey: string | null;
  turnstileSecretCipher: string | null;
} | null;

function envKeys(env: Record<string, string | undefined>) {
  return {
    siteKey: env.TURNSTILE_SITE_KEY?.trim() || null,
    secretKey: env.TURNSTILE_SECRET_KEY?.trim() || null,
  };
}

/** What the owner sees: never the secret itself. Stored values win over the environment. */
export function turnstileView(row: Row, env: Record<string, string | undefined> = process.env) {
  const fallback = envKeys(env);
  const siteKey = row?.turnstileSiteKey || fallback.siteKey;
  const hasSecret = Boolean(row?.turnstileSecretCipher || fallback.secretKey);
  const enabled = row?.turnstileEnabled ?? Boolean(fallback.siteKey && fallback.secretKey);
  return { turnstileEnabled: enabled, turnstileSiteKey: siteKey, hasTurnstileSecret: hasSecret };
}

function loadRow(prisma: Pick<PrismaClient, "deploymentSettings">) {
  return prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { turnstileEnabled: true, turnstileSiteKey: true, turnstileSecretCipher: true },
  });
}

/** The site key a sign-up page renders, or null when the check is off or incomplete. */
export async function activeTurnstileSiteKey(
  prisma: Pick<PrismaClient, "deploymentSettings">,
): Promise<string | null> {
  const view = turnstileView(await loadRow(prisma));
  return view.turnstileEnabled && view.turnstileSiteKey && view.hasTurnstileSecret
    ? view.turnstileSiteKey
    : null;
}

/** Server-side secret for verifying a token. Null leaves signup unchecked. */
export async function activeTurnstileSecret(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  secrets: Pick<SecretStore, "load">,
): Promise<{ secretKey: string } | null> {
  const row = await loadRow(prisma);
  const view = turnstileView(row);
  if (!view.turnstileEnabled || !view.turnstileSiteKey) return null;
  const secretKey = row?.turnstileSecretCipher
    ? await secrets.load(row.turnstileSecretCipher, SECRET_RECORD_ID)
    : envKeys(process.env).secretKey;
  return secretKey ? { secretKey } : null;
}

/** Encrypts a new secret for storage; an empty value clears the stored one. */
export async function sealTurnstileSecret(
  secrets: Pick<SecretStore, "put">,
  secretKey: string,
  owner: { userId: string; spaceId: string },
): Promise<string | null> {
  const trimmed = secretKey.trim();
  if (!trimmed) return null;
  const stored = await secrets.put(
    trimmed,
    {
      operationId: "turnstile-secret",
      traceId: "turnstile-secret",
      userId: owner.userId,
      spaceId: owner.spaceId,
      signal: new AbortController().signal,
    },
    { recordId: SECRET_RECORD_ID },
  );
  return stored.ciphertext;
}
