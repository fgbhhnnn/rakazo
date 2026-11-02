import type { ComputerTier } from "@rakazo/adapter-kit";
import { isDeploymentAdmin } from "@rakazo/db";

export type { ComputerTier } from "@rakazo/adapter-kit";

export const COMPUTER_TIER_RESOURCES = {
  large: { cpu: 8, memory: 8 },
  standard: { cpu: 2, memory: 4 },
} as const satisfies Record<ComputerTier, { cpu: number; memory: number }>;

export function computerTierFor(user: { email?: string | null }): ComputerTier {
  return isDeploymentAdmin(user) ? "large" : "standard";
}
