import { createHash, randomUUID } from "node:crypto";
import type { AdapterContext, PageBrowserCommand, PageBrowserResult } from "@rakazo/adapter-kit";
import { shellQuote } from "./computer-support.js";
import type { PageBrowserCommandHandle } from "./remote-desktop-page-browser-command.js";
import { remotePageBrowserRequest } from "./remote-desktop-page-browser-request.js";
import { PAGE_BROWSER_SOURCE } from "./remote-desktop-page-browser-source.js";
import type { CommandResult, RemoteDesktop } from "./remote-desktop-sandbox.js";

const TIMEOUT_MS = 25_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const HELPER_HASH = createHash("sha256").update(PAGE_BROWSER_SOURCE).digest("hex");
const installed = new WeakMap<RemoteDesktop, Promise<string>>();
const UNAVAILABLE =
  "Page browser unavailable or interrupted. Inspect the screen before continuing.";
// One process owns the remote deadline, stdin watcher, and CDP connection. Killing the SDK
// handle must not orphan a child that could still type a credential into the page.
const WATCHDOG =
  'import runpy,signal,sys;signal.alarm(25);sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name="__main__")';
type PageBrowserScreen = {
  layout: { display: string; debugPort: number };
  env: { workspaceDir: string };
};

/** The helper ships as TS data so the API's esbuild bundle needs no runtime infra files. */
async function install(desktop: RemoteDesktop, signal: AbortSignal): Promise<string> {
  const cached = installed.get(desktop);
  if (cached) return cached;
  const pending = installHelper(desktop, signal);
  installed.set(desktop, pending);
  try {
    return await pending;
  } catch (error) {
    if (installed.get(desktop) === pending) installed.delete(desktop);
    throw error;
  }
}

async function installHelper(desktop: RemoteDesktop, signal: AbortSignal): Promise<string> {
  // A private staging directory also keeps parallel connections' installations independent.
  const stage = `/tmp/rakazo-page-browser-${randomUUID()}`;
  const setup = await desktop.commands.run(
    `bash -c ${shellQuote(
      [
        "set -eu",
        'if [ "$(id -u)" -eq 0 ] || sudo -n true 2>/dev/null; then',
        "  target=/usr/local/bin/rakazo-page-browser",
        'else target="$HOME/.local/lib/rakazo/rakazo-page-browser"; fi',
        `if [ -f "$target" ] && [ "$(sha256sum "$target" | cut -d ' ' -f1)" = ${HELPER_HASH} ]; then`,
        '  printf "READY=%s\\n" "$target"',
        "else",
        `  (umask 077; mkdir ${shellQuote(stage)})`,
        '  printf "INSTALL=%s\\n" "$target"',
        "fi",
      ].join("\n"),
    )}`,
    { signal, timeoutMs: TIMEOUT_MS },
  );
  if (setup.exitCode !== 0) throw new Error(UNAVAILABLE);
  const match = setup.stdout.trim().match(/^(READY|INSTALL)=(\/[^\n]+)$/);
  if (!match) throw new Error(UNAVAILABLE);
  const target = match[2]!;
  if (match[1] === "READY") return target;
  const next = `${target}.${randomUUID()}`;
  try {
    await desktop.files.write(
      [{ path: `${stage}/helper`, data: new TextEncoder().encode(PAGE_BROWSER_SOURCE).buffer }],
      { signal },
    );
    const result = await desktop.commands.run(
      `bash -c ${shellQuote(
        [
          "set -eu",
          `trap 'rm -rf ${stage}' EXIT`,
          `test "$(sha256sum ${stage}/helper | cut -d ' ' -f1)" = ${HELPER_HASH}`,
          ...(target === "/usr/local/bin/rakazo-page-browser"
            ? [
                'if [ "$(id -u)" -eq 0 ]; then root=""; else root="sudo -n"; fi',
                `$root install -o root -g root -m 755 ${stage}/helper ${shellQuote(next)}`,
                `$root mv -f -- ${shellQuote(next)} ${shellQuote(target)}`,
              ]
            : [
                `mkdir -p -- ${shellQuote(target.slice(0, target.lastIndexOf("/")))}`,
                `install -m 755 ${stage}/helper ${shellQuote(next)}`,
                `mv -f -- ${shellQuote(next)} ${shellQuote(target)}`,
              ]),
        ].join("\n"),
      )}`,
      { signal, timeoutMs: TIMEOUT_MS },
    );
    if (result.exitCode !== 0) throw new Error(UNAVAILABLE);
    return target;
  } finally {
    // Use an independent request after cancellation; no credentials ever enter this directory.
    await desktop.commands
      .run(`rm -rf -- ${shellQuote(stage)}`, { timeoutMs: 5_000 })
      .catch(() => undefined);
  }
}

