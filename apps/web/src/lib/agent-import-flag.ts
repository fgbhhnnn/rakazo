/**
 * Importing another product's agent (upstream's agent import) is not offered on this
 * deployment. While false, no web entry point is wired and the server refuses bots.import*.
 * Flip with the server flag (RAKAZO_AGENT_IMPORT_ENABLED) to turn the feature back on.
 */
export const AGENT_IMPORT_ENABLED = false;
