import type { BotSecretDestination, LoginFailureReason } from "@rakazo/contracts";
import type { PauseRunForInput, ThreadEvents } from "@rakazo/db";
import { checkSecretRequestPolicy, SecretRequestBlockedError } from "@rakazo/db";
import type { RunContext } from "./run-context.js";
import { normalizeSecretAskPurpose } from "./run-secret.js";

/** Keep a concurrent answer/dismissal a tool error, without failing the whole turn. */
export async function pauseSecretRequest(events: ThreadEvents, input: PauseRunForInput) {
  try {
    return await events.pauseRunForInput(input);
  } catch (error) {
    if (error instanceof SecretRequestBlockedError)
      return { error: error.message, code: error.code };
    throw error;
  }
}

export async function newSecretRequestPolicyError(
  ctx: RunContext,
  args: Record<string, unknown>,
  destination: BotSecretDestination | undefined,
  failureReason: LoginFailureReason | undefined,
) {
  try {
    await checkSecretRequestPolicy(ctx.deps.prisma, {
      ...ctx.run,
      runId: ctx.runId,
      ask: {
        kind: "ask",
        text: "",
        input: "secret",
        credential: destination,
        purpose: normalizeSecretAskPurpose(args.purpose ? String(args.purpose) : undefined),
      },
      failureReason,
    });
  } catch (error) {
    if (error instanceof SecretRequestBlockedError)
      return { error: error.message, code: error.code };
    throw error;
  }
  return undefined;
}
