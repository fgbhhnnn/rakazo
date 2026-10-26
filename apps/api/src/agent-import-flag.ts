/**
 * Agent import (bots.import*) is off on this deployment unless RAKAZO_AGENT_IMPORT_ENABLED is
 * "true". Read per call, so the web flag (apps/web/src/lib/agent-import-flag.ts) and this one can
 * be turned on together without a schema change: the agent_imports table exists either way.
 */
export function agentImportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RAKAZO_AGENT_IMPORT_ENABLED?.trim().toLowerCase() === "true";
}
