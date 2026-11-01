import type { CommandResult, CommandStartOpts, RemoteDesktop } from "./remote-desktop-sandbox.js";

export interface PageBrowserCommandHandle {
  wait(): Promise<CommandResult>;
  sendStdin(
    data: string,
    options?: { signal?: AbortSignal; requestTimeoutMs?: number },
  ): Promise<void>;
  closeStdin(options?: { requestTimeoutMs?: number }): Promise<void>;
  kill(): Promise<boolean>;
  disconnect(): Promise<void>;
}

/** Keep the SDK's interactive command API outside the shared desktop contract. */
export function pageBrowserDesktop(
  desktop: RemoteDesktop & {
    commands: {
      run(
        command: string,
        options: CommandStartOpts & {
          background: true;
          stdin: true;
          onStdout: (data: string) => void;
          onStderr: (data: string) => void;
        },
      ): Promise<PageBrowserCommandHandle>;
    };
  },
): RemoteDesktop {
  return {
    sandboxId: desktop.sandboxId,
    setTimeout: (timeoutMs) => desktop.setTimeout(timeoutMs),
    getHost: (port) => desktop.getHost(port),
    files: desktop.files,
    commands: {
      run: (command, options) => desktop.commands.run(command, options),
      startPageBrowser: (command, options) =>
        desktop.commands.run(command, { ...options, background: true, stdin: true }),
    },
  };
}
