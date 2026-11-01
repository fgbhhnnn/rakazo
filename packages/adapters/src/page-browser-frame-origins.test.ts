import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

it("reads structured frame origins from live isolated worlds using offline CDP doubles", () => {
  execFileSync(
    "python3",
    [
      fileURLToPath(
        new URL(
          "../../../infra/sandboxes/computer/test_page_browser_frame_origins.py",
          import.meta.url,
        ),
      ),
    ],
    { timeout: 10_000, stdio: "pipe" },
  );
});
