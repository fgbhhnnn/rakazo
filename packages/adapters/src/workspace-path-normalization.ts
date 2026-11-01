import path from "node:path";

export function normalizeWorkspacePath(value: string): string {
  const segments = value.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Path escapes the computer workspace");
  }
  return segments.join("/");
}

/** Map recognized roots to a virtual workspace path, including accidentally repeated roots. */
export function stripWorkspacePathRoots(value: string, roots: readonly string[]): string {
  let relative = normalizeWorkspacePath(value);
  const prefixes = roots
    .map(normalizeWorkspacePath)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (;;) {
    const prefix = prefixes.find((root) => relative === root || relative.startsWith(`${root}/`));
    if (!prefix) return relative;
    relative = relative.slice(prefix.length).replace(/^\/+/, "");
  }
}

/** Home aliases always resolve inside the workspace; they never grant access to the real home. */
export function workspacePath(root: string, requested: string): string {
  const roots = [root];
  if (/^\/home\/[^/]+\/rakazo-home\/?$/.test(root)) roots.push(path.posix.dirname(root));
  const relative = stripWorkspacePathRoots(requested, roots);
  return relative ? path.posix.join(root, relative) : root;
}

export function expandWorkspaceHomePrefix(value: string): string {
  const portable = value.replace(/\\/g, "/");
  const roots = ["~", "/home/rakazo", "/home/user/rakazo-home", "/home/user"];
  if (!roots.some((root) => portable === root || portable.startsWith(`${root}/`))) return value;
  const relative = stripWorkspacePathRoots(value, roots);
  // Preserve the existing Windows separator representation at this boundary.
  return `/${relative}`.replace(/\//g, value.startsWith("\\") ? "\\" : "/");
}
