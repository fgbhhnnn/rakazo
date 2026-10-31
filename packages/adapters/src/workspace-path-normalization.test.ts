import type { ComputerMode } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveBotUploadPath, resolveBotWorkspacePath } from "./computer-support.js";
import { readFileFromTool } from "./workspace-file-tools.js";
import { normalizeWorkspacePath, workspacePath } from "./workspace-path-normalization.js";

const root = "/home/user/rakazo-home";

describe("workspace filesystem path normalization", () => {
  it.each([
    "out/x.txt",
    "/out/x.txt",
    `${root}/out/x.txt`,
    "/home/user/out/x.txt",
    `${root}/home/user/out/x.txt`,
    `${root}${root}/out/x.txt`,
    `${root}/home/user${root}/out/x.txt`,
    String.raw`\home\user\rakazo-home\out\x.txt`,
  ])("maps %s inside the workspace without adding the root again", (requested) => {
    expect(workspacePath(root, requested)).toBe(`${root}/out/x.txt`);
    // listFiles normalizes its input before calling workspacePath.
    expect(workspacePath(root, normalizeWorkspacePath(requested))).toBe(`${root}/out/x.txt`);
  });

  it.each(["", "/", root, "/home/user", `${root}/home/user`])(
    "resolves root alias %s",
    (requested) => {
      expect(workspacePath(root, requested)).toBe(root);
    },
  );

  it("supports other configured roots without treating similar names as their prefix", () => {
    expect(workspacePath("/workspace", "/workspace/out.txt")).toBe("/workspace/out.txt");
    expect(workspacePath("/workspace", "/workspace-other/out.txt")).toBe(
      "/workspace/workspace-other/out.txt",
    );
    expect(workspacePath(root, "/home/user-other/out.txt")).toBe(`${root}/home/user-other/out.txt`);
    expect(workspacePath(root, "/etc/passwd")).toBe(`${root}/etc/passwd`);
    expect(resolveBotWorkspacePath("dedicated", "bot", "/home/user-other/out.txt")).toBe(
      "/home/user-other/out.txt",
    );
  });

  it.each([
    "../x",
    "a/../../x",
    `${root}/../x`,
    "/home/user/../x",
    `${root}/home/user/../x`,
    `${root}/out/./x`,
    String.raw`\home\user\rakazo-home\..\x`,
  ])("rejects traversal before removing any prefixes: %s", (requested) => {
    expect(() => workspacePath(root, requested)).toThrow("Path escapes the computer workspace");
    expect(() => resolveBotWorkspacePath("team", "bot", requested)).toThrow(
      "Path escapes the computer workspace",
    );
  });

  it("keeps upload authorization for other bots after normalizing absolute roots", () => {
    expect(resolveBotUploadPath("team", "bot", `${root}/bots/bot/out.txt`)).toBe(
      "bots/bot/out.txt",
    );
    expect(resolveBotUploadPath("team", "bot", `${root}/shared/out.txt`)).toBe("shared/out.txt");
    expect(() => resolveBotUploadPath("team", "bot", `${root}/bots/other/out.txt`)).toThrow(
      "Path escapes the bot workspace",
    );
  });

  it.each<ComputerMode>(["dedicated", "team"])(
    "reads real absolute and doubled worker output paths in %s mode",
    async (mode) => {
      const readFile = vi.fn(async (_computer: unknown, file: string) => {
        if (workspacePath(root, file) !== `${root}/bots/bot/out.txt`) throw new Error("not_found");
        return new TextEncoder().encode("fixture content");
      });
      const workspace = {
        botId: "bot",
        computerMode: mode,
        computer: async () => ({ id: "fixture" }) as never,
        context: {} as never,
        runSecrets: [],
        markDirty: () => {},
      };
      for (const file of [
        `${root}/bots/bot/out.txt`,
        "/home/user/bots/bot/out.txt",
        `${root}/home/user/bots/bot/out.txt`,
      ]) {
        expect(await readFileFromTool({ readFile } as never, workspace, { path: file })).toEqual({
          path: file,
          content: "fixture content",
        });
      }
      expect(readFile).toHaveBeenCalledTimes(3);
    },
  );
});
