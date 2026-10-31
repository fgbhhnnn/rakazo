/** Dispatchers collect credentials for workers without gaining their computer tools. */
export function runCredentialPageBrowserAllowed(ctx: {
  credentialPageBrowserAllowed?: boolean;
  computer: { pageBrowserAllowed: boolean };
}): boolean {
  return ctx.credentialPageBrowserAllowed ?? ctx.computer.pageBrowserAllowed;
}
