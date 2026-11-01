/**
 * Source code, config and log files attach as plain text under their own names. A worker's
 * report often lists a script it wrote (prime_sum_20000.py); without these the file was
 * skipped as an unsupported type while a .md in the same report was attached.
 */
export const SOURCE_TEXT_EXTENSIONS = [
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".sh",
  ".bash",
  ".sql",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".log",
  ".xml",
  ".css",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".java",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".r",
  ".tex",
] as const;
