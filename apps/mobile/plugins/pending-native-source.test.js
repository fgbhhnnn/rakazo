import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readPendingAddition } from "./pending-native-source";

const patch = readFileSync(
  new URL("../native-pending/upstream-native.patch", import.meta.url),
  "utf8",
);
const additions = patch
  .split(/(?=^diff --git )/m)
  .filter((section) => section.includes("\nnew file mode 100644\n"));
const files = additions.map((section) => section.match(/^diff --git a\/(\S+) b\/\1\n/)[1]);
let directory;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "rakazo-pending-native-"));
  execFileSync("git", ["apply", "-"], { cwd: directory, input: additions.join("") });
});

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("deferred native source contracts", () => {
  it.each(files)("reads the exact patch-applied contents of %s", (file) => {
    expect(readPendingAddition(file.slice("apps/mobile/".length))).toBe(
      readFileSync(join(directory, file), "utf8"),
    );
  });

  it("rejects paths that are not archived additions", () => {
    expect(() => readPendingAddition("missing.swift")).toThrow("No deferred native addition");
    expect(() => readPendingAddition("app.config.ts")).toThrow("No deferred native addition");
  });
});
