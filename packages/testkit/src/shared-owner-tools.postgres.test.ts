import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { createApp } from "@rakazo/api/app";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

// Sharing the owner's MCP sources with locked members is run-time only: the Plugins list a
// member sees (capabilities/list) must still show only the member's own sources.
describeWithDatabase("owner MCP sources stay off a member's source list (PostgreSQL)", () => {
  let handles: AppHandles;
  let app: App;
  let db: AppHandles["prisma"];
  let previousSettings: unknown = null;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-shared-tools-"));

  beforeAll(async () => {
    vi.stubEnv("RAKAZO_SHARE_OWNER_TOOLS", "1");
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "");
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      encryptionKey: "offline-shared-tools-encryption-key",
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
    });
    app = handles.app;
    db = asSystem(handles.prisma);
    previousSettings = await db.deploymentSettings.findUnique({ where: { id: "default" } });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (db) {
      if (previousSettings) {
        const { id: _id, ...data } = previousSettings as { id: string } & Record<string, unknown>;
        await db.deploymentSettings.update({ where: { id: "default" }, data: data as never });
      } else {
        await db.deploymentSettings.deleteMany({ where: { id: "default" } });
      }
    }
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("lists only the member's own sources while the owner's are shared", async () => {
    const ownerCookie = await signup(app, `shared-tools-owner-${stamp}@rakazo.test`, "Owner");
    const memberCookie = await signup(app, `shared-tools-member-${stamp}@rakazo.test`, "Member");
    const owner = await db.user.findUniqueOrThrow({
      where: { email: `shared-tools-owner-${stamp}@rakazo.test` },
    });
    const member = await db.user.findUniqueOrThrow({
      where: { email: `shared-tools-member-${stamp}@rakazo.test` },
    });
    const ownerSpace = await db.spaceMember.findFirstOrThrow({ where: { userId: owner.id } });
    const memberSpace = await db.spaceMember.findFirstOrThrow({ where: { userId: member.id } });
    const ownerSecret = await db.secret.create({
      data: {
        userId: owner.id,
        spaceId: ownerSpace.spaceId,
        kind: "mcp",
        ciphertext: "not-a-real-ciphertext",
      },
    });
    const ownerMcp = await db.capabilityInstall.create({
      data: {
        spaceId: ownerSpace.spaceId,
        userId: owner.id,
        kind: "mcp",
        name: "Owner images",
        source: `https://owner-${stamp}.example.test/mcp`,
        secretId: ownerSecret.id,
        config: { preset: "custom", auth: { type: "bearer" }, headers: {} },
      },
    });
    const memberMcp = await db.capabilityInstall.create({
      data: {
        spaceId: memberSpace.spaceId,
        userId: member.id,
        kind: "mcp",
        name: "Member tools",
        source: `https://member-${stamp}.example.test/mcp`,
        config: { preset: "custom", auth: { type: "none" }, headers: {} },
      },
    });
    await db.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ownerUserId: owner.id, lockMemberSettings: true },
      update: { ownerUserId: owner.id, lockMemberSettings: true },
    });

    const memberList = await rpc<Array<{ id: string; source?: string }>>(
      app,
      memberCookie,
      "capabilities/list",
    );
    expect(memberList.map((row) => row.id)).toContain(memberMcp.id);
    expect(memberList.map((row) => row.id)).not.toContain(ownerMcp.id);
    expect(JSON.stringify(memberList)).not.toContain(`owner-${stamp}.example.test`);

    const ownerList = await rpc<Array<{ id: string }>>(app, ownerCookie, "capabilities/list");
    expect(ownerList.map((row) => row.id)).toContain(ownerMcp.id);
    expect(ownerList.map((row) => row.id)).not.toContain(memberMcp.id);
  });
});

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (response.status >= 400) {
    throw new Error(`signup failed ${response.status}: ${await response.text()}`);
  }
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, procedure: string, body: unknown = {}) {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
  const text = await response.text();
  const payload = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || payload.error) {
    throw new Error(`${procedure} ${response.status}: ${payload.error?.message ?? text}`);
  }
  return payload.json as T;
}
