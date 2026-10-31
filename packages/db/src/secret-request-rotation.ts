import type { MessageBlock } from "@rakazo/contracts";

type SecretAsk = Extract<MessageBlock, { kind: "ask" }>;

/** Explicit API-key rotation is separate from retrying a failed website login. */
export function isExplicitApiKeyRotation(
  previous: SecretAsk,
  requested: SecretAsk,
  replace: boolean | undefined,
): boolean {
  const before = previous.credential;
  const after = requested.credential;
  return Boolean(
    replace &&
      previous.purpose === "api_key" &&
      requested.purpose === "api_key" &&
      before &&
      after &&
      before.auth.type !== "login" &&
      before.name === after.name &&
      before.origin === after.origin &&
      JSON.stringify(before.auth) === JSON.stringify(after.auth),
  );
}
