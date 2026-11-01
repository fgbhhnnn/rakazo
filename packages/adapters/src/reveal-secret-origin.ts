import type { BrowserSnapshotResult } from "@rakazo/adapter-kit";

/** Only browser-observed origins count; page text and model-supplied URLs are not evidence. */
export function pageHasSecretOrigin(page: BrowserSnapshotResult, savedOrigin: string): boolean {
  const origin = httpsOrigin(savedOrigin);
  const topOrigin = httpsOrigin(page.url);
  if (!origin || !topOrigin || page.error || page.fallback) return false;
  return topOrigin === origin || (page.frameOrigins?.includes(origin) ?? false);
}

function httpsOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
