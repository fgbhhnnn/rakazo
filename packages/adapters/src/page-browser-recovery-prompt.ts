/** Login recovery must stay on the browser whose frames fill_secret can inspect. */
export function pageBrowserRecoveryGuidance(allowed: boolean, disabled?: ReadonlySet<string>) {
  if (!allowed || disabled?.has("browser_act")) return undefined;
  const restart = disabled?.has("browser_restart")
    ? "If the page browser keeps timing out, report the failure to the user early."
    : "After two consecutive page-browser timeouts, call browser_restart, then navigate to the site again. If it still fails, report the failure to the user early.";
  return `For website logins, prefer the page browser. ${restart} Never open a separate desktop Chrome through launch_app or computer tools for a login: fill_secret cannot see that browser.`;
}

/** Match the helper's factual timeout result, so a fallback note cannot undo its recovery advice. */
export function pageBrowserTimeoutNote(error: string | undefined) {
  return error?.startsWith("Page browser timed out")
    ? "Call browser_restart before continuing. Do not replay completed or uncertain actions."
    : undefined;
}