async function runHelper(
  desktop: RemoteDesktop,
  helper: string,
  screen: PageBrowserScreen,
  body: PageBrowserCommand,
  signal: AbortSignal,
): Promise<CommandResult> {
  if (!desktop.commands.startPageBrowser) throw new Error(UNAVAILABLE);
  const limit = new AbortController();
  const combined = AbortSignal.any([signal, limit.signal]);
  let bytes = 0;
  const countOutput = (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_OUTPUT_BYTES) limit.abort(new Error(UNAVAILABLE));
  };
  const timer = setTimeout(() => limit.abort(new Error("Page browser timed out")), TIMEOUT_MS);
  let handle: PageBrowserCommandHandle | undefined;
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(combined.reason);
  });
  void interrupted.catch(() => undefined);
  combined.addEventListener("abort", abort, { once: true });
  try {
    combined.throwIfAborted();
    // Await start even if cancellation wins during startup: its eventual handle must be stopped.
    handle = await desktop.commands.startPageBrowser(
      `exec python3 -c ${shellQuote(WATCHDOG)} ${shellQuote(helper)} ${body.command}`,
      {
        signal: combined,
        timeoutMs: TIMEOUT_MS,
        envs: {
          DISPLAY: screen.layout.display,
          RAKAZO_CDP_PORT: String(screen.layout.debugPort),
          // Upload paths and trusted roots are relative to Rakazo's portable workspace.
          HOME: screen.env.workspaceDir,
          RAKAZO_BROWSER_ARGS_STDIN: "1",
          RAKAZO_BROWSER_WATCH_STDIN: "1",
        },
        onStdout: countOutput,
        onStderr: countOutput,
      },
    );
    combined.throwIfAborted();
    await Promise.race([
      handle.sendStdin(`${JSON.stringify(body)}\n`, { signal: combined }),
      interrupted,
    ]);
    const result = await Promise.race([handle.wait(), interrupted]);
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES)
      throw new Error(UNAVAILABLE);
    return result;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "exitCode" in error &&
      (error.exitCode === 124 || error.exitCode === 142)
    )
      throw new Error("Page browser timed out");
    throw error;
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", abort);
    if (handle) {
      // EOF terminates only the helper, through its existing stdin watcher, never Chromium.
      await handle
        .closeStdin({ requestTimeoutMs: 5_000 })
        .catch(() => handle?.kill())
        .catch(() => undefined);
      await handle.disconnect().catch(() => undefined);
    }
  }
}

export async function remoteDesktopPageBrowser(
  desktop: () => Promise<RemoteDesktop>,
  screen: () => Promise<PageBrowserScreen>,
  request: PageBrowserCommand,
  context: AdapterContext,
): Promise<PageBrowserResult> {
  context.signal.throwIfAborted();
  const parsed = remotePageBrowserRequest.safeParse(request);
  if (!parsed.success)
    return {
      ok: false,
      fallback: "computer_act",
      uncertain: false,
      error: "Invalid page browser request",
    };
  const body = parsed.data as PageBrowserCommand;
  try {
    const box = await desktop();
    const helper = await install(box, context.signal);
    let result = await runHelper(box, helper, await screen(), body, context.signal);
    if (notReady(result))
      result = await runHelper(box, helper, await screen(), body, context.signal);
    if (result.exitCode !== 0) {
      if (
        result.exitCode === 124 ||
        result.exitCode === 142 ||
        /command timed out/.test(result.stderr)
      )
        throw new Error("Page browser timed out");
      throw new Error(UNAVAILABLE);
    }
    if (Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES) throw new Error(UNAVAILABLE);
    const output = JSON.parse(result.stdout) as PageBrowserResult;
    if (!output || typeof output !== "object" || typeof output.ok !== "boolean")
      throw new Error(UNAVAILABLE);
    // Defense in depth: helper errors and snapshots must never echo origin-bound credentials.
    const secrets =
      body.command === "act"
        ? body.actions.flatMap((step) =>
            "origin" in step && step.origin && "text" in step && step.text ? [step.text] : [],
          )
        : [];
    return redact(output, secrets) as PageBrowserResult;
  } catch (error) {
    context.signal.throwIfAborted();
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" ||
        /Page browser timed out|deadline_exceeded|exceeding 'timeoutMs'/.test(error.message));
    return {
      ok: false,
      fallback: "computer_act",
      uncertain: body.command === "act",
      error: timedOut
        ? `Page browser timed out; the page may be busy or blocked by a dialog. ${body.command === "act" ? "Inspect the screen before continuing." : "Retry once before using other tools."}`
        : UNAVAILABLE,
    };
  }
}

function notReady(result: CommandResult): boolean {
  if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES) return false;
  try {
    const output = JSON.parse(result.stdout) as PageBrowserResult;
    return (
      output.ok === false &&
      output.uncertain !== true &&
      typeof output.error === "string" &&
      output.error.startsWith("CDP not ready")
    );
  } catch {
    return false;
  }
}

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string")
    return secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]),
    );
  return value;
}
