import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({ list: vi.fn(), call: vi.fn() }));

vi.mock("./remote-mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./remote-mcp.js")>()),
  listRemoteMcpTools: remote.list,
  callRemoteMcpTool: remote.call,
}));

const { InstalledConnectorProvider } = await import("./installed-connectors.js");

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

// A locked member borrows the owner's MCP sources: the owner's secret must be read as the
// owner under row-level security, and nothing else of anyone else's may be reachable.
describePostgres("owner MCP sources shared with locked members (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const owner = `shared-tools-owner-${suffix}`;
  const member = `shared-tools-member-${suffix}`;
  const other = `shared-tools-other-${suffix}`;
  const organizationId = `shared-tools-org-${suffix}`;
  const ownerSpace = `shared-tools-owner-space-${suffix}`;
  const memberSpace = `shared-tools-member-space-${suffix}`;
  const otherSpace = `shared-tools-other-space-${suffix}`;
  const ownerMcp = `shared-tools-owner-mcp-${suffix}`;
  const ownerApi = `shared-tools-owner-api-${suffix}`;
  const memberMcp = `shared-tools-member-mcp-${suffix}`;
  const otherMcp = `shared-tools-other-mcp-${suffix}`;
  const ownerSecret = `shared-tools-owner-secret-${suffix}`;
  const memberSecret = `shared-tools-member-secret-${suffix}`;
  const otherSecret = `shared-tools-other-secret-${suffix}`;
  const ownerUrl = `https://owner-${suffix}.example.test/mcp`;
  const memberUrl = `https://member-${suffix}.example.test/mcp`;
  const otherUrl = `https://other-${suffix}.example.test/mcp`;
  let db: ReturnType<typeof createDb>;
  let fixtures: PrismaClient;
  let previousSettings: unknown = null;
  // The fake store "decrypts" ciphertext "enc:<key>" to "<key>".
  const secrets = {
    load: vi.fn(async (ciphertext: string) => ciphertext.replace(/^enc:/, "")),
  };

  const asMember = <T>(fn: () => Promise<T>) =>
    runAsTenant({ userId: member, spaceId: memberSpace }, fn);
  const memberContext = () =>
    ({ userId: member, spaceId: memberSpace, signal: new AbortController().signal }) as never;
  const provider = () => new InstalledConnectorProvider(db.prisma as never, secrets as never);
  const run = async (resourceId: string, toolName = "draw") => {
    const out: Array<{ type: string; message?: string; data?: unknown }> = [];
    await asMember(async () => {
      for await (const event of provider().execute(
        {
          tool: toolName,
          args: {},
          executionId: "call-1",
          route: { connectorId: "installed", resourceId, toolName },
        },
        memberContext(),
      ))
        out.push(event as never);
    });
    return out;
  };
  const discovered = async () =>
    (await asMember(() => provider().discoverTools(memberContext()))).map(
      (tool) => tool.route?.resourceId,
    );
  const mcpConfig = { preset: "custom", auth: { type: "bearer" }, headers: {} };

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    fixtures = asSystem(db.prisma);
    const createdAt = new Date();
    for (const id of [owner, member, other]) {
      await fixtures.user.create({
        data: { id, name: id, email: `${id}@rakazo.test`, emailVerified: false },
      });
    }
    await fixtures.organization.create({
      data: { id: organizationId, name: "Shared tools", slug: organizationId, createdAt },
    });
    for (const [userId, role] of [
      [owner, "owner"],
      [member, "member"],
      [other, "member"],
    ] as const) {
      await fixtures.member.create({
        data: { id: `${userId}-member`, organizationId, userId, role, createdAt },
      });
    }
    for (const [spaceId, userId] of [
      [ownerSpace, owner],
      [memberSpace, member],
      [otherSpace, other],
    ] as const) {
      await fixtures.space.create({
        data: { id: spaceId, organizationId, name: spaceId, createdByUserId: userId },
      });
      await fixtures.spaceMember.create({
        data: { id: `${spaceId}-m`, spaceId, organizationId, userId, createdAt },
      });
    }
    for (const [id, userId, spaceId, key] of [
      [ownerSecret, owner, ownerSpace, "owner-key"],
      [memberSecret, member, memberSpace, "member-key"],
      [otherSecret, other, otherSpace, "other-key"],
    ] as const) {
      await fixtures.secret.create({
        data: { id, userId, spaceId, kind: "mcp", ciphertext: `enc:${key}-${suffix}` },
      });
    }
    await fixtures.capabilityInstall.createMany({
      data: [
        {
          id: ownerMcp,
          spaceId: ownerSpace,
          userId: owner,
          kind: "mcp",
          name: "Owner images",
          source: ownerUrl,
          secretId: ownerSecret,
          config: mcpConfig,
        },
        {
          id: ownerApi,
          spaceId: ownerSpace,
          userId: owner,
          kind: "api",
          name: "Owner API",
          source: `https://owner-api-${suffix}.example.test`,
          config: {
            auth: { type: "none" },
            operations: [{ id: "owner_op", method: "GET", path: "/x" }],
          },
        },
        {
          id: memberMcp,
          spaceId: memberSpace,
          userId: member,
          kind: "mcp",
          name: "Member tools",
          source: memberUrl,
          secretId: memberSecret,
          config: mcpConfig,
        },
        {
          id: otherMcp,
          spaceId: otherSpace,
          userId: other,
          kind: "mcp",
          name: "Other tools",
          source: otherUrl,
          secretId: otherSecret,
          config: mcpConfig,
        },
      ],
    });
    previousSettings = await fixtures.deploymentSettings.findUnique({ where: { id: "default" } });
    await fixtures.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ownerUserId: owner, lockMemberSettings: true },
      update: { ownerUserId: owner, lockMemberSettings: true },
    });
  });

  beforeEach(() => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "");
    vi.stubEnv("RAKAZO_SHARE_OWNER_TOOLS", "1");
    remote.list.mockReset();
    remote.call.mockReset();
    remote.list.mockImplementation(async (options: { endpoint: string }) => [
      {
        name: options.endpoint === ownerUrl ? "draw" : "other_tool",
        description: "tool",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    remote.call.mockResolvedValue({ content: [{ type: "text", text: "made" }] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (!fixtures) return;
    if (previousSettings) {
      const { id: _id, ...data } = previousSettings as { id: string } & Record<string, unknown>;
      await fixtures.deploymentSettings.update({ where: { id: "default" }, data: data as never });
    } else {
      await fixtures.deploymentSettings.deleteMany({ where: { id: "default" } });
    }
    await fixtures.organization.deleteMany({ where: { id: organizationId } });
    await fixtures.user.deleteMany({ where: { id: { in: [owner, member, other] } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("cannot read the owner's secret as the member directly", async () => {
    expect(await asMember(() => db.prisma.secret.findFirst({ where: { id: ownerSecret } }))).toBe(
      null,
    );
  });

  it("discovers and runs the owner's MCP source with the owner's credential", async () => {
    expect((await discovered()).sort()).toEqual([memberMcp, ownerMcp].sort());
    const ownerList = remote.list.mock.calls.find(([options]) => options.endpoint === ownerUrl);
    expect(ownerList?.[0].headers).toEqual({ authorization: `Bearer owner-key-${suffix}` });

    expect(await run(ownerMcp)).toEqual([
      { type: "result", data: { content: [{ type: "text", text: "made" }] } },
    ]);
    expect(remote.call.mock.calls[0]![0]).toMatchObject({
      endpoint: ownerUrl,
      headers: { authorization: `Bearer owner-key-${suffix}` },
    });
  });

  it("keeps the member's own source on the member's credential", async () => {
    await discovered();
    const memberList = remote.list.mock.calls.find(([options]) => options.endpoint === memberUrl);
    expect(memberList?.[0].headers).toEqual({ authorization: `Bearer member-key-${suffix}` });
    expect((await run(memberMcp, "other_tool"))[0]?.type).toBe("result");
    expect(remote.call.mock.calls[0]![0]).toMatchObject({
      endpoint: memberUrl,
      headers: { authorization: `Bearer member-key-${suffix}` },
    });
  });

  it("shares neither the owner's non-MCP sources nor anyone else's", async () => {
    const ids = await discovered();
    expect(ids).not.toContain(ownerApi);
    expect(ids).not.toContain(otherMcp);
    expect(await run(ownerApi, "owner_op")).toEqual([
      { type: "error", message: "Installed connector is unavailable" },
    ]);
    expect(await run(otherMcp, "other_tool")).toEqual([
      { type: "error", message: "Installed connector is unavailable" },
    ]);
    expect(remote.call).not.toHaveBeenCalled();
  });

  it("shares nothing with the flag off or the lock off", async () => {
    vi.stubEnv("RAKAZO_SHARE_OWNER_TOOLS", "0");
    expect(await discovered()).toEqual([memberMcp]);
    expect((await run(ownerMcp))[0]?.message).toBe("Installed connector is unavailable");

    vi.stubEnv("RAKAZO_SHARE_OWNER_TOOLS", "1");
    await fixtures.deploymentSettings.update({
      where: { id: "default" },
      data: { lockMemberSettings: false },
    });
    try {
      expect(await discovered()).toEqual([memberMcp]);
      expect((await run(ownerMcp))[0]?.message).toBe("Installed connector is unavailable");
    } finally {
      await fixtures.deploymentSettings.update({
        where: { id: "default" },
        data: { lockMemberSettings: true },
      });
    }
    expect(remote.call).not.toHaveBeenCalled();
  });
});
