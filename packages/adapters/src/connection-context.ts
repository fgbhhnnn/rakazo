import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { PluginConnectionRow } from "./composio-connector.js";
import { planLiveConnectionSync } from "./composio-connector.js";
import type { ExecutorDeps } from "./executor-deps.js";

export function selectRunConnections<
  T extends { connectorId: string; provider: string; status: string },
>(rows: T[], connectedComposioProviders: string[]): T[] {
  const liveProviders = new Set(
    connectedComposioProviders.map((provider) => provider.trim().toLowerCase()).filter(Boolean),
  );
  const connectedKeys = new Set(
    rows
      .filter((row) => row.status === "connected")
      .map((row) => `${row.connectorId}:${row.provider.trim().toLowerCase()}`),
  );
  return rows.filter((row) => {
    if (row.status === "connected") return true;
    if (row.status === "revoked") return false;
    // Recover a pending/error Composio row only when this provider has no
    // connected row of its own. A sibling that shares the slug must not
    // pull a non-live row — and its dead providerRef — into the run.
    if (row.connectorId !== "composio") return false;
    if (row.status !== "pending" && row.status !== "error") return false;
    const providerKey = row.provider.trim().toLowerCase();
    if (!liveProviders.has(providerKey)) return false;
    return !connectedKeys.has(`composio:${providerKey}`);
  });
}

/** Authorized connection metadata shared by model runs and unattended checks. */
export function connectedContext(
  rows: Array<{
    id: string;
    connectorId: string;
    provider: string;
    displayName: string;
    providerRef: string | null;
  }>,
): Pick<AdapterContext, "connectedConnections" | "connectedProviders"> {
  return {
    connectedConnections: rows.map((row) => ({
      id: row.id,
      connectorId: row.connectorId,
      externalId: row.provider,
      displayName: row.displayName,
      providerRef: row.providerRef ?? undefined,
    })),
    connectedProviders: rows
      .filter((row) => row.connectorId === "composio")
      .map((row) => row.provider),
  };
}

/**
 * Longest a dispatcher turn waits for the live Composio listing before it falls back to the
 * stored connection rows. The turn has a short reply budget and never uses connector tools.
 */
export const DISPATCHER_PLUGIN_LISTING_MAX_MS = 5_000;

export async function loadLivePluginSlugs(
  listConnectedPluginSlugs: ExecutorDeps["listConnectedPluginSlugs"],
  userId: string,
  maxMs?: number,
): Promise<{ ok: true; slugs: string[] } | { ok: false }> {
  if (!listConnectedPluginSlugs) return { ok: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const listing = listConnectedPluginSlugs(userId).then((slugs) => ({
      ok: true as const,
      slugs,
    }));
    if (maxMs === undefined) return await listing;
    // A late or failed listing after the cap is ignored; the stored rows already answered.
    listing.catch(() => undefined);
    return await Promise.race([
      listing,
      new Promise<{ ok: false }>((resolve) => {
        timer = setTimeout(() => {
          getLogger().warn("connected plugin listing timed out", { "timeout.ms": maxMs });
          resolve({ ok: false });
        }, maxMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function persistLivePluginConnections(
  prisma: PrismaClient,
  owner: { userId: string; spaceId: string },
  rows: PluginConnectionRow[],
  liveSlugs: string[],
): Promise<void> {
  const sync = planLiveConnectionSync(rows, liveSlugs);
  if (sync.connectIds.length > 0) {
    await prisma.connection.updateMany({
      where: {
        id: { in: sync.connectIds },
        userId: owner.userId,
        spaceId: owner.spaceId,
      },
      data: { status: "connected" },
    });
    for (const row of rows) {
      if (sync.connectIds.includes(row.id)) row.status = "connected";
    }
  }
  if (sync.revokeIds.length > 0) {
    await prisma.connection.updateMany({
      where: {
        id: { in: sync.revokeIds },
        userId: owner.userId,
        spaceId: owner.spaceId,
      },
      data: { status: "revoked" },
    });
    for (const row of rows) {
      if (sync.revokeIds.includes(row.id)) row.status = "revoked";
    }
  }
}
