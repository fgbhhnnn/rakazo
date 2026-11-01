import type { AdapterContext, PortableFile } from "@rakazo/adapter-kit";
import { normalizeWorkspacePath, workspacePath } from "./computer-support.js";
import { shouldSkipPortableWorkspaceFile } from "./computer-workspace.js";
import { isRebuildableDependencyDirectory } from "./e2b-save-scope.js";

/*
 * Reads an E2B workspace for a save. Every folder listing and every file read is one request
 * to the sandbox, about a quarter second each from the server. Walking folder by folder, one
 * listing at a time, a workspace with a few thousand folders (browser profiles alone hold over
 * three thousand) cannot be read within the checkpoint deadline, so the save never finishes
 * and the computer never sleeps. Listing and reading many at once keeps the same files, in the
 * same form, within the deadline.
 */

/** Folder listings in flight at once. */
export const E2B_LIST_CONCURRENCY = 16;
/** File reads in flight at once; also how many files may be held before they are taken. */
export const E2B_READ_CONCURRENCY = 16;

type WorkspaceEntry = { name: string; type?: string; mode: number };

export type E2BWorkspaceFiles = {
  list(path: string, options: { signal?: AbortSignal }): Promise<WorkspaceEntry[]>;
  read(path: string, options: { format: "bytes"; signal?: AbortSignal }): Promise<Uint8Array>;
};

type FoundFile = { relative: string; mode: number };

export async function* walkE2BWorkspaceConcurrently(
  files: E2BWorkspaceFiles,
  root: string,
  context: AdapterContext,
  limits: { list?: number; read?: number } = {},
): AsyncIterable<PortableFile> {
  const found = await listWorkspaceFiles(files, root, context, limits.list ?? E2B_LIST_CONCURRENCY);
  const readOne = ({ relative, mode }: FoundFile) => {
    const reading = files
      .read(workspacePath(root, relative), { format: "bytes", signal: context.signal })
      .then(
        (content): PortableFile => ({ path: relative, content, executable: Boolean(mode & 0o100) }),
        (error: unknown) => {
          // A browser can rewrite or delete its profile's files while they are read.
          if (relative.startsWith(".browser-profiles/")) return undefined;
          throw error;
        },
      );
    // Read ahead: a failure surfaces when its turn comes, or never if the save stopped first.
    reading.catch(() => undefined);
    return reading;
  };
  const window: Array<Promise<PortableFile | undefined>> = [];
  let next = 0;
  const readLimit = Math.max(1, limits.read ?? E2B_READ_CONCURRENCY);
  while (next < found.length && window.length < readLimit) window.push(readOne(found[next++]!));
  while (window.length > 0) {
    const file = await window.shift()!;
    if (next < found.length) window.push(readOne(found[next++]!));
    if (file) yield file;
  }
}

/** Every file to save, folder by folder in breadth-first order, listing many folders at once. */
async function listWorkspaceFiles(
  files: E2BWorkspaceFiles,
  root: string,
  context: AdapterContext,
  concurrency: number,
): Promise<FoundFile[]> {
  const found: FoundFile[] = [];
  let level = [""];
  while (level.length > 0) {
    const listed = await mapWithLimit(level, concurrency, (directory) =>
      files.list(workspacePath(root, directory), { signal: context.signal }),
    );
    const deeper: string[] = [];
    level.forEach((directory, index) => {
      for (const entry of listed[index]!) {
        const relative = normalizeWorkspacePath(
          directory ? `${directory}/${entry.name}` : entry.name,
        );
        if (shouldSkipPortableWorkspaceFile(relative, entry.type === "dir")) continue;
        if (entry.type === "dir") {
          if (!isRebuildableDependencyDirectory(entry.name)) deeper.push(relative);
        } else if (entry.type === "file") {
          found.push({ relative, mode: entry.mode });
        }
      }
    });
    level = deeper;
  }
  return found;
}

/** Runs `run` over `items` with at most `limit` at once, keeping the results in order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await run(items[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
