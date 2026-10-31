import { readFileSync } from "node:fs";
import type { AdapterContext, ComputerRef, PageBrowserCommand } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserProvider } from "./browser-provider-factory.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { desktopCommandResponder } from "./linux-desktop.test-support.js";
import { remoteDesktopPageBrowser } from "./remote-desktop-page-browser.js";
import { pageBrowserDesktop } from "./remote-desktop-page-browser-command.js";
import { PAGE_BROWSER_SOURCE } from "./remote-desktop-page-browser-source.js";
import type { CommandResult, RemoteDesktop, RemoteDesktopSdk } from "./remote-desktop-sandbox.js";

const context: AdapterContext = {
  operationId: "page-test",
  traceId: "page-test",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  screenLeaseId: "run:2",
  signal: new AbortController().signal,
};
const snapshot = { command: "snapshot" } as const;
const click: PageBrowserCommand = { command: "act", actions: [{ kind: "click", ref: "e1" }] };
const success = {
  ok: true,
  url: "https://example.test/",
  title: "Fixture",
  tree: "",
  elements: [],
};
const result = (output: unknown, exitCode = 0, stderr = ""): CommandResult => ({
  exitCode,
  stdout: JSON.stringify(output),
  stderr,
});

function fixture() {
  const respond = desktopCommandResponder();
  const run = vi.fn<RemoteDesktop["commands"]["run"]>(async (command) => {
    if (command.includes("READY="))
      return { exitCode: 0, stdout: "INSTALL=/usr/local/bin/rakazo-page-browser\n", stderr: "" };
    return respond(command) ?? { exitCode: 0, stdout: "", stderr: "" };
  });
  const handle = {
    wait: vi.fn(async () => result(success)),
    sendStdin: vi.fn<(data: string, options?: unknown) => Promise<void>>(async () => {}),
    closeStdin: vi.fn(async () => {}),
    kill: vi.fn(async () => true),
    disconnect: vi.fn(async () => {}),
  };
  const start = vi.fn<NonNullable<RemoteDesktop["commands"]["startPageBrowser"]>>(
    async () => handle,
  );
  const desktop: RemoteDesktop = {
    sandboxId: "test-box",
    setTimeout: vi.fn(async () => {}),
    getHost: (port) => `${port}.example.test`,
    commands: { run, startPageBrowser: start },
    files: {
      makeDir: vi.fn(),
      list: vi.fn(),
      getInfo: vi.fn(),
      read: vi.fn(),
      write: vi.fn(async () => {}),
    },
  };
  const screen = vi.fn(async () => ({
    layout: { display: ":21", debugPort: 9242 },
    env: { workspaceDir: "/home/user/rakazo-home" },
  }));
  const call = (body: PageBrowserCommand = snapshot, ctx = context) =>
    remoteDesktopPageBrowser(async () => desktop, screen, body, ctx);
  return { desktop, run, handle, start, screen, call };
}

afterEach(() => vi.useRealTimers());

it("bundles exactly the deployed Python helper bytes", () => {
  expect(Buffer.from(PAGE_BROWSER_SOURCE)).toEqual(
    readFileSync(new URL("../../../infra/sandboxes/computer/rakazo-page-browser", import.meta.url)),
  );
});

it("keeps local validation identical to the supervisor route", () => {
  const supervisor = readFileSync(
    new URL("../../../infra/sandboxes/supervisor/src/index.ts", import.meta.url),
    "utf8",
  );
  const route = supervisor.slice(supervisor.indexOf('app.post("/computers/:id/browser"'));
  const expression = route.slice(
    route.indexOf("const body = ") + "const body = ".length,
    route.indexOf(".parse(await c.req.json())"),
  );
  const local = readFileSync(
    new URL("./remote-desktop-page-browser-request.ts", import.meta.url),
    "utf8",
  );
  const normalize = (source: string) =>
    source
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\s/g, "")
      .replace(/,([)\]}])/g, "$1")
      .replace(/;$/, "");
  expect(normalize(local.slice(local.indexOf("export const")))).toBe(
    normalize(`export const remotePageBrowserRequest = ${expression};`),
  );
});

