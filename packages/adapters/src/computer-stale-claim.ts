import type { AdapterContext, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { recordComputerRunEnd } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { recordComputerResponsive, withDeadline } from "./computer-health.js";
import { toComputerRef } from "./computer-support.js";

/*
 * A "suspending" claim past its deadlines belongs to a sleep job that died mid-checkpoint, most
 * often with its worker in a deploy. By the time the claim is stale the provider has usually
 * stopped the sandbox on its own (E2B pauses one when its timeout passes). Taking such a
 * computer back to "running" and counting a failed check is wrong twice over: nothing failed
 * on the computer, and every later idle check repeats it until the owner is asked to restart a
 * healthy computer. When the provider confirms it holds the sandbox stopped with its disk kept,
 * the computer is asleep: the claim becomes "suspended" and the health record is reset, which
 * also closes an open restart card. Without that confirmation nothing changes here.
 */

/** How long the read-only provider status check may take. */
export const STALE_CLAIM_PROBE_DEADLINE_MS = 20_000;

export type StaleClaimComputer = {
  id: string;
  spaceId: string;
  userId: string;
  kind: string;
  homeKey: string;
  providerRef: string | null;
  runningSince: Date | null;
  controlBotId: string | null;
  updatedAt: Date;
};

export type StaleClaimOutcome =
  /** The provider holds it stopped; the computer is now "suspended". */
  | "suspended"
  /** The provider holds it stopped, but someone else changed the claim first. */
  | "superseded"
  /** No confirmation that it is stopped: running, gone, unsupported, or the check failed. */
  | "unconfirmed";

export async function settleStaleClaimWithProvider(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    events: Pick<ThreadEvents, "notify">;
    probeMs?: number;
  },
  computer: StaleClaimComputer,
): Promise<StaleClaimOutcome> {
  if (!computer.providerRef || !deps.sandbox.isStopped) return "unconfirmed";
  const isStopped = deps.sandbox.isStopped.bind(deps.sandbox);
  const ref = toComputerRef(computer);
  const probeMs = deps.probeMs ?? STALE_CLAIM_PROBE_DEADLINE_MS;
  let stopped: boolean;
  try {
    stopped = await withDeadline(
      probeMs,
      (signal) => isStopped(ref, staleClaimContext(computer, signal)),
      () => new Error(`provider status did not answer within ${Math.round(probeMs / 1000)} s`),
    );
  } catch (error) {
    getLogger().warn("computer.stale_claim_probe_failed", {
      "computer.id": computer.id,
      provider: computer.kind,
      error,
    });
    return "unconfirmed";
  }
  if (!stopped) return "unconfirmed";

  const settled = await deps.prisma.computer.updateMany({
    where: {
      id: computer.id,
      state: "suspending",
      providerRef: computer.providerRef,
      updatedAt: computer.updatedAt,
    },
    data: {
      state: "suspended",
      runningSince: null,
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      controlBotId: null,
      controlRunId: null,
    },
  });
  if (settled.count !== 1) return "superseded";
  await recordComputerRunEnd(deps.prisma, computer, "gone");
  // The provider answered and holds the computer as it was: not a failed check.
  await recordComputerResponsive(deps, computer);
  getLogger().info("computer.suspend_claim_settled", {
    "computer.id": computer.id,
    provider: computer.kind,
    reason: "provider_stopped",
    claimAgeMs: Date.now() - computer.updatedAt.getTime(),
  });
  return "suspended";
}

function staleClaimContext(computer: StaleClaimComputer, signal: AbortSignal): AdapterContext {
  return {
    operationId: "computer.sleep",
    traceId: "computer.sleep",
    spaceId: computer.spaceId,
    userId: computer.userId,
    botId: computer.controlBotId ?? undefined,
    signal,
  };
}
