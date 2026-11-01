/**
 * One registry of file kinds for every surface that shows a file (chat attachment cards, artifact
 * lists, the composer's pending chips, the in-app viewer) on web and mobile: which icon and colored
 * type badge it gets, and how the app can show it without handing it off to download/share.
 * Platform code maps `icon` to its own glyph set; everything else is shared.
 */

export type FileIcon =
  | "pdf"
  | "sheet"
  | "doc"
  | "slides"
  | "text"
  | "markdown"
  | "json"
  | "html"
  | "archive"
  | "code"
  | "audio"
  | "video"
  | "image"
  | "file";

/**
 * How the app shows a file in place:
 * - text: decoded as UTF-8 and rendered as markdown (`filePreviewMarkdown`): tables for CSV,
 *   highlighted code blocks for source, JSON and logs;
 * - pdf, spreadsheet, docx: rendered by a lazily loaded, offline viewer;
 * - html, image, audio, video: the surfaces' existing players and sandboxed viewers.
 */
export type FileViewer =
  | "text"
  | "pdf"
  | "spreadsheet"
  | "docx"
  | "html"
  | "image"
  | "audio"
  | "video";

export interface FileKind {
  icon: FileIcon;
  /** Short uppercase type badge, e.g. "PDF", "XLSX". */
  badge: string;
  /** Badge color (PDF red, Excel/CSV green, Word blue, PowerPoint orange…). */
  color: string;
  viewer: FileViewer | null;
  /** Code block language for text viewers (highlighting where the renderer supports it). */
  language?: string;
  /** Delimited table (CSV/TSV) rather than free text. */
  table?: boolean;
}

export const FILE_KIND_COLORS: Record<FileIcon, string> = {
  pdf: "#D93025",
  sheet: "#1E7145",
  doc: "#2B579A",
  slides: "#D24726",
  text: "#6B7280",
  markdown: "#0F766E",
  json: "#B45309",
  html: "#E34F26",
  archive: "#8D6E63",
  code: "#4F46E5",
  audio: "#DB2777",
  video: "#7C3AED",
  image: "#0891B2",
  file: "#6B7280",
};

type KindSpec = Omit<FileKind, "badge" | "color"> & { badge?: string };

const kind = (icon: FileIcon, viewer: FileViewer | null, extra: Partial<KindSpec> = {}) =>
  ({ icon, viewer, ...extra }) satisfies KindSpec;

const CODE_LANGUAGES: Record<string, string> = {
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  go: "go",
  rs: "rust",
  rb: "ruby",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "markup",
  css: "css",
  scss: "scss",
  r: "r",
  lua: "lua",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  diff: "diff",
  patch: "diff",
};

const BY_EXTENSION: Record<string, KindSpec> = {
  pdf: kind("pdf", "pdf"),
  csv: kind("sheet", "text", { table: true }),
  tsv: kind("sheet", "text", { table: true }),
  xlsx: kind("sheet", "spreadsheet"),
  xlsm: kind("sheet", "spreadsheet"),
  xls: kind("sheet", "spreadsheet"),
  ods: kind("sheet", "spreadsheet"),
  docx: kind("doc", "docx"),
  doc: kind("doc", null),
  odt: kind("doc", null),
  rtf: kind("doc", null),
  pptx: kind("slides", null),
  ppt: kind("slides", null),
  odp: kind("slides", null),
  key: kind("slides", null),
  md: kind("markdown", "text", { language: "markdown" }),
  markdown: kind("markdown", "text", { language: "markdown", badge: "MD" }),
  txt: kind("text", "text"),
  text: kind("text", "text", { badge: "TXT" }),
  log: kind("text", "text"),
  json: kind("json", "text", { language: "json" }),
  jsonl: kind("json", "text", { language: "json" }),
  html: kind("html", "html"),
  htm: kind("html", "html", { badge: "HTML" }),
  zip: kind("archive", null),
  gz: kind("archive", null),
  tgz: kind("archive", null),
  tar: kind("archive", null),
  "7z": kind("archive", null),
  rar: kind("archive", null),
  mp3: kind("audio", "audio"),
  wav: kind("audio", "audio"),
  m4a: kind("audio", "audio"),
  aac: kind("audio", "audio"),
  ogg: kind("audio", "audio"),
  flac: kind("audio", "audio"),
  opus: kind("audio", "audio"),
  mp4: kind("video", "video"),
  mov: kind("video", "video"),
  webm: kind("video", "video"),
  mkv: kind("video", "video"),
  avi: kind("video", "video"),
  png: kind("image", "image"),
  jpg: kind("image", "image"),
  jpeg: kind("image", "image", { badge: "JPG" }),
  gif: kind("image", "image"),
  webp: kind("image", "image"),
  svg: kind("image", "image"),
  heic: kind("image", "image"),
  bmp: kind("image", "image"),
  ...Object.fromEntries(
    Object.entries(CODE_LANGUAGES).map(([ext, language]) => [
      ext,
      kind("code", "text", { language }),
    ]),
  ),
};

