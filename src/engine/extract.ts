/**
 * Readability extraction: raw HTML → readable markdown (spec §5 pipeline).
 *
 * Links are emitted as standard markdown `[text](href)` and buttons as
 * `[btn] text` block lines; the render stage (render.ts) turns those into
 * inline `[{id}]` element markers plus the page element map.
 *
 * Throws EXTRACTION_FAILED when no readable content is found.
 */

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { GroundingError } from "../errors.js";

/**
 * Pages whose extracted text is shorter than this are treated as extraction
 * failures (spec §5: the JS-rendered fallback would trigger here once the
 * Playwright backend lands; see engine/jsrender.ts).
 */
export const MIN_EXTRACTED_TEXT_CHARS = 80;

export interface ExtractedContent {
  title: string;
  markdown: string;
  textLength: number;
}

function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
  });

  // Links: standard markdown, no title attribute (render.ts parses these).
  td.addRule("groundingLink", {
    filter: "a",
    replacement(content, node) {
      const href = (node as HTMLElement).getAttribute("href");
      const text = content.trim();
      if (!href) return text;
      const label = text || href;
      return `[${label}](${href})`;
    },
  });

  // Buttons: extractReadable rewrites <button> into <span data-alumni-button>
  // before Readability runs (Readability strips form controls). Emit the
  // block marker that render.ts recognizes. Display-only in v1 (spec §11).
  td.addRule("groundingButton", {
    filter: (node) =>
      node.nodeName === "SPAN" && (node as HTMLElement).hasAttribute("data-alumni-button"),
    replacement(content) {
      return `\n\n[btn] ${content.trim()}\n\n`;
    },
  });

  // Images: keep alt text only; grounding is text-oriented.
  td.addRule("groundingImage", {
    filter: "img",
    replacement(_content, node) {
      return (node as HTMLElement).getAttribute("alt")?.trim() ?? "";
    },
  });

  return td;
}

export function extractReadable(html: string, url: string): ExtractedContent {
  let doc;
  try {
    doc = new JSDOM(html, { url }).window.document;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new GroundingError(
      "EXTRACTION_FAILED",
      `Could not parse HTML from "${url}": ${msg}`,
    );
  }

  // Readability strips form controls (<button>, <input>, ...). Buttons must
  // stay visible (spec §11), so rewrite them as marked spans up front.
  for (const button of Array.from(doc.querySelectorAll("button"))) {
    const span = doc.createElement("span");
    span.setAttribute("data-alumni-button", "");
    span.textContent = button.textContent?.trim() || "(button)";
    button.replaceWith(span);
  }

  const article = new Readability(doc).parse();
  const textLength = article?.textContent?.trim().length ?? 0;
  if (!article || !article.content || textLength < MIN_EXTRACTED_TEXT_CHARS) {
    throw new GroundingError(
      "EXTRACTION_FAILED",
      `"${url}" yielded no readable content (${textLength} chars extracted; threshold ${MIN_EXTRACTED_TEXT_CHARS}). The page may be a paywall, an app shell, or require JS rendering.`,
    );
  }

  const markdown = makeTurndown()
    .turndown(article.content)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (markdown.length === 0) {
    throw new GroundingError(
      "EXTRACTION_FAILED",
      `"${url}" yielded no readable content after markdown conversion.`,
    );
  }

  return { title: article.title?.trim() || url, markdown, textLength };
}
