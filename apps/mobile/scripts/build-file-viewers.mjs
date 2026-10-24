// Builds the offline document viewers the app opens in a WebView (assets/viewers/*.html): one
// self-contained page per viewer with pdf.js / SheetJS / mammoth inlined. They ship as assets
// (OTA-updatable, JS only), so the libraries never enter the main JS bundle.
// Run: pnpm --filter @rakazo/mobile build:viewers
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const page = readFileSync(path.join(root, "viewers/page.html"), "utf8");

/** The viewer pages' HTML, keyed by asset name ("pdf", "office"). */
export async function buildViewerPages() {
  const pages = {};
  for (const name of ["pdf", "office"]) {
    const result = await build({
      entryPoints: [path.join(root, "viewers", `${name}.ts`)],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      // pdf.js's legacy build is already compiled for older WebViews; nothing is lowered further.
      target: "esnext",
      minify: true,
      legalComments: "none",
      // Escapes "</script" inside the code so it can sit in an inline <script>.
      supported: { "inline-script": false },
      // Node-only branches of the libraries, never taken in a browser.
      external: [
        "fs",
        "path",
        "url",
        "module",
        "canvas",
        "zlib",
        "stream",
        "crypto",
        "http",
        "https",
      ],
      logLevel: "warning",
    });
    const code = result.outputFiles[0].text;
    pages[name] = page.replace("/*VIEWER*/", () => code);
  }
  return pages;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, html] of Object.entries(await buildViewerPages())) {
    writeFileSync(path.join(root, "assets/viewers", `${name}.html`), html);
    console.log(`assets/viewers/${name}.html ${(html.length / 1024).toFixed(0)} KiB`);
  }
}
