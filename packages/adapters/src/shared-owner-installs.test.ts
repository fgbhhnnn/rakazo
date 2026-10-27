import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({
  list: vi.fn(),
  call: vi.fn(),
}));

vi.mock("./remote-mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./remote-mcp.js")>()),
  listRemoteMcpTools: remote.list,
  callRemoteMcpTool: remote.call,
}));

const { InstalledConnectorProvider } = await import("./installed-connectors.js");
const {
  isSharedOwnerInstall,
  loadSharedOwnerCredential,
  shareOwnerToolsEnabled,
  sharedToolsOwner,
} = await import("./shared-owner-installs.js");

type Row = {
  id: string;
  spaceId: string;
  userId: string;
  kind: string;
  name: string;
  source: string;
  secretId: string | null;
  config: Record<string, unknown>;
  createdAt: Date;
};

const OWNER = "owner-user";
const MEMBER = "member-user";
const OTHER = "other-user";
const OWNER_SPACE = "owner-space";
const MEMBER_SPACE = "member-space";
const OTHER_SPACE = "other-space";
const OWNER_URL = "https://owner-mcp.example.test/mcp/secret-path";
const OWNER_KEY = "owner-key-0123456789";
const MEMBER_KEY = "member-key-0123456789";
const OTHER_KEY = "other-key-0123456789";

const mcpConfig = {
  preset: "custom",
  auth: { type: "bearer" },
  headers: { "x-tenant": "owner-tenant-header" },
};

function install(row: Partial<Row> & Pick<Row, "id" | "spaceId" | "userId" | "kind">): Row {
  return {
    name: row.id,
    source: `https://${row.id}.example.test/mcp`,
    secretId: null,
    config: row.kind === "mcp" ? { preset: "custom", auth: { type: "bearer" }, headers: {} } : {},
    createdAt: new Date(0),
    ...row,
  };
}

const rows: Row[] = [
  install({
    id: "owner-mcp",
    spaceId: OWNER_SPACE,
    userId: OWNER,
    kind: "mcp",
    source: OWNER_URL,
    secretId: "owner-secret",
    config: mcpConfig,
  }),
  install({
    id: "owner-api",
    spaceId: OWNER_SPACE,
    userId: OWNER,
    kind: "api",
    config: {
      auth: { type: "none" },
      operations: [{ id: "owner_api_op", method: "GET", path: "/x" }],
    },
  }),
  install({
    id: "member-mcp",
    spaceId: MEMBER_SPACE,
    userId: MEMBER,
    kind: "mcp",
    secretId: "member-secret",
  }),
  install({
    id: "other-mcp",
    spaceId: OTHER_SPACE,
    userId: OTHER,
    kind: "mcp",
    secretId: "other-secret",
  }),
];

const secrets = [
  { id: "owner-secret", spaceId: OWNER_SPACE, userId: OWNER, ciphertext: OWNER_KEY },
  { id: "member-secret", spaceId: MEMBER_SPACE, userId: MEMBER, ciphertext: MEMBER_KEY },
  { id: "other-secret", spaceId: OTHER_SPACE, userId: OTHER, ciphertext: OTHER_KEY },
];

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && "in" in expected)
      return (expected as { in: unknown[] }).in.includes(row[key]);
    return row[key] === expected;
  });
}

function fakePrisma(settings: { ownerUserId: string | null; lockMemberSettings: boolean | null }) {
  const users = [
    { id: OWNER, email: "owner@example.test" },
    { id: MEMBER, email: "member@example.test" },
    { id: OTHER, email: "other@example.test" },
  ];
  return {
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ...settings, shareOwnerModels: null })),
    },
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          users.find((user) => user.id === where.id) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { email: { in: string[] } } }) =>
        users.filter((user) => where.email.in.includes(user.email)),
      ),
    },
    capabilityInstall: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = rows.find((candidate) => matches(candidate, where));
        return row ? { ...row } : null;
      }),
    },
    secret: {
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          secrets.find((row) => matches(row, where)) ?? null,
      ),
    },
  };
}

const secretStore = { load: vi.fn(async (ciphertext: string) => ciphertext) };

function context(userId: string, spaceId: string) {
  return { spaceId, userId, signal: new AbortController().signal } as never;
}

async function events(
  provider: InstanceType<typeof InstalledConnectorProvider>,
  resourceId: string,
  ctx: never,
  toolName = "draw",
) {
  const out: Array<{ type: string; data?: unknown; message?: string }> = [];
  for await (const event of provider.execute(
    {
      tool: toolName,
      args: { prompt: "a puppy" },
      executionId: "call-1",
      route: { connectorId: "installed", resourceId, toolName },
    },
    ctx,
  ))
    out.push(event as never);
  return out;
}

function headersOf(mock: typeof remote.list, endpoint: string) {
  const call = mock.mock.calls.find(([options]) => options.endpoint === endpoint);
  return call?.[0].headers as Record<string, string> | undefined;
}

