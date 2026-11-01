import type { PrismaClient } from "@rakazo/db";
import { getSavedPasswordSettings } from "@rakazo/db";
import { findBotSecret, resolveLoginFill } from "./bot-secrets.js";
import { revealedRuns } from "./reveal-secret-redaction.js";
import { RevealSecretInput } from "./reveal-secret-tool.js";
import { addRunSecrets } from "./run-context.js";
import type { ToolHandler } from "./run-tool-gate.js";

/** A settings outage must withhold this optional tool without stopping ordinary bot work. */
export async function passwordRevealAllowed(prisma: PrismaClient, userId: string) {
  try {
    return (await getSavedPasswordSettings(prisma, userId)).allowBotPasswordReveal;
  } catch {
    return false;
  }
}

export const revealSecret: ToolHandler = async (ctx, call) => {
  const fail = (error: string) => call.finish({ error });
  // Read again per call: withdrawing consent takes effect even in an already running turn.
  if (!(await passwordRevealAllowed(ctx.deps.prisma, ctx.secretScope.userId))) {
    return fail("Direct use of saved passwords is disabled for this account.");
  }
  const parsed = RevealSecretInput.safeParse(call.args);
  if (!parsed.success) return fail("A saved login name, field and HTTPS origin are required.");
  if (ctx.computer.heldForTakeover) return fail("The computer is held for user takeover.");
  try {
    const { name, field, origin } = parsed.data;
    const destination = await findBotSecret(ctx.deps.prisma, ctx.secretScope, name);
    if (destination?.auth.type !== "login") {
      return fail("This saved website login is unavailable.");
    }
    if (new URL(origin).protocol !== "https:" || new URL(origin).origin !== destination.origin) {
      return fail("The login can only be used on its saved HTTPS origin.");
    }
    // Do not trust a model-supplied URL as evidence of the active page's domain.
    const page = await ctx.providers.browser.snapshot(
      await ctx.computer.get("tool", "reveal_secret"),
      {},
      ctx.context,
    );
    if (page.error || new URL(page.url).origin !== destination.origin) {
      return fail("Open the login's saved HTTPS origin before revealing a field.");
    }
    const resolved = await resolveLoginFill({
      prisma: ctx.deps.prisma,
      secretStore: ctx.deps.secretStore,
      scope: ctx.secretScope,
      runId: ctx.run.id,
      name,
      field,
    });
    if ("error" in resolved) return fail(resolved.error);
    if (resolved.origin !== destination.origin) return fail("The login origin changed. Try again.");
    if (!(await passwordRevealAllowed(ctx.deps.prisma, ctx.secretScope.userId))) {
      return fail("Direct use of saved passwords is disabled for this account.");
    }
    addRunSecrets(
      ctx,
      [
        ...resolved.redactions,
        resolved.text,
        JSON.stringify(resolved.text).slice(1, -1),
        encodeURIComponent(resolved.text),
        Buffer.from(resolved.text).toString("base64"),
        new URLSearchParams({ v: resolved.text }).toString().slice(2),
      ].filter(Boolean),
    );
    revealedRuns.add(ctx);
    // Persist only a placeholder, even if the gate later treats this tool as an effect.
    const saved = await call.finish({ value: "[redacted]", origin: resolved.origin });
    if (saved && typeof saved === "object" && "error" in saved) return saved;
    return { value: resolved.text, origin: resolved.origin };
  } catch {
    // Store/provider errors can contain decrypted data. Never log or return them.
    return fail("The saved login could not be revealed.");
  }
};
