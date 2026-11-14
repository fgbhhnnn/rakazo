import { ORPCError } from "@orpc/server";
import {
  changeUserTimezone,
  effectiveModelRole,
  hasHostedModelCredits,
  isAutoReviewCheckerConfigured,
  loadUserIncomingCalls,
  PushSessionEndedError,
  settleCallRequest,
} from "@rakazo/adapters";
import type { ActionApprovalRule, Actor, Me, SettingsScope } from "@rakazo/contracts";
import {
  approvalModeFromPreference,
  approvalPreferenceFromMode,
  callRequestClientNonce,
} from "@rakazo/core";
import { urlSite } from "@rakazo/core/egress";
import {
  auditLogOrganization,
  commitBotUpdate,
  findAutoReviewPreference,
  findDefaultVoiceCredential,
  findModelCredential,
  findModelCredentialById,
  isDeploymentAdmin,
  isRecordNotFound,
  listApprovalRules,
  listAuditEvents,
  listVoicePreferences,
  lockSpaceSettings,
  newestVoiceCredentialOrder,
  Prisma,
  removeApprovalRule,
  runAsSystem,
  runAsTenant,
  saveApprovalRule,
  saveAutoReviewPreference,
  selectVoicePreference,
  sharedModelScope,
  sharedVoiceScope,
  voicePreferenceTarget,
  withinScope,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { createAccessGrant, listAccessGrants, revokeAccessGrant } from "../access-grants.js";
import { requireAdmin } from "../admins.js";
import { aiConsentStatus, allowAiConsent } from "../ai-consent.js";
import type { BillingService } from "../billing.js";
import { memberAndSignupCheckUpdate } from "../member-settings-guard.js";
import { firstModelConnectAnalytics } from "../model-connect-analytics.js";
import type { RouterDeps } from "../router.js";
import {
  accountVoiceCatalog,
  disconnectVoiceCredential,
  loadDefaultVoiceCredential,
  loadVoiceCredential,
  persistVoiceCredential,
  prepareVoice,
  toVoiceCredential,
  toVoiceStatus,
  updateVoiceSpeechModel,
  voiceContext,
  voiceCredentialHasKey,
  voiceCredentialServer,
  voiceProviderFor,
  withVoiceConnection,
} from "../voice.js";
import type { RouterContext } from "./context.js";
import { savedPasswordSettingsRoutes } from "./saved-password-settings.js";
import { deploymentDto, HEARTBEAT, meDto, mergeStreams, withHeartbeats } from "./shared.js";

const ROSTER_CHANGED = Symbol("roster changed");

export function accountRoutes(ctx: RouterContext) {
  const { deps, os, authed, ownerManaged } = ctx;
  return {
    ...savedPasswordSettingsRoutes(ctx),
    aiConsent: {
      status: authed.aiConsent.status.handler(({ context, input }) =>
        aiConsentStatus(deps, context.actor, input),
      ),
      allow: authed.aiConsent.allow.handler(({ context, input }) =>
        allowAiConsent(deps, context.actor, input),
      ),
      revoke: authed.aiConsent.revoke.handler(async ({ context, input }) => {
        await deps.prisma.aiDataConsent.deleteMany({
          where: {
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            recipientKey: input.key ?? undefined,
          },
        });
        return aiConsentStatus(deps, context.actor);
      }),
    },
    analytics: {
      screen: authed.analytics.screen.handler(async ({ context, input }) => {
        deps.analytics?.capture(context.actor.userId, { name: "screen_viewed", ...input });
        return { ok: true as const };
      }),
    },
    health: os.health.handler(async () => ({ ok: true as const, version: "0.1.0" })),
    me: authed.me.handler(async ({ context }): Promise<Me> => meDto(deps, context.actor)),
    billing: {
      selectFunding: authed.billing.selectFunding.handler(async ({ context, input }) => {
        const billing = requireBilling(deps);
        if (input.funding === "credits") {
          const record = await firstModelConnectAnalytics(deps, context.actor, "credits");
          record(undefined, { name: "model_connect_started" });
        }
        return billing.selectFunding(context.actor, input.funding, input.client, input.interval);
      }),
      purchaseCredits: authed.billing.purchaseCredits.handler(async ({ context, input }) =>
        requireBilling(deps).purchaseCredits(context.actor, input),
      ),
      setMonthlyCredits: authed.billing.setMonthlyCredits.handler(async ({ context, input }) =>
        requireBilling(deps).setMonthlyCredits(context.actor, input.amountCents),
      ),
      status: authed.billing.status.handler(async ({ context, input }) => {
        const billing = requireBilling(deps);
        // A failed claim fails the request, so the client keeps the code and sends it again.
        if (input?.referralCode) await billing.claimReferral(context.actor, input.referralCode);
        return billing.status(context.actor);
      }),
      refresh: authed.billing.refresh.handler(async ({ context }) => {
        const billing = requireBilling(deps);
        await billing.syncForActor(context.actor);
        return billing.status(context.actor);
      }),
      checkout: authed.billing.checkout.handler(async ({ context, input }) =>
        requireBilling(deps).checkout(context.actor, input?.client, input?.interval, input?.tier),
      ),
      portal: authed.billing.portal.handler(async ({ context, input }) =>
        requireBilling(deps).portal(context.actor, input?.client),
      ),
      endTrial: authed.billing.endTrial.handler(async ({ context }) => {
        const billing = requireBilling(deps);
        await billing.endTrial(context.actor);
        return billing.status(context.actor);
      }),
      switchToYearly: authed.billing.switchToYearly.handler(async ({ context }) => {
        const billing = requireBilling(deps);
        await billing.switchToYearly(context.actor);
        return billing.status(context.actor);
      }),
      changeTier: authed.billing.changeTier.handler(async ({ context, input }) => {
        const billing = requireBilling(deps);
        await billing.changeTier(context.actor, input.tier);
        return billing.status(context.actor);
      }),
      claimReferral: authed.billing.claimReferral.handler(async ({ context, input }) => {
        await requireBilling(deps).claimReferral(context.actor, input.code);
        return { ok: true as const };
      }),
    },
    accessGrants: {
      list: authed.accessGrants.list.handler(async ({ context }) => {
        await requireGrantAdmin(deps, context.actor);
        return listAccessGrants(deps.prisma);
      }),
      create: authed.accessGrants.create.handler(async ({ context, input }) => {
        await requireGrantAdmin(deps, context.actor);
        return createAccessGrant(deps.prisma, context.actor.userId, input);
      }),
      revoke: authed.accessGrants.revoke.handler(async ({ context, input }) => {
        await requireGrantAdmin(deps, context.actor);
        return revokeAccessGrant(deps.prisma, input.id);
      }),
    },
    preferences: {
      update: authed.preferences.update.handler(async ({ context, input }): Promise<Me> => {
        const userId = context.actor.userId;
        const botAvatarSet = input.botAvatarSet;
        if (input.timezone !== undefined) {
          // The routines that took the account zone keep their local schedule in the new
          // one, and the other fields commit in the same save. The move's row lock still
          // waits for any bot creation holding the user row, so no new bot is missed below.
          await changeUserTimezone(deps, userId, input.timezone, {
            ...(input.locale === undefined ? {} : { locale: input.locale }),
            ...(botAvatarSet === undefined ? {} : { botAvatarSet }),
          });
        } else {
          await deps.prisma.user.update({
            where: { id: userId },
            // An avatar style from an older app is accepted and ignored: there is only one.
            data: {
              ...(input.locale === undefined ? {} : { locale: input.locale }),
              ...(botAvatarSet === undefined ? {} : { botAvatarSet }),
            },
          });
        }
        if (botAvatarSet !== undefined) {
          // Every bot of this user not pinned to another set follows the new default, in every
          // space they own bots in, announced like any edit so other devices redraw it.
          const bots = await runAsSystem("restyle the user's own bots in all their spaces", () =>
            deps.prisma.bot.findMany({
              where: { userId, avatarSetPinned: false, avatarSet: { not: botAvatarSet } },
              select: { id: true, spaceId: true, thread: { select: { id: true } } },
            }),
          );
          for (const bot of bots) {
            const threadId = bot.thread?.id;
            if (!threadId) continue;
            // A newer save changed the default again: its own pass owns the remaining bots.
            const current = await deps.prisma.user.findUniqueOrThrow({
              where: { id: userId },
              select: { botAvatarSet: true },
            });
            if (current.botAvatarSet !== botAvatarSet) break;
            // The default is saved; a bot that fails here keeps its style until the next save.
            await runAsTenant({ spaceId: bot.spaceId, userId }, () =>
              commitBotUpdate({
                prisma: deps.prisma,
                notify: (thread, seq) => deps.events.notify(thread, seq),
                spaceId: bot.spaceId,
                threadId,
                botId: bot.id,
                emitBotUpdated: true,
                // Pinned since it was listed: leave the owner's choice alone.
                expectedSettings: { avatarSetPinned: false },
                // Re-read under lock inside the transaction: a newer save of the
                // default that lands while this writes owns the bot instead.
                expectedUserAvatarSet: { userId, botAvatarSet },
                data: { avatarSet: botAvatarSet },
              }),
            ).catch((error) => {
              if (!isRecordNotFound(error)) getLogger().error("bot style restyle", error);
            });
          }
        }
        return meDto(deps, context.actor);
      }),
      adoptTimezone: authed.preferences.adoptTimezone.handler(
        async ({ context, input }): Promise<Me> => {
          // Conditional in one statement: a concurrent explicit save always wins.
          await deps.prisma.user.updateMany({
            where: { id: context.actor.userId, timezone: null },
            data: { timezone: input.timezone },
          });
          return meDto(deps, context.actor);
        },
      ),
    },
    // Retain wire compatibility for older clients; only RAKAZO_ADMIN_EMAILS admins have authority.
    deployment: {
      // Only admins named in RAKAZO_ADMIN_EMAILS may read or change these.
      get: authed.deployment.get.handler(({ context }) => {
        if (!isDeploymentAdmin(context.actor)) throw new ORPCError("FORBIDDEN");
        return deploymentDto(deps.prisma, deps.env.sandboxProvider);
      }),
      update: authed.deployment.update.handler(async ({ context, input }) => {
        if (!isDeploymentAdmin(context.actor)) throw new ORPCError("FORBIDDEN");
        if (input.computerHost === "this-mac" && deps.env.sandboxProvider !== "docker") {
          throw new ORPCError("BAD_REQUEST", {
            message:
              "This Mac mode is only available when SANDBOX_PROVIDER=docker on a personal local app.",
          });
        }
        await deps.prisma.deploymentSettings.upsert({
          where: { id: "default" },
          create: {
            id: "default",
            ownerUserId: context.actor.userId,
            signupsEnabled: input.signupsEnabled ?? true,
            signupAllowlist: (input.signupAllowlist ?? []).join(","),
            signupPolicyInitialized: true,
            computerHost: input.computerHost ?? undefined,
          },
          update: {
            ...(input.signupsEnabled === undefined ? {} : { signupsEnabled: input.signupsEnabled }),
            ...(input.signupAllowlist ? { signupAllowlist: input.signupAllowlist.join(",") } : {}),
            ...(input.signupsEnabled === undefined && input.signupAllowlist === undefined
              ? {}
              : { signupPolicyInitialized: true }),
            ...(input.computerHost === undefined ? {} : { computerHost: input.computerHost }),
            ...(await memberAndSignupCheckUpdate(deps.secrets, context.actor, input)),
          },
        });
        return deploymentDto(deps.prisma, deps.env.sandboxProvider);
      }),
    },
    security: {
      events: authed.security.events.handler(() => {
        throw new ORPCError("FORBIDDEN");
      }),
    },
    audit: {
      events: authed.audit.events.handler(async ({ context, input }) => {
        const organizationId = await auditLogOrganization(deps.prisma, context.actor);
        if (!organizationId) throw new ORPCError("FORBIDDEN");
        return runAsSystem("read the organization's audit log", () =>
          listAuditEvents(deps.prisma, organizationId, input),
        );
      }),
    },
    updater: {
      status: authed.updater.status.handler(() => {
        throw new ORPCError("FORBIDDEN");
      }),
      check: authed.updater.check.handler(() => {
        throw new ORPCError("FORBIDDEN");
      }),
      apply: authed.updater.apply.handler(() => {
        throw new ORPCError("FORBIDDEN");
      }),
    },
    // The allow/block lists are owner/admin settings on a locked deployment; members still read
    // them. The approval mode is each member's own choice even there: it writes only the actor's
    // own account copy (or their own Space copy), never another user's.
    approvalRules: {
      list: authed.approvalRules.list.handler(async ({ context, input }) => {
        const rows = await listApprovalRules(deps.prisma, context.actor, input?.scope);
        return rows.map(approvalRuleDto);
      }),
      set: ownerManaged.approvalRules.set.handler(async ({ context, input }) => {
        const { scope, ...rule } = input;
        return approvalRuleDto(
          await deps.prisma.$transaction((tx) => saveApprovalRule(tx, context.actor, rule, scope)),
        );
      }),
      remove: ownerManaged.approvalRules.remove.handler(async ({ context, input }) => {
        await deps.prisma.$transaction((tx) =>
          removeApprovalRule(tx, context.actor, input.id, input.scope),
        );
        return { ok: true as const };
      }),
    },
    // The user's own list for the external-link prompt, kept apart from approval rules: a
    // trusted link site never lets a bot fetch, and a site rule never skips the prompt.
    trustedLinkSites: {
      list: authed.trustedLinkSites.list.handler(async ({ context }) => {
        const rows = await deps.prisma.trustedLinkSite.findMany({
          where: { userId: context.actor.userId },
          orderBy: { site: "asc" },
        });
        return rows.map((row) => row.site);
      }),
      trust: authed.trustedLinkSites.trust.handler(async ({ context, input }) => {
        // The server names the site, so the list only ever holds sites.
        const site = urlSite(input.url);
        if (!site) throw new ORPCError("BAD_REQUEST", { message: "Not a web link." });
        await deps.prisma.trustedLinkSite.createMany({
          data: { userId: context.actor.userId, site },
          skipDuplicates: true,
        });
        return { site };
      }),
      remove: authed.trustedLinkSites.remove.handler(async ({ context, input }) => {
        await deps.prisma.trustedLinkSite.deleteMany({
          where: { userId: context.actor.userId, site: input.site },
        });
        return { ok: true as const };
      }),
    },
    autoReview: {
      get: authed.autoReview.get.handler(async ({ context, input }) => {
        return loadAutoReviewSettings(deps, context.actor, input?.scope);
      }),
      set: authed.autoReview.set.handler(async ({ context, input }) => {
        await deps.prisma.$transaction((tx) =>
          saveAutoReviewPreference(
            tx,
            context.actor,
            input.mode
              ? approvalPreferenceFromMode(input.mode)
              : { enabled: input.enabled, skipApprovals: input.skipApprovals },
            { enabled: true, skipApprovals: false },
            input.scope,
          ),
        );
        return loadAutoReviewSettings(deps, context.actor, input.scope);
      }),
    },
    notifications: {
      subscribe: authed.notifications.subscribe.handler(async function* ({ context }) {
        const { followChatAlerts, followRosterChanges } = deps.events;
        if (!followChatAlerts) throw new ORPCError("NOT_FOUND");
        const { spaceId, userId } = context.actor;
        const rosterChanges = async function* (
          signal: AbortSignal,
        ): AsyncGenerator<typeof ROSTER_CHANGED> {
          if (!followRosterChanges) return;
          // Chat alerts keep flowing if roster signals fail; the client falls back to polling.
          try {
            for await (const _ of followRosterChanges(userId, signal)) yield ROSTER_CHANGED;
          } catch {}
        };
        const frames = withHeartbeats(context, (signal) =>
          mergeStreams(followChatAlerts(userId, spaceId, signal), rosterChanges(signal)),
        );
        for await (const next of frames) {
          if (next === HEARTBEAT) yield { type: "heartbeat" as const };
          else if (next === ROSTER_CHANGED) yield { type: "roster" as const };
          else if (next.spaceId === spaceId) yield { type: "alert" as const, alert: next };
        }
      }),
      subscribeCalls: authed.notifications.subscribeCalls.handler(async function* ({ context }) {
        const { followIncomingCalls } = deps.events;
        if (!deps.env?.phoneCallsEnabled || !followIncomingCalls) throw new ORPCError("NOT_FOUND");
        const { userId } = context.actor;
        const signals = withHeartbeats(context, (signal) => followIncomingCalls(userId, signal));
        for await (const next of signals) {
          yield next === HEARTBEAT
            ? { type: "heartbeat" as const }
            : {
                type: "incoming.calls" as const,
                payload: { calls: await loadUserIncomingCalls(deps.prisma, userId) },
              };
        }
      }),
      declineIncomingCall: authed.notifications.declineIncomingCall.handler(
        async ({ context, input }) => {
          if (!deps.env?.phoneCallsEnabled) throw new ORPCError("NOT_FOUND");
          // A locked device has only the call id, and may be viewing a different Space.
          const settled = await runAsSystem(
            "decline the signed-in call owner's incoming call",
            async () => {
              const message = await deps.prisma.message.findFirst({
                where: {
                  clientNonce: callRequestClientNonce(input.callId),
                  role: "bot",
                  thread: {
                    userId: context.actor.userId,
                    groupId: null,
                    bot: { userId: context.actor.userId },
                  },
                },
                select: { threadId: true },
              });
              if (!message) throw new ORPCError("NOT_FOUND");
              return settleCallRequest(deps, {
                threadId: message.threadId,
                callId: input.callId,
                from: ["ringing"],
                status: "declined",
              });
            },
          );
          if (settled?.status !== "declined") throw new ORPCError("CONFLICT");
          return { ok: true as const };
        },
      ),
      registerCallPush: authed.notifications.registerCallPush.handler(
        async ({ context, input }) => {
          if (!context.sessionId) throw new ORPCError("UNAUTHORIZED");
          try {
            await deps.pushTokens.saveDevice?.(context.actor.userId, input, context.sessionId);
          } catch (error) {
            if (error instanceof PushSessionEndedError) throw new ORPCError("UNAUTHORIZED");
            throw error;
          }
          return { ok: true as const };
        },
      ),
      registerPush: authed.notifications.registerPush.handler(async ({ context, input }) => {
        const sessionId = context.sessionId;
        if (!sessionId) throw new ORPCError("UNAUTHORIZED");
        try {
          await deps.pushTokens.save(
            context.actor.userId,
            input.token,
            sessionId,
            input.presentation,
          );
        } catch (error) {
          if (error instanceof PushSessionEndedError) throw new ORPCError("UNAUTHORIZED");
          throw error;
        }
        return { ok: true as const };
      }),
      unregisterPush: authed.notifications.unregisterPush.handler(async ({ context }) => {
        if (context.sessionId) {
          // Only the calling session's registration: another device of this account,
          // which registered from its own session, keeps its notifications.
          await deps.pushTokens.endSession(context.actor.userId, context.sessionId);
          return { ok: true as const };
        }
        await deps.pushTokens.remove(context.actor.userId);
        return { ok: true as const };
      }),
      followWorkActivity: authed.notifications.followWorkActivity.handler(
        async ({ context, input }) => {
          // The card ends with the session that registered it.
          if (!context.sessionId) throw new ORPCError("UNAUTHORIZED");
          const following = await deps.workActivities?.register(
            context.actor.userId,
            context.sessionId,
            input.token,
          );
          return { following: following ?? false };
        },
      ),
      registerWorkActivityStarts: authed.notifications.registerWorkActivityStarts.handler(
        async ({ context, input }) => {
          // The phone stops getting cards with the session that registered it.
          if (!context.sessionId) throw new ORPCError("UNAUTHORIZED");
          await deps.workActivities?.registerStarts(
            context.actor.userId,
            context.sessionId,
            input.token,
          );
          return { ok: true as const };
        },
      ),
    },
    voice: {
      catalog: authed.voice.catalog.handler(async ({ context }) =>
        accountVoiceCatalog(deps, context.actor),
      ),
      status: authed.voice.status.handler(async ({ context, input }) => {
        // A member of a shared deployment sees the owner's voice, whichever copy applies to the owner.
        const scope = await sharedVoiceScope(deps.prisma, context.actor);
        const cred = await findDefaultVoiceCredential(
          deps.prisma,
          scope,
          scope.userId === context.actor.userId ? input?.scope : undefined,
        );
        return toVoiceStatus(cred);
      }),
      credentials: authed.voice.credentials.handler(async ({ context, input }) => {
        const target = await voicePreferenceTarget(deps.prisma, context.actor, input?.scope);
        const [rows, preferences] = await Promise.all([
          deps.prisma.userVoiceCredential.findMany({
            where: { userId: context.actor.userId },
            orderBy: newestVoiceCredentialOrder,
          }),
          listVoicePreferences(deps.prisma, target),
        ]);
        return Promise.all(
          rows.map(async (row) => {
            const preference = preferences.find((saved) => saved.credentialId === row.id);
            return toVoiceCredential({
              ...row,
              isDefault: preference?.isDefault ?? false,
              voiceId: preference?.voiceId ?? "",
              speechModel: preference?.speechModel ?? "",
              server: await voiceCredentialServer(deps, context.actor, row),
              hasKey: await voiceCredentialHasKey(deps, context.actor, row),
            });
          }),
        );
      }),
      connect: ownerManaged.voice.connect.handler(async ({ context, input }) =>
        persistVoiceCredential(deps, context.actor, {
          provider: input.provider,
          plaintext: input.apiKey,
          voiceId: input.voiceId,
          speechModel: input.speechModel,
          baseUrl: input.baseUrl,
          ttsModel: input.ttsModel,
          sttModel: input.sttModel,
          scope: input.scope,
          signal: context.signal,
        }),
      ),
      disconnect: ownerManaged.voice.disconnect.handler(async ({ context, input }) =>
        disconnectVoiceCredential(deps, context.actor, { provider: input.provider }),
      ),
      setVoice: ownerManaged.voice.setVoice.handler(async ({ context, input }) => {
        const cred = await withTransactionRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              await lockSpaceSettings(tx, context.actor);
              const target = await voicePreferenceTarget(tx, context.actor, input.scope);
              const found = input.provider
                ? await tx.userVoiceCredential.findFirst({
                    where: { userId: context.actor.userId, provider: input.provider },
                    orderBy: newestVoiceCredentialOrder,
                  })
                : await findDefaultVoiceCredential(tx, context.actor, target.scope);
              if (!found) {
                throw new ORPCError("BAD_REQUEST", { message: "Connect a voice provider first." });
              }
              // Picking a voice also makes its provider the one speak/transcribe use.
              await selectVoicePreference(tx, target, found.id, input.voiceId);
              return { ...found, voiceId: input.voiceId, isDefault: true };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        return toVoiceStatus(cred);
      }),
      setSpeechModel: ownerManaged.voice.setSpeechModel.handler(async ({ context, input }) =>
        updateVoiceSpeechModel(deps, context.actor, input),
      ),
      voices: authed.voice.voices.handler(async ({ context, input }) => {
        // A named provider lists its voices even before the copy has a default voice.
        const row = input.provider
          ? await loadVoiceCredential(
              deps,
              context.actor,
              input.provider,
              input.scope,
              context.signal,
            )
          : await loadDefaultVoiceCredential(deps, context.actor, input.scope, context.signal);
        if (!row) return [];
        const provider = await voiceProviderFor(deps, row.cred.provider);
        return withVoiceConnection(row.cred.provider, row.linked, () =>
          provider.listVoices(row.apiKey, voiceContext(context.actor, context.signal), {
            language: input.language,
          }),
        );
      }),
      prepare: authed.voice.prepare.handler(async ({ context, input }) =>
        prepareVoice(deps, context.actor, { ...input, signal: context.signal }),
      ),
    },
  };
}

function approvalRuleDto(row: {
  id: string;
  effect: string;
  matchKind: string;
  matchValue: string;
  createdAt: Date;
}): ActionApprovalRule {
  return {
    id: row.id,
    effect: row.effect as ActionApprovalRule["effect"],
    matchKind: row.matchKind as ActionApprovalRule["matchKind"],
    matchValue: row.matchValue,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadAutoReviewSettings(deps: RouterDeps, actor: Actor, scope?: SettingsScope) {
  // A member on shared models is judged by what their runs use (run-trust.ts): the approval
  // model and connections of the owner, as they apply where the owner reads them, on every page.
  const modelScope = await sharedModelScope(deps.prisma, actor);
  const borrowed = modelScope.userId !== actor.userId;
  const [role, preference] = await Promise.all([
    // The account page judges the account's approval model; a Space, the one that applies there.
    effectiveModelRole(
      deps.prisma,
      modelScope,
      "approval",
      { env: process.env },
      scope === "account" && !borrowed ? "account" : undefined,
    ),
    findAutoReviewPreference(deps.prisma, actor, scope),
  ]);
  const stored = {
    enabled: preference?.enabled ?? true,
    skipApprovals: preference?.skipApprovals ?? false,
  };
  const settings = { ...stored, mode: approvalModeFromPreference(stored) };
  const deploymentChecker = role.primarySource === "deployment" ? role.primary : null;
  const memberChoices = [
    ...(deploymentChecker || !role.primary ? [] : [role.primary]),
    ...role.backups,
  ];
  const environmentAvailable = isAutoReviewCheckerConfigured({ env: process.env });
  if (memberChoices.length === 0) {
    // The deployment's checker runs on its own configuration or on the member's key for it.
    const requiredUserProvider =
      environmentAvailable || deploymentChecker?.provider === "scripted"
        ? null
        : deploymentChecker?.provider;
    const credential = requiredUserProvider
      ? await withinScope(modelScope, () =>
          deps.prisma.userModelCredential.findFirst({
            where: { userId: modelScope.userId, provider: requiredUserProvider },
            select: { id: true },
          }),
        )
      : null;
    return { ...settings, checkerAvailable: environmentAvailable || Boolean(credential) };
  }
  // These read the connections as the owner of the scope they are given.
  const connections = await Promise.all(
    memberChoices.map((choice) =>
      choice.credentialId
        ? findModelCredentialById(deps.prisma, modelScope, choice.credentialId)
        : findModelCredential(deps.prisma, modelScope, choice.provider, choice.modelId),
    ),
  );
  const checkerAvailable =
    connections.some(Boolean) ||
    (deploymentChecker !== null && environmentAvailable) ||
    (
      await Promise.all(
        [...new Set(memberChoices.map((choice) => choice.provider))].map((provider) =>
          hasHostedModelCredits(deps.prisma, actor, provider),
        ),
      )
    ).some(Boolean);
  return { ...settings, checkerAvailable };
}

function requireBilling(deps: RouterDeps): BillingService {
  if (!deps.billing) throw new ORPCError("NOT_FOUND", { message: "Billing is not enabled" });
  return deps.billing;
}

async function requireGrantAdmin(deps: RouterDeps, actor: Actor) {
  await requireAdmin(deps, actor.userId);
  if (!deps.billing?.modelCreditsEnabled)
    throw new ORPCError("NOT_FOUND", { message: "Model credits are not enabled" });
}