beforeEach(() => {
  remote.list.mockReset();
  remote.call.mockReset();
  secretStore.load.mockClear();
  remote.list.mockImplementation(async (options: { endpoint: string }) => [
    {
      name: options.endpoint === OWNER_URL ? "draw" : `tool_${options.endpoint.length}`,
      description: "tool",
      inputSchema: { type: "object", properties: {} },
    },
  ]);
  remote.call.mockImplementation(async () => ({ content: [{ type: "text", text: "done" }] }));
  vi.stubEnv("RAKAZO_ADMIN_EMAILS", "");
  vi.stubEnv("RAKAZO_LOCK_MEMBER_SETTINGS", "");
  vi.stubEnv("RAKAZO_SHARE_OWNER_MODELS", "");
  vi.stubEnv("RAKAZO_SHARE_OWNER_TOOLS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const locked = { ownerUserId: OWNER, lockMemberSettings: true };

describe("RAKAZO_SHARE_OWNER_TOOLS flag", () => {
  it("is off unless set to a true value", () => {
    expect(shareOwnerToolsEnabled({})).toBe(false);
    expect(shareOwnerToolsEnabled({ RAKAZO_SHARE_OWNER_TOOLS: "" })).toBe(false);
    for (const value of ["0", "false", "no", "off"])
      expect(shareOwnerToolsEnabled({ RAKAZO_SHARE_OWNER_TOOLS: value })).toBe(false);
    for (const value of ["1", "true", "yes", "on"])
      expect(shareOwnerToolsEnabled({ RAKAZO_SHARE_OWNER_TOOLS: value })).toBe(true);
  });

  it("does not read the database while off", async () => {
    const prisma = fakePrisma(locked);
    const provider = new InstalledConnectorProvider(prisma as never, secretStore as never);

    const tools = await provider.discoverTools(context(MEMBER, MEMBER_SPACE));

    expect(tools.map((tool) => tool.route?.resourceId)).toEqual(["member-mcp"]);
    expect(prisma.deploymentSettings.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.capabilityInstall.findMany).toHaveBeenCalledTimes(1);
    expect(await events(provider, "owner-mcp", context(MEMBER, MEMBER_SPACE))).toEqual([
      { type: "error", message: "Installed connector is unavailable" },
    ]);
    expect(remote.call).not.toHaveBeenCalled();
  });
});

describe("owner MCP sources shared with locked members", () => {
  beforeEach(() => {
    vi.stubEnv("RAKAZO_SHARE_OWNER_TOOLS", "true");
  });

  it("gives a locked member the owner's MCP sources with the owner's credential", async () => {
    const prisma = fakePrisma(locked);
    const provider = new InstalledConnectorProvider(prisma as never, secretStore as never);
    const member = context(MEMBER, MEMBER_SPACE);

    const tools = await provider.discoverTools(member);

    expect(tools.map((tool) => tool.route?.resourceId).sort()).toEqual(["member-mcp", "owner-mcp"]);
    expect(headersOf(remote.list, OWNER_URL)).toEqual({
      "x-tenant": "owner-tenant-header",
      authorization: `Bearer ${OWNER_KEY}`,
    });
    expect(prisma.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "owner-secret", spaceId: OWNER_SPACE, userId: OWNER },
    });

    const result = await events(provider, "owner-mcp", member);
    expect(result).toEqual([
      { type: "result", data: { content: [{ type: "text", text: "done" }] } },
    ]);
    expect(remote.call).toHaveBeenCalledTimes(1);
    expect(remote.call.mock.calls[0]![0]).toMatchObject({
      endpoint: OWNER_URL,
      headers: { authorization: `Bearer ${OWNER_KEY}` },
    });
    expect(remote.call.mock.calls[0]![1]).toBe("draw");
  });

  it("never shares the owner's non-MCP sources", async () => {
    const prisma = fakePrisma(locked);
    const provider = new InstalledConnectorProvider(prisma as never, secretStore as never);
    const member = context(MEMBER, MEMBER_SPACE);

    const tools = await provider.discoverTools(member);

    expect(tools.map((tool) => tool.route?.resourceId)).not.toContain("owner-api");
    expect(await events(provider, "owner-api", member, "owner_api_op")).toEqual([
      { type: "error", message: "Installed connector is unavailable" },
    ]);
  });

  it("leaves the owner's own runs unchanged", async () => {
    const prisma = fakePrisma(locked);
    const provider = new InstalledConnectorProvider(prisma as never, secretStore as never);

    const tools = await provider.discoverTools(context(OWNER, OWNER_SPACE));

    expect(tools.map((tool) => tool.route?.resourceId).sort()).toEqual(["owner-api", "owner-mcp"]);
    expect(prisma.capabilityInstall.findMany).toHaveBeenCalledTimes(1);
    expect(await sharedToolsOwner(prisma as never, OWNER)).toBeNull();
  });

  it("does not share on an unlocked deployment", async () => {
    const prisma = fakePrisma({ ownerUserId: OWNER, lockMemberSettings: false });
    const provider = new InstalledConnectorProvider(prisma as never, secretStore as never);
    const member = context(MEMBER, MEMBER_SPACE);

    const tools = await provider.discoverTools(member);

    expect(tools.map((tool) => tool.route?.resourceId)).toEqual(["member-mcp"]);
    expect(await events(provider, "owner-mcp", member)).toEqual([
      { type: "error", message: "Installed connector is unavailable" },
    ]);
  });

  it("follows the lock from the environment when the setting is unset", async () => {
    vi.stubEnv("RAKAZO_LOCK_MEMBER_SETTINGS", "true");
    const prisma = fakePrisma({ ownerUserId: OWNER, lockMemberSettings: null });

    expect(await sharedToolsOwner(prisma as never, MEMBER)).toBe(OWNER);
    vi.stubEnv("RAKAZO_LOCK_MEMBER_SETTINGS", "false");
    expect(await sharedToolsOwner(prisma as never, MEMBER)).toBeNull();
  });

  it("does not share without a resolvable owner", async () => {
    const prisma = fakePrisma({ ownerUserId: null, lockMemberSettings: true });
    const provider = new InstalledConnectorProvider(prisma as never, secretStore as never);

    const tools = await provider.discoverTools(context(MEMBER, MEMBER_SPACE));

    expect(tools.map((tool) => tool.route?.resourceId)).toEqual(["member-mcp"]);
  });

  it("uses the first listed admin as the owner when none is stored, and not for admins", async () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "owner@example.test,other@example.test");
    const prisma = fakePrisma({ ownerUserId: null, lockMemberSettings: true });

    expect(await sharedToolsOwner(prisma as never, MEMBER)).toBe(OWNER);
    // A second admin manages their own sources, like their own models.
    expect(await sharedToolsOwner(prisma as never, OTHER)).toBeNull();
  });

  it("refuses another user's source that is not the owner's", async () => {
    const prisma = fakePrisma(locked);
    const provider = new InstalledConnectorProvider(prisma as never, secretStore as never);
    const member = context(MEMBER, MEMBER_SPACE);

    const tools = await provider.discoverTools(member);

    expect(tools.map((tool) => tool.route?.resourceId)).not.toContain("other-mcp");
    expect(await events(provider, "other-mcp", member)).toEqual([
      { type: "error", message: "Installed connector is unavailable" },
    ]);
    expect(remote.call).not.toHaveBeenCalled();
    expect(secretStore.load).not.toHaveBeenCalledWith(OTHER_KEY, expect.anything());
  });

  it("keeps a member's own source on the member's credential", async () => {
    const prisma = fakePrisma(locked);
    const provider = new InstalledConnectorProvider(prisma as never, secretStore as never);
    const member = context(MEMBER, MEMBER_SPACE);

    await provider.discoverTools(member);
    expect(headersOf(remote.list, "https://member-mcp.example.test/mcp")).toEqual({
      authorization: `Bearer ${MEMBER_KEY}`,
    });

    const result = await events(provider, "member-mcp", member);
    expect(result[0]?.type).toBe("result");
    expect(remote.call.mock.calls[0]![0]).toMatchObject({
      endpoint: "https://member-mcp.example.test/mcp",
      headers: { authorization: `Bearer ${MEMBER_KEY}` },
    });
    expect(prisma.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "member-secret", spaceId: MEMBER_SPACE, userId: MEMBER },
    });
  });

  it("redacts the owner's key, URL and header values from results and errors", async () => {
    const prisma = fakePrisma(locked);
    const provider = new InstalledConnectorProvider(prisma as never, secretStore as never);
    const member = context(MEMBER, MEMBER_SPACE);
    remote.call.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: `key ${OWNER_KEY} at ${OWNER_URL} for owner-tenant-header`,
        },
      ],
    });

    const [ok] = await events(provider, "owner-mcp", member);
    const shown = JSON.stringify(ok);
    expect(ok?.type).toBe("result");
    expect(shown).not.toContain(OWNER_KEY);
    expect(shown).not.toContain(OWNER_URL);
    expect(shown).not.toContain("owner-tenant-header");

    remote.call.mockRejectedValueOnce(
      new Error(`POST ${OWNER_URL} failed with token ${OWNER_KEY} (owner-tenant-header)`),
    );
    const [failed] = await events(provider, "owner-mcp", member);
    expect(failed?.type).toBe("error");
    expect(failed?.message).not.toContain(OWNER_KEY);
    expect(failed?.message).not.toContain(OWNER_URL);
    expect(failed?.message).not.toContain("owner-tenant-header");
  });

  it("does not treat a row it did not hand out as shared", async () => {
    const prisma = fakePrisma(locked);
    const row = { ...rows[0]! };
    expect(isSharedOwnerInstall(row)).toBe(false);
    const load = vi.fn(async () => "leaked");
    expect(await loadSharedOwnerCredential(prisma as never, row, load)).toBeUndefined();
    expect(prisma.secret.findFirst).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("never shares the owner's sources back to the owner", async () => {
    // The stored owner need not be on the admin list; they still must not get duplicates.
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "other@example.test");
    const prisma = fakePrisma(locked);

    expect(await sharedToolsOwner(prisma as never, OWNER)).toBeNull();
    expect(await sharedToolsOwner(prisma as never, MEMBER)).toBe(OWNER);
  });
});