describe("remote page browser", () => {
  it("installs once per connection, verifies the content hash, and writes only helper source", async () => {
    const f = fixture();
    expect(await f.call()).toEqual(success);
    expect(await f.call()).toEqual(success);
    expect(f.desktop.files.write).toHaveBeenCalledTimes(1);
    const written = vi.mocked(f.desktop.files.write).mock.calls[0]![0][0]!;
    expect(new TextDecoder().decode(written.data)).toBe(PAGE_BROWSER_SOURCE);
    expect(f.run.mock.calls.filter(([command]) => command.includes("sha256sum"))).toHaveLength(2);
    expect(f.run.mock.calls[1]![0]).toContain("install -o root -g root -m 755");
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.start.mock.calls[0]![1]).toMatchObject({
      timeoutMs: 25_000,
      envs: {
        DISPLAY: ":21",
        RAKAZO_CDP_PORT: "9242",
        RAKAZO_BROWSER_ARGS_STDIN: "1",
        RAKAZO_BROWSER_WATCH_STDIN: "1",
      },
    });
    expect(f.start.mock.calls[0]![0]).toContain("signal.alarm(25)");
    expect(f.screen).toHaveBeenCalledTimes(2);
    expect(f.handle.closeStdin).toHaveBeenCalledTimes(2);
    expect(f.handle.disconnect).toHaveBeenCalledTimes(2);
  });

  it("uses an existing matching helper without writing it again", async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "READY=/usr/local/bin/rakazo-page-browser\n",
      stderr: "",
    });
    await f.call();
    expect(f.desktop.files.write).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("installs without root under the remote user's local directory", async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "INSTALL=/home/user/.local/lib/rakazo/rakazo-page-browser\n",
      stderr: "",
    });
    expect(await f.call()).toEqual(success);
    expect(f.run.mock.calls[1]![0]).toContain("install -m 755");
    expect(f.run.mock.calls[1]![0]).not.toContain("sudo");
    expect(f.start.mock.calls[0]![0]).toContain("/home/user/.local/lib/rakazo/rakazo-page-browser");
  });

  it("retries failed installation and checks again on a new connection", async () => {
    const f = fixture();
    vi.mocked(f.desktop.files.write).mockRejectedValueOnce(new Error("write failed"));
    expect(await f.call()).toMatchObject({ ok: false, uncertain: false });
    expect(await f.call()).toEqual(success);
    expect(f.desktop.files.write).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls.filter(([command]) => command.startsWith("rm -rf"))).toHaveLength(2);
    const next = { ...f.desktop };
    await remoteDesktopPageBrowser(async () => next, f.screen, snapshot, context);
    expect(f.desktop.files.write).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      kind: "fill",
      ref: "e1",
      text: "fake-login-secret",
      origin: "https://example.test",
      field: "password",
    },
    {
      kind: "fill",
      text: "fake-card-secret",
      origin: "https://example.test",
      field: "card",
      cardField: "number",
    },
    {
      kind: "pay_token",
      text: "fake-token-secret",
      origin: "https://example.test",
      merchantAccountId: "acct_fake",
    },
  ])(
    "sends credentials only over stdin and redacts echoed values: $kind $field",
    async (action) => {
      const f = fixture();
      const body = { command: "act", actions: [action] } as PageBrowserCommand;
      f.handle.wait.mockResolvedValue(
        result({ ...success, error: action.text, elements: [{ value: action.text }] }),
      );
      const output = await f.call(body);
      expect(JSON.stringify(output)).not.toContain(action.text);
      expect(JSON.stringify(f.run.mock.calls)).not.toContain(action.text);
      expect(JSON.stringify(f.start.mock.calls)).not.toContain(action.text);
      expect(f.handle.sendStdin.mock.calls[0]![0]).toBe(`${JSON.stringify(body)}\n`);
      expect(vi.mocked(f.desktop.files.write).mock.calls).toHaveLength(1);
      expect(
        new TextDecoder().decode(vi.mocked(f.desktop.files.write).mock.calls[0]![0][0]!.data),
      ).not.toContain(action.text);
    },
  );

  it("does not expose SDK errors or malformed JSON containing secrets", async () => {
    const f = fixture();
    f.handle.wait.mockRejectedValueOnce(new Error("fake-secret-in-sdk-error"));
    expect(JSON.stringify(await f.call(click))).not.toContain("fake-secret-in-sdk-error");
    f.handle.wait.mockResolvedValueOnce({ exitCode: 0, stdout: "fake-secret-in-json", stderr: "" });
    expect(JSON.stringify(await f.call())).not.toContain("fake-secret-in-json");
  });

  it.each([click, snapshot])("maps nonzero exit conservatively: $command", async (body) => {
    const f = fixture();
    f.handle.wait.mockResolvedValue(result({}, 1, "private SDK detail"));
    expect(await f.call(body)).toMatchObject({
      ok: false,
      fallback: "computer_act",
      uncertain: body.command === "act",
      error: expect.stringContaining("unavailable"),
    });
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it.each([click, snapshot])(
    "reports helper deadline with recovery advice: $command",
    async (body) => {
      const f = fixture();
      f.handle.wait.mockResolvedValue(result({}, 124));
      expect(await f.call(body)).toMatchObject({
        uncertain: body.command === "act",
        error: expect.stringContaining(
          body.command === "act" ? "Inspect the screen" : "Retry once",
        ),
      });
    },
  );

  it("limits time even when the SDK ignores its timeout", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.handle.wait.mockImplementation(() => new Promise(() => {}));
    const output = f.call(click);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await output).toMatchObject({
      ok: false,
      uncertain: true,
      error: expect.stringContaining("timed out"),
    });
    expect(f.handle.closeStdin).toHaveBeenCalled();
    expect(f.handle.disconnect).toHaveBeenCalled();
  });

  it("cancels in-flight helper work and stops it with stdin EOF", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.handle.wait.mockImplementation(async () => {
      controller.abort(new Error("cancelled"));
      return new Promise(() => {});
    });
    await expect(f.call(click, { ...context, signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(f.handle.closeStdin).toHaveBeenCalledWith({ requestTimeoutMs: 5_000 });
    expect(f.handle.disconnect).toHaveBeenCalled();
  });

  it("stops a handle returned after cancellation during startup without sending credentials", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.start.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled during start"));
      return f.handle;
    });
    await expect(f.call(click, { ...context, signal: controller.signal })).rejects.toThrow(
      "cancelled during start",
    );
    expect(f.handle.sendStdin).not.toHaveBeenCalled();
    expect(f.handle.closeStdin).toHaveBeenCalled();
    expect(f.handle.disconnect).toHaveBeenCalled();
  });

  it("cancels while sending credentials and disconnects the helper", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.handle.sendStdin.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled during stdin"));
      return new Promise(() => {});
    });
    await expect(f.call(click, { ...context, signal: controller.signal })).rejects.toThrow(
      "cancelled during stdin",
    );
    expect(f.handle.closeStdin).toHaveBeenCalled();
    expect(f.handle.disconnect).toHaveBeenCalled();
  });

  it("maps the remote Python alarm and the SDK deadline to timeouts", async () => {
    const f = fixture();
    f.handle.wait.mockRejectedValueOnce({ exitCode: 142 });
    expect(await f.call(click)).toMatchObject({
      uncertain: true,
      error: expect.stringContaining("timed out"),
    });
    f.handle.wait.mockRejectedValueOnce(
      Object.assign(new Error("deadline_exceeded"), { name: "TimeoutError" }),
    );
    expect(await f.call()).toMatchObject({
      uncertain: false,
      error: expect.stringContaining("timed out"),
    });
  });

  it("shares a pending install only within the same sandbox connection", async () => {
    const f = fixture();
    await Promise.all([f.call(), f.call()]);
    expect(f.desktop.files.write).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(2);
  });

  it("keeps upload paths relative to the portable workspace and uses the helper's default limit", async () => {
    const f = fixture();
    const body: PageBrowserCommand = {
      command: "act",
      actions: [
        {
          kind: "upload",
          ref: "e1",
          paths: ["bots/bot/file.txt"],
          roots: ["bots/bot", "shared"],
        },
      ],
    };
    await f.call(body);
    expect(f.handle.sendStdin.mock.calls[0]![0]).toBe(`${JSON.stringify(body)}\n`);
    expect(f.start.mock.calls[0]![1].envs).toMatchObject({ HOME: "/home/user/rakazo-home" });
    expect(f.start.mock.calls[0]![1].envs).not.toHaveProperty("RAKAZO_BROWSER_UPLOAD_MAX_BYTES");
  });

  it("kills the helper if EOF cannot be delivered", async () => {
    const f = fixture();
    f.handle.closeStdin.mockRejectedValueOnce(new Error("EOF failed"));
    await f.call();
    expect(f.handle.kill).toHaveBeenCalled();
    expect(f.handle.disconnect).toHaveBeenCalled();
  });

  it("refuses an already aborted request before connecting", async () => {
    const f = fixture();
    await expect(f.call(snapshot, { ...context, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(["buffered", "streamed"])("caps %s output at 512 KiB", async (mode) => {
    const f = fixture();
    if (mode === "buffered")
      f.handle.wait.mockResolvedValue(result({ ...success, tree: "x".repeat(512 * 1024) }));
    else
      f.start.mockImplementationOnce(async (_command, options) => {
        options.onStdout("x".repeat(512 * 1024 + 1));
        return f.handle;
      });
    expect(await f.call(click)).toMatchObject({
      ok: false,
      fallback: "computer_act",
      uncertain: true,
    });
    expect(f.handle.disconnect).toHaveBeenCalled();
  });

  it("reensures the screen and retries exactly once before any browser connection", async () => {
    const f = fixture();
    f.handle.wait.mockResolvedValueOnce(
      result({ ok: false, uncertain: false, error: "CDP not ready on port 9242" }),
    );
    expect(await f.call(click)).toEqual(success);
    expect(f.screen).toHaveBeenCalledTimes(2);
    expect(f.start).toHaveBeenCalledTimes(2);
    f.handle.wait.mockResolvedValue(
      result({ ok: false, uncertain: false, error: "CDP not ready" }),
    );
    expect(await f.call()).toMatchObject({ ok: false });
    expect(f.start).toHaveBeenCalledTimes(4);
  });

  it.each([
    { ok: false, uncertain: true, error: "CDP not ready" },
    { ok: false, uncertain: false, error: "Field missing", completed: 0 },
    { ok: false, uncertain: true, fallback: "computer_act", completed: 1 },
  ])("preserves settled and partial failures without replaying actions: %j", async (payload) => {
    const f = fixture();
    f.handle.wait.mockResolvedValue(result(payload));
    expect(await f.call(click)).toEqual(payload);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    { command: "navigate", url: "http://user:fake-password@example.test" },
    { command: "navigate", url: "data:text/html,<input>" },
    { command: "act", actions: [] },
    { command: "act", actions: Array(25).fill({ kind: "click", ref: "e1" }) },
    {
      command: "act",
      actions: [{ kind: "fill", ref: "e1", text: "fake-password", origin: "https://example.test" }],
    },
    {
      command: "act",
      actions: [{ kind: "fill", text: "fake-card", field: "card", cardField: "number" }],
    },
    { command: "act", actions: [{ kind: "type", ref: "e1", text: "x".repeat(32_001) }] },
  ])("rejects invalid requests before touching the sandbox: $command", async (request) => {
    const f = fixture();
    expect(await f.call(request as PageBrowserCommand)).toMatchObject({
      ok: false,
      uncertain: false,
      error: "Invalid page browser request",
    });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.screen).not.toHaveBeenCalled();
  });
});

it("wraps SDK commands with background stdin support and keeps methods bound", async () => {
  const f = fixture();
  const nativeRun = vi.fn(async () => f.handle);
  const wrapped = pageBrowserDesktop({
    ...f.desktop,
    commands: { run: nativeRun },
  } as unknown as Parameters<typeof pageBrowserDesktop>[0]);
  const onOutput = vi.fn();
  expect(
    await wrapped.commands.startPageBrowser!("helper", { onStdout: onOutput, onStderr: onOutput }),
  ).toBe(f.handle);
  expect(nativeRun).toHaveBeenCalledWith("helper", {
    background: true,
    stdin: true,
    onStdout: onOutput,
    onStderr: onOutput,
  });
  await wrapped.setTimeout(10);
  expect(f.desktop.setTimeout).toHaveBeenCalledWith(10);
  expect(wrapped.getHost(123)).toBe("123.example.test");
});

it("advertises E2B page capability and routes browser commands to each bot's owned screen", async () => {
  const f = fixture();
  const sdk: RemoteDesktopSdk = {
    create: vi.fn(),
    connect: vi.fn(async () => f.desktop),
    pause: vi.fn(),
    kill: vi.fn(),
  };
  const provider = new E2BSandboxProvider("test-key", sdk);
  const browser = createBrowserProvider("computer", { sandbox: provider });
  expect(browser.describe().capabilities.page).toBe(true);
  const computer: ComputerRef = {
    id: "test-box",
    providerRef: "test-box",
    kind: "e2b",
    botId: "bot",
  };
  await browser.navigate(computer, { url: "https://example.test/" }, context);
  await browser.snapshot(
    computer,
    {},
    { ...context, botId: "other-bot", screenLeaseId: "other:1" },
  );
  f.handle.wait.mockResolvedValueOnce(result({ ...success, completed: 1 }));
  const filled = await browser.act(
    computer,
    {
      actions: [
        {
          kind: "fill",
          ref: "e1",
          text: "fake-e2b-login",
          origin: "https://example.test",
          field: "password",
        },
      ],
    },
    context,
  );
  expect(filled.ok).toBe(true);
  expect(filled.completed).toBe(1);
  expect(f.start.mock.calls.map(([, opts]) => opts.envs?.DISPLAY)).toEqual([":20", ":21", ":20"]);
  expect(f.start.mock.calls.map(([, opts]) => opts.envs?.RAKAZO_CDP_PORT)).toEqual([
    "9241",
    "9242",
    "9241",
  ]);
  expect(f.run.mock.calls.some(([command]) => command.includes("run:2"))).toBe(true);
  // Fencing failure from the exact same LinuxDesktop path as observe/act stops the helper.
  f.run.mockImplementationOnce(async () => ({ exitCode: 75, stdout: "", stderr: "" }));
  expect(await provider.pageBrowser(computer, snapshot, context)).toMatchObject({ ok: false });
  expect(f.start).toHaveBeenCalledTimes(3);
});
