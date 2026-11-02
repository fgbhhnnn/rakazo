import { getLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortableFileNames } from "./portable-file-names.js";

afterEach(() => vi.restoreAllMocks());

describe("portable file names", () => {
  it("removes every C0, DEL and C1 control, quotes and lone surrogates", () => {
    const controls = Array.from({ length: 0xa0 }, (_, code) => code)
      .filter((code) => code <= 0x1f || code >= 0x7f)
      .map((code) => String.fromCharCode(code));
    for (const character of [...controls, '"', "\ud800", "\udfff"]) {
      const names = new PortableFileNames();
      const original = `${character}file.txt`;
      expect(names.path(original)).toBe("file.txt");
      expect(names.mapping.get(original)).toBe("file.txt");
    }
  });

  it("keeps ordinary Unicode, spaces and valid surrogate pairs unchanged", () => {
    const warn = vi.spyOn(getLogger(), "warn");
    const names = new PortableFileNames();
    for (const name of ["file.txt", "a b/文档/你好.txt", "café/😀.md", ".env.example", "�.txt"]) {
      expect(names.path(name)).toBe(name);
      expect(names.mapping.get(name)).toBe(name);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses unnamed for empty and dot segments left after removing unsafe characters", () => {
    const names = new PortableFileNames();
    expect(names.path("\x7f")).toBe("unnamed");
    expect(names.path('"')).toBe("unnamed-1");
    expect(names.path(".\x7f")).toBe("unnamed-2");
    expect(names.path("\x7f..")).toBe("unnamed-3");
  });

  it("allocates collision suffixes before extensions within each directory", () => {
    const names = new PortableFileNames();
    expect(names.path("file.txt")).toBe("file.txt");
    expect(names.path("file-1.txt")).toBe("file-1.txt");
    expect(names.path("\x7ffile.txt")).toBe("file-2.txt");
    expect(names.path("\x01file.txt")).toBe("file-3.txt");
    expect(names.path("\x7ffile.txt")).toBe("file-2.txt");
    expect(names.path("other/\x7ffile.txt")).toBe("other/file.txt");
    expect(new PortableFileNames().path("\x7ffile.txt")).toBe("file.txt");
  });

  it("keeps directory renames consistent and separates colliding files and directories", () => {
    const names = new PortableFileNames();
    expect(names.path("dir")).toBe("dir");
    expect(names.path("\x7fdir/\x01nested/a.txt")).toBe("dir-1/nested/a.txt");
    expect(names.path("\x7fdir/\x01nested/b.txt")).toBe("dir-1/nested/b.txt");
    expect(names.path("\x7fdir/nested/c.txt")).toBe("dir-1/nested-1/c.txt");
  });

  it("escapes original control characters in rename warnings", () => {
    const warn = vi.spyOn(getLogger(), "warn");
    new PortableFileNames().path('\x7f\x80\r\n"\ud800name.txt');
    expect(warn).toHaveBeenCalledWith("renamed unsafe portable file path", {
      originalPath: '"\\u007f\\u0080\\r\\n\\"\\ud800name.txt"',
      path: '"name.txt"',
    });
  });

  it.each(["../file", "dir/../file", "./file", "", "/"])(
    "keeps rejecting invalid workspace paths: %s",
    (name) => expect(() => new PortableFileNames().path(name)).toThrow(),
  );
});
