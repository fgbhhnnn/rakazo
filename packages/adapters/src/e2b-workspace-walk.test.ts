import type { AdapterContext, PortableFile } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  E2B_LIST_CONCURRENCY,
  E2B_READ_CONCURRENCY,
  type E2BWorkspaceFiles,
  walkE2BWorkspaceConcurrently,
} from "./e2b-workspace-walk.js";

const ROOT = "/home/user/rakazo-home";
const context = (signal = new AbortController().signal): AdapterContext => ({
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal,
});

type Entry = { name: string; type: "file" | "dir"; mode?: number };

/** A sandbox whose every request takes `delayMs`, counting how many run at once. */
function fakeFiles(tree: Record<string, Entry[]>, options: { delayMs?: number } = {}) {
  let active = 0;
  const peak = { list: 0, read: 0 };
  const track = async <T>(kind: "list" | "read", work: () => T): Promise<T> => {
    active += 1;
    peak[kind] = Math.max(peak[kind], active);
    try {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 1));
      return work();
    } finally {
      active -= 1;
    }
  };
  const failures = new Map<string, Error>();
  const list = vi.fn((path: string, _options: { signal?: AbortSignal }) =>
    track("list", () => (tree[path] ?? []).map((entry) => ({ mode: 0o644, ...entry }))),
  );
  const read = vi.fn((path: string, _options: { format: "bytes"; signal?: AbortSignal }) =>
    track("read", () => {
      const failure = failures.get(path);
      if (failure) throw failure;
      return new TextEncoder().encode(path);
    }),
  );
  return { files: { list, read } as E2BWorkspaceFiles, list, read, peak, failures };
}

/** A workspace shaped like the production one: many small folders, as in browser profiles. */
function wideTree(folders: number, filesPerFolder: number) {
  const tree: Record<string, Entry[]> = {
    [ROOT]: [
      { name: "notes.txt", type: "file" },
      { name: "run.sh", type: "file", mode: 0o755 },
      { name: ".browser-profiles", type: "dir" },
      { name: "bots", type: "dir" },
    ],
    [`${ROOT}/.browser-profiles`]: [],
    [`${ROOT}/bots`]: [{ name: "app", type: "dir" }],
    [`${ROOT}/bots/app`]: [
      { name: "package.json", type: "file" },
      { name: "node_modules", type: "dir" },
    ],
    [`${ROOT}/bots/app/node_modules`]: [{ name: "left-pad", type: "dir" }],
  };
  for (let folder = 0; folder < folders; folder += 1) {
    tree[`${ROOT}/.browser-profiles`]!.push({ name: `ext-${folder}`, type: "dir" });
    tree[`${ROOT}/.browser-profiles/ext-${folder}`] = Array.from(
      { length: filesPerFolder },
      (_, file) => ({ name: `f${file}.js`, type: "file" as const }),
    );
  }
  return tree;
}

async function collect(files: AsyncIterable<PortableFile>) {
  const saved: PortableFile[] = [];
  for await (const file of files) saved.push(file);
  return saved;
}

describe("E2B workspace walk", () => {
  it("reads every saved file once, with its mode, skipping rebuildable folders", async () => {
    const fake = fakeFiles(wideTree(40, 2));

    const saved = await collect(walkE2BWorkspaceConcurrently(fake.files, ROOT, context()));

    const paths = saved.map((file) => file.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.sort()).toEqual(
      [
        "notes.txt",
        "run.sh",
        "bots/app/package.json",
        ...Array.from({ length: 40 }, (_, folder) => [
          `.browser-profiles/ext-${folder}/f0.js`,
          `.browser-profiles/ext-${folder}/f1.js`,
        ]).flat(),
      ].sort(),
    );
    expect(saved.find((file) => file.path === "run.sh")?.executable).toBe(true);
    expect(saved.find((file) => file.path === "notes.txt")?.executable).toBe(false);
    expect(new TextDecoder().decode(saved.find((f) => f.path === "notes.txt")?.content)).toBe(
      `${ROOT}/notes.txt`,
    );
    expect(fake.list).not.toHaveBeenCalledWith(`${ROOT}/bots/app/node_modules`, expect.anything());
    expect(fake.read).toHaveBeenCalledTimes(saved.length);
  });

  it("lists and reads many at once, bounded", async () => {
    const fake = fakeFiles(wideTree(64, 3), { delayMs: 5 });

    await collect(walkE2BWorkspaceConcurrently(fake.files, ROOT, context()));

    expect(fake.peak.list).toBe(E2B_LIST_CONCURRENCY);
    expect(fake.peak.read).toBe(E2B_READ_CONCURRENCY);
  });

  it("reads a wide workspace in a fraction of the one-at-a-time time", async () => {
    // 200 folders and 400 files at 20 ms a request: one at a time that is over 12 s.
    const fake = fakeFiles(wideTree(200, 2), { delayMs: 20 });
    const started = Date.now();

    const saved = await collect(walkE2BWorkspaceConcurrently(fake.files, ROOT, context()));

    expect(saved).toHaveLength(403);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("skips a browser profile file that vanished while it was read", async () => {
    const fake = fakeFiles(wideTree(2, 2));
    fake.failures.set(`${ROOT}/.browser-profiles/ext-1/f0.js`, new Error("file not found"));

    const saved = await collect(walkE2BWorkspaceConcurrently(fake.files, ROOT, context()));

    expect(saved.map((file) => file.path)).not.toContain(".browser-profiles/ext-1/f0.js");
    expect(saved).toHaveLength(6);
  });

  it("fails the save when any other file cannot be read", async () => {
    const fake = fakeFiles(wideTree(30, 2));
    fake.failures.set(`${ROOT}/bots/app/package.json`, new Error("connection reset"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await expect(
        collect(walkE2BWorkspaceConcurrently(fake.files, ROOT, context())),
      ).rejects.toThrow("connection reset");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("fails the save when a folder cannot be listed", async () => {
    const tree = wideTree(30, 1);
    const fake = fakeFiles(tree);
    fake.list.mockImplementation(async (path: string) => {
      if (path.endsWith("ext-7")) throw new Error("list failed");
      return (tree[path] ?? []).map((entry) => ({ mode: 0o644, ...entry }));
    });

    await expect(
      collect(walkE2BWorkspaceConcurrently(fake.files, ROOT, context())),
    ).rejects.toThrow("list failed");
  });

  it("stops reading ahead when the save stops taking files", async () => {
    const fake = fakeFiles(wideTree(50, 2));

    for await (const _file of walkE2BWorkspaceConcurrently(fake.files, ROOT, context())) break;

    // The window, plus the one read that refilled it as the first file was handed over.
    expect(fake.read.mock.calls.length).toBeLessThanOrEqual(E2B_READ_CONCURRENCY + 1);
    expect(fake.read.mock.calls.length).toBeLessThan(103);
  });

  it("passes the save's abort signal to every request", async () => {
    const fake = fakeFiles(wideTree(3, 1));
    const abort = new AbortController();

    await collect(walkE2BWorkspaceConcurrently(fake.files, ROOT, context(abort.signal)));

    for (const [, options] of fake.list.mock.calls) expect(options.signal).toBe(abort.signal);
    for (const [, options] of fake.read.mock.calls) expect(options.signal).toBe(abort.signal);
  });
});
