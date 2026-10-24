/** Bundles viewers/*.ts into self-contained HTML pages, keyed by viewer name. */
export function buildViewerPages(): Promise<Record<string, string>>;
