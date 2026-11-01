import { readFileSync } from "node:fs";

/** Keep the deferred native contracts tested without leaving their modules autolinked. */
export function readPendingAddition(file) {
  const patch = readFileSync(
    new URL("../native-pending/upstream-native.patch", import.meta.url),
    "utf8",
  );
  const path = `apps/mobile/${file}`;
  const section = patch.split(`diff --git a/${path} b/${path}\n`)[1]?.split("\ndiff --git ")[0];
  if (!section?.startsWith("new file mode 100644\n")) {
    throw new Error(`No deferred native addition: ${file}`);
  }
  return `${section
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n")}\n`;
}
