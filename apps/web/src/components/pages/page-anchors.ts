import { pagePath } from "@rakazo/contracts";

/** DOM ids carry a prefix so a heading can never collide with the app's own element ids. */
export function pageAnchorId(sectionId: string): string {
  return `page-${sectionId}`;
}

/** The signed-in link to a page; it opens only for its owner, never publicly. */
export function pageLink(pageId: string, origin: string): string {
  return new URL(pagePath(pageId), origin).href;
}
