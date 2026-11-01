import type { Sandbox } from "@e2b/desktop";
import { SandboxError, SandboxNotFoundError } from "@e2b/desktop";
import type { ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { E2BSandboxSdk } from "./e2b-sandbox.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import {
  E2B_STATUS_TIMEOUT_MS,
  isE2BSandboxPaused,
  isRebuildableDependencyDirectory,
} from "./e2b-save-scope.js";

const context = {
  operationId: "e2b-save-scope-test",
  traceId: "e2b-save-scope-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};
const computer: ComputerRef = {
  id: "sbx-paused",
  providerRef: "sbx-paused",
  kind: "e2b",
  botId: "team-home",
};

function statusSdk(getInfo: NonNullable<E2BSandboxSdk["getInfo"]>) {
  return {
    create: vi.fn(async () => {
      throw new Error("a status check must not create a sandbox");
    }),
    connect: vi.fn(async () => {
      throw new Error("a status check must not resume the sandbox");
    }),
    pause: vi.fn(async () => undefined),
    kill: vi.fn(async () => true),
    getInfo: vi.fn(getInfo),
  } satisfies E2BSandboxSdk;
}

describe("E2B status check", () => {
  it("reports a paused sandbox as stopped without resuming it", async () => {
    const sdk = statusSdk(async () => ({ state: "paused" }));
    const provider = new E2BSandboxProvider("test-key", sdk);

    await expect(provider.isStopped(computer, context)).resolves.toBe(true);
    expect(sdk.getInfo).toHaveBeenCalledWith("sbx-paused", {
      apiKey: "test-key",
      requestTimeoutMs: E2B_STATUS_TIMEOUT_MS,
      signal: context.signal,
    });
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("reports a running sandbox as not stopped", async () => {
    const sdk = statusSdk(async () => ({ state: "running" }));
    await expect(
      new E2BSandboxProvider("test-key", sdk).isStopped(computer, context),
    ).resolves.toBe(false);
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it("reports a sandbox E2B no longer knows as gone, not stopped", async () => {
    const sdk = statusSdk(async () => {
      throw new SandboxNotFoundError("Sandbox sbx-paused not found");
    });
    await expect(
      new E2BSandboxProvider("test-key", sdk).isStopped(computer, context),
    ).resolves.toBe(false);
  });

  it("surfaces any other status failure instead of guessing", async () => {
    const sdk = statusSdk(async () => {
      throw new SandboxError("500: internal error");
    });
    await expect(
      new E2BSandboxProvider("test-key", sdk).isStopped(computer, context),
    ).rejects.toThrow("500: internal error");
  });

  it("answers false when the SDK has no status call", async () => {
    await expect(isE2BSandboxPaused({}, "test-key", "sbx")).resolves.toBe(false);
  });
});

describe("E2B save scope", () => {
  it("names only folders a package manager rebuilds", () => {
    for (const name of ["node_modules", ".pnpm-store", "__pycache__"]) {
      expect(isRebuildableDependencyDirectory(name)).toBe(true);
    }
    for (const name of ["src", "repo", ".git", "node_modules.txt", "my_node_modules", "venv"]) {
      expect(isRebuildableDependencyDirectory(name)).toBe(false);
    }
  });

  it("saves a workspace without its node_modules, __pycache__ and pnpm store folders", async () => {
    const root = "/home/user/rakazo-home";
    const tree: Record<string, Array<{ name: string; type: "file" | "dir" }>> = {
      [root]: [
        { name: "notes.txt", type: "file" },
        { name: "bots", type: "dir" },
      ],
      [`${root}/bots`]: [{ name: "app", type: "dir" }],
      [`${root}/bots/app`]: [
        { name: "package.json", type: "file" },
        { name: "node_modules", type: "dir" },
        { name: "src", type: "dir" },
        { name: "__pycache__", type: "dir" },
        { name: ".pnpm-store", type: "dir" },
        // A file that merely carries the name is kept.
        { name: "node_modules.txt", type: "file" },
      ],
      [`${root}/bots/app/src`]: [{ name: "index.ts", type: "file" }],
      [`${root}/bots/app/node_modules`]: [{ name: "left-pad", type: "dir" }],
      [`${root}/bots/app/__pycache__`]: [{ name: "mod.pyc", type: "file" }],
      [`${root}/bots/app/.pnpm-store`]: [{ name: "v3", type: "dir" }],
    };
    const list = vi.fn(async (directory: string) =>
      (tree[directory] ?? []).map((entry) => ({ ...entry, size: 1, mode: 0o600 })),
    );
    const read = vi.fn(async (filePath: string) => new TextEncoder().encode(filePath));
    const desktop = {
      sandboxId: "sbx-live",
      commands: { run: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })) },
      files: { list, read },
      setTimeout: vi.fn(async () => undefined),
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
      kill: vi.fn(async () => true),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const live: ComputerRef = { id: "sbx-live", providerRef: "sbx-live", kind: "e2b", botId: "b" };

    const saved: string[] = [];
    for await (const file of provider.exportWorkspace(live, context)) saved.push(file.path);

    expect(saved.sort()).toEqual([
      "bots/app/node_modules.txt",
      "bots/app/package.json",
      "bots/app/src/index.ts",
      "notes.txt",
    ]);
    // The skipped folders are never even listed, so their files cost nothing.
    const listed = list.mock.calls.map(([directory]) => directory);
    expect(listed).not.toContain(`${root}/bots/app/node_modules`);
    expect(listed).not.toContain(`${root}/bots/app/__pycache__`);
    expect(listed).not.toContain(`${root}/bots/app/.pnpm-store`);
  });
});
