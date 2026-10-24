/** Bundled viewer pages (built from viewers/ by scripts/build-file-viewers.mjs), as Metro asset ids. */
export const DOCUMENT_VIEWER_MODULES = {
  pdf: require("../assets/viewers/pdf.html") as number,
  office: require("../assets/viewers/office.html") as number,
};
export type DocumentViewerAsset = keyof typeof DOCUMENT_VIEWER_MODULES;
