import { Asset } from "expo-asset";
import { File } from "expo-file-system";

import { DOCUMENT_VIEWER_MODULES, type DocumentViewerAsset } from "./document-viewer-modules";

const pages = new Map<DocumentViewerAsset, Promise<string>>();

/** The viewer page's HTML, read once from the app bundle (or OTA update) and kept in memory. */
export function documentViewerHtml(asset: DocumentViewerAsset): Promise<string> {
  let page = pages.get(asset);
  if (!page) {
    page = (async () => {
      const resolved = await Asset.fromModule(DOCUMENT_VIEWER_MODULES[asset]).downloadAsync();
      if (!resolved.localUri) throw new Error("Viewer asset unavailable");
      return new File(resolved.localUri).text();
    })();
    pages.set(asset, page);
    void page.catch(() => pages.delete(asset));
  }
  return page;
}
