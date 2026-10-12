import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/engine/render.js";

describe("renderMarkdown (spec §3.4/§5)", () => {
  it("assigns element ids in document order, 1-based", () => {
    const { lines, elements } = renderMarkdown(
      "Intro [Alpha](https://a.example) text.\nMore [Beta](/b) here.",
    );
    expect(elements.map((e) => [e.id, e.kind, e.text, e.href])).toEqual([
      [1, "link", "Alpha", "https://a.example"],
      [2, "link", "Beta", "/b"],
    ]);
    expect(lines[0]).toBe("Intro [1] Alpha text.");
    expect(lines[1]).toBe("More [2] Beta here.");
  });

  it("registers buttons as non-actionable with [btn] markers kept inline", () => {
    const { lines, elements } = renderMarkdown("[btn] Submit\n\n[Next](/next)");
    expect(lines[0]).toBe("[btn] Submit");
    expect(elements[0]).toMatchObject({ id: 1, kind: "button", text: "Submit" });
    expect(elements[1]).toMatchObject({ id: 2, kind: "link", text: "Next" });
  });

  it("collapses runs of blank lines", () => {
    const { lines } = renderMarkdown("a\n\n\n\n\nb");
    expect(lines).toEqual(["a", "", "b"]);
  });

  it("degrades images to alt text and registers no element", () => {
    const { lines, elements } = renderMarkdown("before ![logo](img.png) after");
    expect(lines[0]).toBe("before logo after");
    expect(elements).toEqual([]);
  });

  it("uses the href as label when anchor text is empty", () => {
    const { elements } = renderMarkdown("[](https://bare.example)");
    expect(elements[0]).toMatchObject({ id: 1, text: "https://bare.example" });
  });
});
