import type { BrowserProvider, SandboxProvider } from "@rakazo/adapter-kit";
import { WEBSITE_LOGIN_UNAVAILABLE } from "./credential-page-capability.js";

/** Describe configured workers without provisioning a computer or taking its lease. */
export function workerPageBrowserAllowed(sandbox: SandboxProvider, browser: BrowserProvider) {
  return sandbox.describe().capabilities.graphical && browser.describe().capabilities.page;
}

export function dispatcherComputerGuidance(pageBrowserAllowed: boolean | undefined) {
  return pageBrowserAllowed
    ? "Worker computers have a page browser. Saved website logins can be filled on their saved site; pass the credential name to the worker."
    : `Worker computers have no page browser. ${WEBSITE_LOGIN_UNAVAILABLE} Ask for a command credential on the worker's behalf and pass its name to the worker. A missing page browser is not a rejected password; saving the login again cannot fix it.`;
}
