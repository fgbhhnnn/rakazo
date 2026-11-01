import type { ConnectorTool } from "@rakazo/adapter-kit";

export const WEBSITE_LOGIN_UNAVAILABLE =
  'Saved website logins cannot be filled on this computer because it has no page browser. Use request_secret with auth type "command" and no origin for a command credential, then read its environment variable inside shell client code for WebDAV, API or curl work. Never print the value or pass it in argv. Do not request the website login again.';

export function websiteLoginUseError(pageBrowserAllowed: boolean): string {
  return pageBrowserAllowed
    ? "Website logins can only be filled into their site with browser_act."
    : WEBSITE_LOGIN_UNAVAILABLE;
}

export function passwordSubmissionNote(pageBrowserAllowed: boolean): string {
  return pageBrowserAllowed
    ? "The secret was not typed onto the computer. To reuse a website login, save it with auth type login and fill it with browser_act fill_secret; otherwise use request_takeover."
    : `The secret was not typed onto the computer. ${WEBSITE_LOGIN_UNAVAILABLE}`;
}

export function requestSecretGuidance(pageBrowserAllowed: boolean, browserActOffered: boolean) {
  const login = pageBrowserAllowed
    ? `, or with auth type login when the user wants a website login saved${browserActOffered ? "; fill it with browser_act fill_secret, which only works on the saved site" : ""}`
    : "";
  return `Use request_secret with a credential destination to save reusable API credentials${login}. When your shell commands need a secret value, use request_secret with auth type command; it is exported as the environment variable that request_secret and list_secrets report.${pageBrowserAllowed ? "" : ` ${WEBSITE_LOGIN_UNAVAILABLE}`}`;
}

/** Remove the login alternatives from the shared JSON schema without mutating the catalog. */
function withoutLogin(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutLogin);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      (key === "oneOf" || key === "anyOf") && Array.isArray(value)
        ? value.filter((branch) => branch.properties?.type?.const !== "login").map(withoutLogin)
        : key === "enum" && Array.isArray(value)
          ? value.filter((item) => item !== "login")
          : withoutLogin(value),
    ]),
  );
}

/** A dispatcher uses the worker capability; a worker uses its own run capability. */
export function credentialToolsForPageCapability(
  tools: ConnectorTool[],
  pageBrowserAllowed: boolean,
): ConnectorTool[] {
  if (pageBrowserAllowed) return tools;
  return tools.map((tool) => {
    if (tool.name === "purchase_status")
      return { ...tool, description: "Get a purchase's status." };
    if (tool.name !== "request_secret" && tool.name !== "generate_secret") return tool;
    return {
      ...tool,
      description:
        tool.name === "request_secret"
          ? `Collect a named API credential or command credential in protected input for this bot and user, or use connectionId for a one-use connector code. ${WEBSITE_LOGIN_UNAVAILABLE} Command credentials have no origin and are exported as environment variables: file-password becomes FILE_PASSWORD. Existing named credentials are reused unless replace is true. Never ask for a raw credential in chat.`
          : 'Create a random password or key with type "command" and save it for this bot and user; you never see the value. Read its environment variable in shell code. Set rules only when the service restricts characters. An existing credential is never replaced.',
      inputSchema: withoutLogin(tool.inputSchema) as ConnectorTool["inputSchema"],
    };
  });
}