/** Extension a MIME type stands for, when the file name has none we know. */
const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/rtf": "rtf",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/markdown": "md",
  "text/plain": "txt",
  "application/json": "json",
  "application/x-ndjson": "jsonl",
  "text/html": "html",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/gzip": "gz",
  "application/x-tar": "tar",
  "application/x-7z-compressed": "7z",
  "application/vnd.rar": "rar",
  "text/javascript": "js",
  "application/javascript": "js",
  "text/x-python": "py",
  "application/x-sh": "sh",
  "application/sql": "sql",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/yaml": "yaml",
  "text/yaml": "yaml",
  "text/css": "css",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/webm": "opus",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/heic": "heic",
};

const FAMILY: Array<[prefix: string, spec: KindSpec, badge: string]> = [
  ["audio/", kind("audio", "audio"), "AUDIO"],
  ["video/", kind("video", "video"), "VIDEO"],
  ["image/", kind("image", "image"), "IMAGE"],
  ["text/", kind("text", "text"), "TXT"],
];

function extensionOf(name: string | null | undefined): string | null {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
}

function resolve(spec: KindSpec, badge: string): FileKind {
  const { badge: fixed, ...rest } = spec;
  return { ...rest, badge: fixed ?? badge, color: FILE_KIND_COLORS[spec.icon] };
}

/**
 * The kind of a file from its name and MIME type. A known extension wins (uploads often arrive
 * as application/octet-stream), then the MIME type, then its family, then a generic file.
 */
export function fileKindOf(file: { name?: string | null; mimeType?: string | null }): FileKind {
  const mime = (file.mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  const fromName = extensionOf(file.name);
  const ext = fromName && BY_EXTENSION[fromName] ? fromName : MIME_EXTENSIONS[mime];
  if (ext && BY_EXTENSION[ext]) return resolve(BY_EXTENSION[ext], ext.toUpperCase());
  const family = FAMILY.find(([prefix]) => mime.startsWith(prefix));
  if (family) return resolve(family[1], family[2]);
  const badge = fromName && fromName.length <= 5 ? fromName.toUpperCase() : "FILE";
  return resolve(kind("file", null), badge);
}

/** Viewers both apps render in-app from the file's bytes (HTML, images and media have their own). */
const DOCUMENT_VIEWERS: ReadonlySet<FileViewer> = new Set(["text", "pdf", "spreadsheet", "docx"]);

/** Whether a file opens in the in-app document viewer rather than going to download/share. */
export function hasInAppFileViewer(file: {
  name?: string | null;
  mimeType?: string | null;
}): boolean {
  const { viewer } = fileKindOf(file);
  return viewer !== null && DOCUMENT_VIEWERS.has(viewer);
}

/** Longest preview the text viewers render; the full file stays one download/share away. */
export const FILE_PREVIEW_MAX_CHARS = 200_000;
/** Rows and columns a table preview shows. */
export const FILE_PREVIEW_MAX_ROWS = 500;
export const FILE_PREVIEW_MAX_COLUMNS = 50;
/** Above this size code is shown without highlighting, which is slow on long files. */
const HIGHLIGHT_MAX_CHARS = 60_000;

/** RFC 4180 rows: quoted fields may hold the delimiter, quotes ("") and line breaks. */
export function parseDelimited(
  text: string,
  delimiter = detectDelimiter(text),
  maxRows = Infinity,
) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if ((field !== "" || row.length > 0) && rows.length < maxRows) rows.push([...row, field]);
  return rows;
}

