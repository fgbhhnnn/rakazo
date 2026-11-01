import { canonicalPiProviderId, usableModelId } from "@rakazo/contracts";
import { isBackgroundRunTrigger, redactSecrets } from "@rakazo/core";
import { withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { persistMessageInTransaction, runLeaseFor } from "./run-messages.js";

type Model = { provider: string; id: string };
type Reason = "connection_unavailable" | "setup_unavailable" | "runtime_failure";

const reasons: Record<Reason, { zh: string; en: string }> = {
  connection_unavailable: {
    zh: "配置的模型连接不可用",
    en: "configured model connection unavailable",
  },
  setup_unavailable: { zh: "首选模型无法启动", en: "primary model could not start" },
  runtime_failure: { zh: "运行中的模型无法继续", en: "running model could not continue" },
};

function sameModel(a: Model, b: Model) {
  return canonicalPiProviderId(a.provider) === canonicalPiProviderId(b.provider) && a.id === b.id;
}

/** Report resolution only; never writes bot settings, credentials, defaults or model choices. */
export function createRunModelFallbackReporter(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "runLease">,
  run: { id: string; botId: string; spaceId: string; threadId: string; trigger: string },
  input: {
    configured: { modelProvider: string | null; modelId: string | null };
    selected: { provider?: string | null; id?: string | null };
    connectionAvailable: boolean;
    hidden: boolean;
    secrets: string[];
  },
) {
  const configuredId = usableModelId(input.configured.modelId);
  const configured: Model | undefined =
    input.configured.modelProvider && configuredId
      ? { provider: input.configured.modelProvider, id: configuredId }
      : input.selected.provider && input.selected.id
        ? { provider: input.selected.provider, id: input.selected.id }
        : undefined;
  const reported = new Set<string>();
  return async (provider: string, id: string, phase: "start" | "runtime" = "start") => {
    const actual = { provider, id };
    if (!configured || sameModel(configured, actual)) return;
    const key = JSON.stringify(actual);
    if (reported.has(key)) return;
    reported.add(key);
    const reason: Reason =
      phase === "runtime"
        ? "runtime_failure"
        : !input.connectionAvailable &&
            !sameModel(configured, {
              provider: input.selected.provider ?? "",
              id: input.selected.id ?? "",
            })
          ? "connection_unavailable"
          : "setup_unavailable";
    getLogger().warn("model.fallback.used", {
      botId: run.botId,
      runId: run.id,
      configuredModel: configured,
      actualModel: actual,
      reason,
    });
    // Hidden workers report in logs; their private thread must not gain user-facing chatter.
    if (input.hidden || isBackgroundRunTrigger(run.trigger)) return;
    const label = (model: Model) => `${model.provider}/${model.id}`;
    const text = redactSecrets(
      `本轮使用 ${label(actual)}（配置：${label(configured)}；${reasons[reason].zh}）。\nThis turn uses ${label(actual)} (configured: ${label(configured)}; ${reasons[reason].en}).`,
      input.secrets,
    );
    // Lock the thread before checking the nonce, so retries/resumes across processes deduplicate.
    const clientNonce = `model-fallback:${run.id}:${provider}:${id}`;
    try {
      const committed = await withTransactionRetry(() =>
        deps.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
          const existing = await tx.message.findUnique({
            where: { threadId_clientNonce: { threadId: run.threadId, clientNonce } },
            select: { id: true },
          });
          if (existing) return undefined;
          return persistMessageInTransaction(
            tx,
            run,
            "system",
            [{ kind: "text", text }],
            false,
            clientNonce,
            false,
            runLeaseFor(deps, run.id),
          );
        }),
      );
      if (committed) await deps.events.notify(run.threadId, committed.eventSeq);
    } catch {
      // Reporting must not prevent the already-resolved model from handling the turn.
      getLogger().warn("model.fallback.notice_unavailable", { botId: run.botId, runId: run.id });
    }
  };
}
