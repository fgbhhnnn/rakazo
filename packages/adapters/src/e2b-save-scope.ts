import type { E2BSandboxSdk } from "./e2b-sandbox.js";
import { isSandboxGoneError } from "./sandbox-errors.js";

/*
 * What an E2B workspace save reads, and how to tell a paused E2B sandbox from a running one.
 *
 * E2B's save reads the workspace file by file over the network. Package-manager folders hold
 * tens of thousands of small files that an install rebuilds, so one cloned app with its
 * node_modules can push a save past the sleep job's checkpoint deadline every time: the
 * computer then never saves, never sleeps, and is reported unresponsive. E2B's pause keeps the
 * sandbox's own disk, folders included; only the server-side copy that a restart restores from
 * leaves them out, and an install brings them back.
 */

/** Folder names a package manager rebuilds from the project's own files. */
export const REBUILDABLE_DEPENDENCY_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".pnpm-store",
  "__pycache__",
]);

export function isRebuildableDependencyDirectory(name: string): boolean {
  return REBUILDABLE_DEPENDENCY_DIRECTORIES.has(name);
}

/** How long the read-only status request may take. */
export const E2B_STATUS_TIMEOUT_MS = 15_000;

/**
 * Whether E2B holds this sandbox paused. Read-only: unlike connecting, it never resumes it. An
 * unknown sandbox is gone rather than paused, so false; any other failure throws.
 */
export async function isE2BSandboxPaused(
  sdk: Pick<E2BSandboxSdk, "getInfo">,
  apiKey: string,
  id: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!sdk.getInfo) return false;
  try {
    const info = await sdk.getInfo(id, {
      apiKey,
      requestTimeoutMs: E2B_STATUS_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    return info.state === "paused";
  } catch (error) {
    if (isSandboxGoneError(error)) return false;
    throw error;
  }
}