function detectDelimiter(text: string): string {
  const end = text.search(/\r?\n/);
  const head = text.slice(0, end === -1 ? 4096 : end);
  let best = ",";
  let bestCount = 0;
  for (const delimiter of [",", "\t", ";", "|"]) {
    const count = head.split(delimiter).length - 1;
    if (count > bestCount) [best, bestCount] = [delimiter, count];
  }
  return best;
}

const cell = (value: unknown) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n|\r/g, " ")
    .trim() || " ";

/** A GFM table of rows (first row is the header), capped, with a note when rows were cut. */
export function rowsToMarkdownTable(
  rows: readonly (readonly unknown[])[],
  totalRows = rows.length,
) {
  const shown = rows.slice(0, FILE_PREVIEW_MAX_ROWS + 1);
  const width = Math.min(FILE_PREVIEW_MAX_COLUMNS, Math.max(1, ...shown.map((row) => row.length)));
  const line = (row: readonly unknown[]) =>
    `| ${Array.from({ length: width }, (_, i) => cell(row[i])).join(" | ")} |`;
  const [header = [], ...body] = shown;
  const table = [line(header), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
  const hiddenRows = totalRows - shown.length;
  return hiddenRows > 0 ? `${table}\n\n_… ${hiddenRows} more rows_` : table;
}

/** Markdown for each sheet of a workbook (sheet rows as read by a spreadsheet library). */
export function sheetsToMarkdown(
  sheets: readonly { name: string; rows: readonly (readonly unknown[])[] }[],
) {
  const nonEmpty = sheets.filter((sheet) => sheet.rows.length > 0);
  if (nonEmpty.length === 0) return "_Empty workbook_";
  return nonEmpty
    .map((sheet) =>
      nonEmpty.length > 1 || sheet.name
        ? `### ${cell(sheet.name)}\n\n${rowsToMarkdownTable(sheet.rows)}`
        : rowsToMarkdownTable(sheet.rows),
    )
    .join("\n\n");
}

function fenced(text: string, language: string) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text.replace(/\n$/, "")}\n${fence}`;
}

/**
 * What the text viewer renders for a file's decoded text: markdown as written, CSV/TSV as a table,
 * JSON pretty-printed, and source, logs and plain text as a code block in the file's language.
 */
export function filePreviewMarkdown(kind: FileKind, text: string): string {
  const cut = text.length > FILE_PREVIEW_MAX_CHARS;
  const body = cut ? text.slice(0, FILE_PREVIEW_MAX_CHARS) : text;
  const note = cut ? "\n\n_… preview truncated; download the file for the rest_" : "";
  if (kind.table) {
    const delimiter = kind.badge === "TSV" ? "\t" : undefined;
    const rows = parseDelimited(body, delimiter);
    return `${rowsToMarkdownTable(rows)}${note}`;
  }
  if (kind.icon === "markdown") return `${body}${note}`;
  let source = body;
  if (kind.language === "json" && !cut) {
    try {
      source = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // JSON Lines or invalid JSON: shown as written.
    }
  }
  const language = source.length > HIGHLIGHT_MAX_CHARS ? "text" : (kind.language ?? "text");
  return `${fenced(source, language)}${note}`;
}

/** Decodes bytes for the text viewer; invalid sequences become U+FFFD rather than failing. */
export function decodeFileText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
}
