import { describe, expect, it } from "vitest";
import {
  decodeFileText,
  FILE_KIND_COLORS,
  FILE_PREVIEW_MAX_ROWS,
  fileKindOf,
  filePreviewMarkdown,
  hasInAppFileViewer,
  parseDelimited,
  rowsToMarkdownTable,
  sheetsToMarkdown,
} from "./file-kinds";

describe("fileKindOf", () => {
  it.each([
    ["report.pdf", "application/pdf", "pdf", "PDF", "pdf"],
    ["data.csv", "text/csv", "sheet", "CSV", "text"],
    ["book.xlsx", "application/octet-stream", "sheet", "XLSX", "spreadsheet"],
    ["old.xls", "application/vnd.ms-excel", "sheet", "XLS", "spreadsheet"],
    ["memo.docx", "", "doc", "DOCX", "docx"],
    ["memo.doc", "application/msword", "doc", "DOC", null],
    ["deck.pptx", "", "slides", "PPTX", null],
    ["notes.txt", "text/plain", "text", "TXT", "text"],
    ["run.log", "text/plain", "text", "LOG", "text"],
    ["README.md", "text/markdown", "markdown", "MD", "text"],
    ["data.json", "application/json", "json", "JSON", "text"],
    ["page.html", "text/html", "html", "HTML", "html"],
    ["bundle.zip", "application/zip", "archive", "ZIP", null],
    ["main.py", "text/x-python", "code", "PY", "text"],
    ["voice.m4a", "audio/mp4", "audio", "M4A", "audio"],
    ["clip.mp4", "video/mp4", "video", "MP4", "video"],
    ["photo.jpeg", "image/jpeg", "image", "JPG", "image"],
    ["blob.bin", "application/octet-stream", "file", "BIN", null],
  ])("%s (%s) → %s %s", (name, mimeType, icon, badge, viewer) => {
    expect(fileKindOf({ name, mimeType })).toMatchObject({ icon, badge, viewer });
  });

  it("falls back to the MIME type when the name has no known extension", () => {
    expect(fileKindOf({ name: "export", mimeType: "application/pdf" }).badge).toBe("PDF");
    expect(
      fileKindOf({
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }).badge,
    ).toBe("PPTX");
    expect(fileKindOf({ mimeType: "text/markdown; charset=utf-8" }).badge).toBe("MD");
    expect(fileKindOf({ mimeType: "image/avif" })).toMatchObject({ icon: "image", badge: "IMAGE" });
    expect(fileKindOf({})).toMatchObject({ icon: "file", badge: "FILE", viewer: null });
  });

  it("colors PDF red, Excel/CSV green, Word blue and PowerPoint orange", () => {
    expect(fileKindOf({ name: "a.pdf" }).color).toBe(FILE_KIND_COLORS.pdf);
    expect(fileKindOf({ name: "a.csv" }).color).toBe(fileKindOf({ name: "a.xlsx" }).color);
    expect(FILE_KIND_COLORS).toMatchObject({
      pdf: "#D93025",
      sheet: "#1E7145",
      doc: "#2B579A",
      slides: "#D24726",
    });
  });
});

describe("parseDelimited", () => {
  it("handles quotes, escaped quotes, embedded delimiters and line breaks", () => {
    expect(parseDelimited('a,b\r\n"x, y","say ""hi"""\n"multi\nline",2\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "2"],
    ]);
  });

  it("detects tab and semicolon delimiters", () => {
    expect(parseDelimited("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseDelimited("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("rowsToMarkdownTable", () => {
  it("escapes pipes and flattens line breaks inside cells", () => {
    expect(rowsToMarkdownTable([["h|1", "h2"], ["a\nb"]])).toBe(
      "| h\\|1 | h2 |\n| --- | --- |\n| a b |   |",
    );
  });

  it("caps the rows it shows and says how many more there are", () => {
    const rows = Array.from({ length: FILE_PREVIEW_MAX_ROWS + 11 }, (_, i) => [String(i)]);
    const table = rowsToMarkdownTable(rows);
    expect(table.split("\n").filter((line) => line.startsWith("|"))).toHaveLength(
      FILE_PREVIEW_MAX_ROWS + 2,
    );
    expect(table).toContain("_… 10 more rows_");
  });

  it("titles sheets of a multi-sheet workbook", () => {
    expect(
      sheetsToMarkdown([
        { name: "One", rows: [["a"]] },
        { name: "Two", rows: [["b"]] },
        { name: "Empty", rows: [] },
      ]),
    ).toBe("### One\n\n| a |\n| --- |\n\n### Two\n\n| b |\n| --- |");
  });
});

describe("filePreviewMarkdown", () => {
  it("renders CSV as a table", () => {
    expect(filePreviewMarkdown(fileKindOf({ name: "t.csv" }), "name,age\nAnn,3\n")).toBe(
      "| name | age |\n| --- | --- |\n| Ann | 3 |",
    );
  });

  it("pretty-prints JSON in a json code block", () => {
    expect(filePreviewMarkdown(fileKindOf({ name: "d.json" }), '{"a":[1]}')).toBe(
      '```json\n{\n  "a": [\n    1\n  ]\n}\n```',
    );
  });

  it("puts source in a code block of its language, with a fence longer than any inside", () => {
    expect(filePreviewMarkdown(fileKindOf({ name: "x.py" }), "print('```')\n")).toBe(
      "````python\nprint('```')\n````",
    );
    expect(filePreviewMarkdown(fileKindOf({ name: "run.log" }), "ok")).toBe("```text\nok\n```");
  });

  it("keeps markdown as written and truncates very long files with a note", () => {
    expect(filePreviewMarkdown(fileKindOf({ name: "r.md" }), "# Hi")).toBe("# Hi");
    const long = filePreviewMarkdown(fileKindOf({ name: "r.md" }), "x".repeat(250_000));
    expect(long).toContain("preview truncated");
    expect(long.length).toBeLessThan(201_000);
  });

  it("decodes UTF-8 leniently and drops a BOM", () => {
    expect(decodeFileText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0xff]))).toBe("h\uFFFD");
  });
});

describe("hasInAppFileViewer", () => {
  it.each([
    ["report.pdf", "application/pdf", true],
    ["data.csv", "application/vnd.ms-excel", true],
    ["book.xlsx", "application/octet-stream", true],
    ["memo.docx", "", true],
    ["notes.md", "text/markdown", true],
    ["config.yaml", "application/octet-stream", true],
    ["page.html", "text/html", false],
    ["photo.png", "image/png", false],
    ["deck.pptx", "", false],
    ["legacy.doc", "application/msword", false],
    ["blob.bin", "application/octet-stream", false],
  ])("%s (%s) → %s", (name, mimeType, expected) => {
    expect(hasInAppFileViewer({ name, mimeType })).toBe(expected);
  });
});
