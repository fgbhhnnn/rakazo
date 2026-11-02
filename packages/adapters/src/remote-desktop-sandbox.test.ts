import type { ComputerRef, PortableFile } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteDesktop, RemoteDesktopSdk } from "./remote-desktop-sandbox.js";
import { RemoteDesktopSandboxProvider } from "./remote-desktop-sandbox.js";

const context = {
  operationId: "restore-test",
  traceId: "restore-test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

function fixture(id: "e2b" | "novita") {
  const desktop: RemoteDesktop = {
    sandboxId: "computer",
    setTimeout: vi.fn(async () => {}),
    getHost: () => "computer.test",
    commands: { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })) },
    files: {
      makeDir: vi.fn(async () => true),
      list: vi.fn(async () => []),
      getInfo: vi.fn(),
      read: vi.fn(),
      write: vi.fn(async () => {}),
    },
  };
  const sdk: RemoteDesktopSdk = {
    create: vi.fn(async () => desktop),
    connect: vi.fn(async () => desktop),
    pause: vi.fn(async () => {}),
    kill: vi.fn(async () => true),
  };
  const provider = new RemoteDesktopSandboxProvider({
    id,
    label: id,
    apiKey: "test-key",
    template: "test-template",
    sdk,
    isTimeoutError: () => false,
  });
  const computer: ComputerRef = { id: "computer", providerRef: "computer", kind: id, botId: "bot" };
  return { provider, computer, desktop };
}

async function* files(paths: string[]): AsyncGenerator<PortableFile> {
  for (const path of paths) yield { path, content: Buffer.from(path), executable: true };
}

afterEach(() => vi.restoreAllMocks());

describe.each(["e2b", "novita"] as const)("%s home uploads", (id) => {
  it("also sanitizes direct single-file uploads", async () => {
    const { provider, computer, desktop } = fixture(id);
    await provider.writeFile(
      computer,
      { path: "\x7fdir/\ud800name.txt", content: Buffer.from("data") },
      context,
    );
    expect(desktop.files.write).toHaveBeenCalledWith(
      [{ path: "/home/user/rakazo-home/dir/name.txt", data: expect.any(ArrayBuffer) }],
      { signal: context.signal },
    );
  });

  it("renames unsafe paths and collisions across batches while preserving bytes and Unicode", async () => {
    const { provider, computer, desktop } = fixture(id);
    const paths = [
      "file.txt",
      ...Array.from({ length: 31 }, (_, index) => `normal-${index}.txt`),
      "\x7ffile.txt",
      "\x7fdir/\x01nested/你好😀.txt",
      "\x7fdir/\x01nested/other.txt",
      "文档/café.txt",
    ];
    await provider.importWorkspace(computer, files(paths), context);
    const writes = vi.mocked(desktop.files.write).mock.calls;
    expect(writes.map(([batch]) => batch.length)).toEqual([32, 4]);
    const uploaded = writes.flatMap(([batch]) => batch);
    expect(uploaded.map((file) => file.path)).toEqual([
      ...paths.slice(0, 32).map((path) => `/home/user/rakazo-home/${path}`),
      "/home/user/rakazo-home/file-1.txt",
      "/home/user/rakazo-home/dir/nested/你好😀.txt",
      "/home/user/rakazo-home/dir/nested/other.txt",
      "/home/user/rakazo-home/文档/café.txt",
    ]);
    expect(uploaded.map((file) => Buffer.from(file.data).toString())).toEqual(paths);
    expect(desktop.commands.run).toHaveBeenLastCalledWith(
      expect.stringContaining("chmod 700 -- '/home/user/rakazo-home/file-1.txt'"),
      { signal: context.signal },
    );
  });

  it("retries rejected batches individually and skips a rejected file with a warning", async () => {
    const { provider, computer, desktop } = fixture(id);
    const warn = vi.spyOn(getLogger(), "warn");
    vi.mocked(desktop.files.write).mockImplementation(async (batch) => {
      if (batch.some((file) => file.path.endsWith("/bad.txt"))) {
        throw new Error("500: malformed MIME header line");
      }
    });
    await provider.importWorkspace(computer, files(["first.txt", "bad.txt", "last.txt"]), context);
    expect(vi.mocked(desktop.files.write).mock.calls.map(([batch]) => batch.length)).toEqual([
      3, 1, 1, 1,
    ]);
    expect(desktop.commands.run).toHaveBeenLastCalledWith(
      "chmod 700 -- '/home/user/rakazo-home/last.txt'",
      { signal: context.signal },
    );
    expect(warn).toHaveBeenCalledWith("skipped portable file after upload failed", {
      path: '"bad.txt"',
      error: expect.any(Error),
    });
  });

  it("propagates cancellation and stops retrying", async () => {
    const { provider, computer, desktop } = fixture(id);
    const controller = new AbortController();
    const error = new Error("cancelled");
    vi.mocked(desktop.files.write).mockImplementation(async () => {
      controller.abort(error);
      throw error;
    });
    await expect(
      provider.importWorkspace(computer, files(["a", "b"]), {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toBe(error);
    expect(desktop.files.write).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary single-file write failures visible to callers", async () => {
    const { provider, computer, desktop } = fixture(id);
    const error = new Error("write failed");
    vi.mocked(desktop.files.write).mockRejectedValue(error);
    await expect(
      provider.writeFile(computer, { path: "file.txt", content: Buffer.from("data") }, context),
    ).rejects.toBe(error);
  });

  it.each([
    Object.assign(new Error("sandbox not found"), { name: "SandboxNotFoundError" }),
    Object.assign(new Error("unauthorized"), { statusCode: 401 }),
    Object.assign(new Error("forbidden"), { statusCode: 403 }),
    Object.assign(new Error("unauthorized"), { name: "AuthenticationError" }),
    Object.assign(new Error("rate limited"), { name: "RateLimitError" }),
    Object.assign(new Error("timed out"), { name: "TimeoutError" }),
  ])("propagates sandbox loss and authorization errors: %s", async (error) => {
    const { provider, computer, desktop } = fixture(id);
    vi.mocked(desktop.files.write).mockRejectedValue(error);
    await expect(provider.importWorkspace(computer, files(["a", "b"]), context)).rejects.toThrow();
    expect(desktop.files.write).toHaveBeenCalledTimes(1);
  });
});
