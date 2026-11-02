import path from "node:path";
import { getLogger } from "@rakazo/logging";
import { normalizeWorkspacePath } from "./workspace-path-normalization.js";

/** One transfer's names, including parent directories, allocated in encounter order. */
export class PortableFileNames {
  readonly mapping = new Map<string, string>();
  private readonly segments = new Map<string, string>();
  private readonly used = new Map<string, Set<string>>();

  file<T extends { path: string }>(file: T): T {
    const safe = this.path(file.path);
    return safe === file.path ? file : { ...file, path: safe };
  }

  path(original: string): string {
    const known = this.mapping.get(original);
    if (known !== undefined) return known;
    // Validate before stripping characters so traversal cannot turn into an ordinary name.
    const relative = normalizeWorkspacePath(original);
    if (!relative) throw new Error("Workspace snapshots cannot contain an empty file path");
    let source = "";
    let parent = "";
    for (const segment of relative.split("/")) {
      source = source ? `${source}/${segment}` : segment;
      let safe = this.segments.get(source);
      if (safe === undefined) {
        const names = this.used.get(parent) ?? new Set<string>();
        const base = safeSegment(segment);
        safe = base;
        const extension = path.posix.extname(base);
        const stem = base.slice(0, base.length - extension.length);
        for (let index = 1; names.has(safe); index++) safe = `${stem}-${index}${extension}`;
        names.add(safe);
        this.used.set(parent, names);
        this.segments.set(source, safe);
      }
      parent = parent ? `${parent}/${safe}` : safe;
    }
    this.mapping.set(original, parent);
    if (parent !== relative) {
      getLogger().warn("renamed unsafe portable file path", {
        originalPath: escapedFilePath(original),
        path: escapedFilePath(parent),
      });
    }
    return parent;
  }
}

function safeSegment(segment: string): string {
  let safe = "";
  // Iteration keeps valid surrogate pairs (emoji and other non-BMP characters) intact.
  for (const character of segment) {
    const code = character.codePointAt(0)!;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      character === '"'
    )
      continue;
    safe += character;
  }
  return safe && safe !== "." && safe !== ".." ? safe : "unnamed";
}

/** JSON escapes C0 controls and lone surrogates; also escape DEL and C1 for log safety. */
export function escapedFilePath(value: string): string {
  return [...JSON.stringify(value)]
    .map((character) => {
      const code = character.codePointAt(0)!;
      return code >= 0x7f && code <= 0x9f ? `\\u${code.toString(16).padStart(4, "0")}` : character;
    })
    .join("");
}

/** Renames paths without buffering file contents, retaining collisions across upload batches. */
export async function* sanitizePortableFiles<T extends { path: string }>(
  files: AsyncIterable<T>,
): AsyncGenerator<T> {
  const names = new PortableFileNames();
  for await (const file of files) yield names.file(file);
}
