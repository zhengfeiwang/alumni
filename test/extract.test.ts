import { describe, expect, it } from "vitest";
import { extractReadable } from "../src/engine/extract.js";
import { renderMarkdown } from "../src/engine/render.js";
import { GroundingError } from "../src/errors.js";

const PAGE = (body: string) =>
  `<!doctype html><html><head><title>T</title></head><body><article>${body}</article></body></html>`;

describe("extractReadable (spec §5 rule 5)", () => {
  it("extracts readable content as markdown with link syntax", () => {
    const html = PAGE(
      "<h1>Heading</h1><p>Enough readable text to pass the extraction threshold " +
        'comfortably, with a <a href="/x">link</a> inside it.</p>',
    );
    const r = extractReadable(html, "http://x/");
    expect(r.markdown).toContain("## Heading");
    expect(r.markdown).toContain("[link](http://x/x)"); // Readability absolutizes hrefs
  });

  it("keeps buttons visible as [btn] markers (Readability strips raw <button>)", () => {
    const html = PAGE(
      "<p>Enough readable text to pass the threshold for the extraction step.</p>" +
        "<p>A paragraph with a <button>Subscribe now</button> control.</p>",
    );
    const { lines, elements } = renderMarkdown(
      extractReadable(html, "http://x/").markdown,
    );
    expect(lines.some((l) => l.includes("[btn] Subscribe now"))).toBe(true);
    expect(elements.some((e) => e.kind === "button" && e.text === "Subscribe now")).toBe(true);
  });

  it("throws EXTRACTION_FAILED below the content threshold", () => {
    expect(() => extractReadable(PAGE("<p>Hi.</p>"), "http://x/")).toThrow(GroundingError);
    try {
      extractReadable(PAGE("<p>Hi.</p>"), "http://x/");
    } catch (err) {
      expect((err as GroundingError).code).toBe("EXTRACTION_FAILED");
    }
  });
});
