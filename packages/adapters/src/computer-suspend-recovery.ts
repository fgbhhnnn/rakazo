import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { SUSPEND_CLAIM_STALE_MS } from "./computer-health.js";
import type { StaleClaimComputer } from "./computer-stale-claim.js";
import { settleStaleClaimWithProvider } from "./computer-stale-claim.js";

/**
 * Waiting runs may all hold live leases, so none can reclaim a suspending computer through
 * the normal foreign-lease guard. Once every suspend deadline has passed, provider proof
 * that its disk is already stopped lets them use the idle job's fenced recovery instead.
 * True means the caller must reload the row, including when another recovery won the CAS.
 */
export async function settleStoppedSuspendBeforeProvision(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    events: Pick<ThreadEvents, "notify">;
  },
  computer: StaleClaimComputer & { state: string; maintenanceId: string | null },
): Promise<boolean> {
  if (
    computer.state !== "suspending" ||
    computer.kind === "desktop" ||
    computer.maintenanceId ||
    !computer.providerRef ||
    !deps.sandbox.isStopped ||
    !(computer.updatedAt instanceof Date) ||
    !Number.isFinite(computer.updatedAt.getTime()) ||
    Date.now() - computer.updatedAt.getTime() < SUSPEND_CLAIM_STALE_MS
  )
    return false;

  return (await settleStaleClaimWithProvider(deps, computer)) !== "unconfirmed";
}
