import { describe, expect, it } from "vitest";
import { resolveSandboxProvider, sandboxProviderOptionsFromEnv } from "./sandbox-provider-env.js";

describe("resolveSandboxProvider", () => {
  it("defaults to docker", () => {
    expect(resolveSandboxProvider({})).toBe("docker");
  });

  it("keeps explicit none", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "none" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "" })).toBe("none");
  });

  it("falls back to none when a remote provider key is missing", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "e2b" })).toBe("none");
    expect(
      resolveSandboxProvider({ SANDBOX_PROVIDER: "novita", E2B_API_KEY: "test-e2b-key" }),
    ).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "daytona" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "createos" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "boat" })).toBe("none");
    const wuying = {
      SANDBOX_PROVIDER: "wuying",
      WUYING_ACCESS_KEY_ID: "test-id",
      WUYING_ACCESS_KEY_SECRET: "test-secret",
      WUYING_DESKTOP_ID: "ecd-test",
      WUYING_END_USER_ID: "test-user",
      WUYING_MCP_URL: "https://gateway.example.com/mcp",
      WUYING_MCP_TOKEN: "test-token",
    };
    expect(resolveSandboxProvider(wuying)).toBe("wuying");
    expect(resolveSandboxProvider({ ...wuying, WUYING_MCP_TOKEN: " " })).toBe("none");
  });

  it("loads Novita credentials and the shared template setting", () => {
    const env = {
      SANDBOX_PROVIDER: "novita",
      NOVITA_API_KEY: " test-novita-key ",
      SANDBOX_TEMPLATE: " custom-desktop ",
    };
    expect(resolveSandboxProvider(env)).toBe("novita");
    expect(sandboxProviderOptionsFromEnv(env)).toMatchObject({
      novitaApiKey: "test-novita-key",
      sandboxTemplate: "custom-desktop",
    });
  });

  it("requires both Railway credentials and an environment", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "railway" })).toBe("none");
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "railway", RAILWAY_API_TOKEN: "test" })).toBe(
      "none",
    );
    const env = {
      SANDBOX_PROVIDER: "railway",
      RAILWAY_API_TOKEN: "test",
      RAILWAY_ENVIRONMENT_ID: "environment",
      RAILWAY_MAX_WORKSPACE_FILE_BYTES: "1024",
    };
    expect(resolveSandboxProvider(env)).toBe("railway");
    expect(sandboxProviderOptionsFromEnv(env)).toMatchObject({
      railwayApiToken: "test",
      railwayEnvironmentId: "environment",
      railwayMaxWorkspaceFileBytes: "1024",
    });
  });

  it("keeps boxd when its API key is set, with an optional organization", () => {
    expect(resolveSandboxProvider({ SANDBOX_PROVIDER: "boxd" })).toBe("none");
    const env = { SANDBOX_PROVIDER: "boxd", BOXD_API_KEY: "test-boxd-key", BOXD_ORG: "team" };
    expect(resolveSandboxProvider(env)).toBe("boxd");
    expect(sandboxProviderOptionsFromEnv(env)).toMatchObject({
      boxdApiKey: "test-boxd-key",
      boxdOrg: "team",
    });
  });

  it("keeps CreateOS when its API key is set", () => {
    expect(
      resolveSandboxProvider({
        SANDBOX_PROVIDER: "createos",
        CREATEOS_SANDBOX_API_KEY: "test-createos-key",
      }),
    ).toBe("createos");
  });

  it("falls back to none in production when Docker has no supervisor token", () => {
    expect(
      resolveSandboxProvider({
        NODE_ENV: "production",
        SANDBOX_PROVIDER: "docker",
      }),
    ).toBe("none");
  });

  it("keeps docker in production when a supervisor token is set", () => {
    expect(
      resolveSandboxProvider({
        NODE_ENV: "production",
        SANDBOX_PROVIDER: "docker",
        SANDBOX_SUPERVISOR_TOKEN: "prod-supervisor-token-with-enough-length",
      }),
    ).toBe("docker");
  });
});

describe("sandboxProviderOptionsFromEnv", () => {
  it("loads CreateOS settings from the shared env contract", () => {
    expect(
      sandboxProviderOptionsFromEnv({
        CREATEOS_SANDBOX_API_KEY: "test-createos-key",
        CREATEOS_SANDBOX_BASE_URL: "https://api.example.test",
        CREATEOS_SANDBOX_SHAPE: "s-4vcpu-8gb",
        CREATEOS_SANDBOX_ROOTFS: "desktop:2",
      }),
    ).toMatchObject({
      createosApiKey: "test-createos-key",
      createosBaseUrl: "https://api.example.test",
      createosShape: "s-4vcpu-8gb",
      createosRootfs: "desktop:2",
    });
  });

  it("loads the Railway sandbox region", () => {
    expect(
      sandboxProviderOptionsFromEnv({ RAILWAY_SANDBOX_REGION: "asia-southeast1-eqsg3a" }),
    ).toMatchObject({ railwaySandboxRegion: "asia-southeast1-eqsg3a" });
  });

  it.each(["", "  "])("leaves a blank Railway sandbox region unset: %j", (region) => {
    expect(
      sandboxProviderOptionsFromEnv({ RAILWAY_SANDBOX_REGION: region }).railwaySandboxRegion,
    ).toBeUndefined();
  });
});
