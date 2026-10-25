/**
 * Importing another product's agent (upstream's agent import) is not offered on this
 * deployment. While false, no web entry point is wired and the server refuses bots.import*
 * unless RAKAZO_AGENT_IMPORT_ENABLED=true. Only the e2e harness builds with
 * VITE_AGENT_IMPORT_ENABLED=true, so upstream's import specs keep running; production
 * images never set it.
 */
const AGENT_IMPORT_DEFAULT = false;

export const AGENT_IMPORT_ENABLED: boolean =
  AGENT_IMPORT_DEFAULT || import.meta.env.VITE_AGENT_IMPORT_ENABLED === "true";
