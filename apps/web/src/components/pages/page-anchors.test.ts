import { describe, expect, it } from "vitest";
import { pageAnchorId, pageLink } from "./page-anchors";

describe("page anchors", () => {
  it("links to the signed-in page route on this origin", () => {
    expect(pageLink("page-1", "https://app.example.test")).toBe(
      "https://app.example.test/app/pages/page-1",
    );
  });

  it("prefixes section ids so headings cannot clash with app ids", () => {
    expect(pageAnchorId("root")).toBe("page-root");
  });
});
