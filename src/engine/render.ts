/**
 * Render markdown into the canonical page representation (spec §3.3/§3.4/§5):
 * content lines with inline element markers, plus the element map.
 *
 * - Links `[text](href)` become `[{id}] text` inline at the anchor position.
 * - Buttons (emitted by extract.ts as `[btn] text` block lines) register as
 *   non-actionable button elements; the `[btn]` marker stays in the line.
 * - Element ids are integers assigned in document order, 1-based (spec §5
 *   renders the first link as `[1]`).
 * - The returned lines carry NO "lineno | " prefixes; numbering is applied
 *   when a window is formatted for output (session/window.ts). find matches
 *   against these raw content lines, markers included (spec §4.3).
 */

import type { PageElement } from "../types.js";

export interface RenderedMarkdown {
  lines: string[];
  elements: PageElement[];
}

const BUTTON_LINE = /^\[btn\]\s*(.*)$/;

interface ParsedInlineLink {
  /** Raw bracket text, e.g. the anchor text or image alt. */
  text: string;
  href: string;
  /** Index just past the closing ")". */
  end: number;
}

/** Find the index just past the closer matching s[openIdx], honoring escapes and nesting. */
function matchBracket(
  s: string,
  openIdx: number,
  open: string,
  close: string,
): number | null {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * Parse a markdown inline link starting at s[start] === "[".
 * Returns null when the bracket run is not an inline link.
 */
function parseInlineLink(s: string, start: number): ParsedInlineLink | null {
  const closeBracket = matchBracket(s, start, "[", "]");
  if (closeBracket === null || s[closeBracket + 1] !== "(") return null;
  const closeParen = matchBracket(s, closeBracket + 1, "(", ")");
  if (closeParen === null) return null;

  const text = s.slice(start + 1, closeBracket).trim();
  let href = s.slice(closeBracket + 2, closeParen).trim();
  // Tolerate an optional title: (href "title")
  const titleSplit = href.match(/^(\S+)\s+["'(].*$/s);
  if (titleSplit) href = titleSplit[1]!;
  if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1);
  if (href === "") return null;

  return { text, href, end: closeParen + 1 };
}

export function renderMarkdown(markdown: string): RenderedMarkdown {
  const rawLines = markdown.split("\n");
  const lines: string[] = [];
  const elements: PageElement[] = [];

  // Collapse runs of blank lines to a single blank line.
  let prevBlank = false;

  for (const raw of rawLines) {
    const line = raw.trimEnd();
    const blank = line.trim() === "";
    if (blank && prevBlank) continue;
    prevBlank = blank;

    const btn = BUTTON_LINE.exec(line.trim());
    if (btn) {
      elements.push({
        id: elements.length + 1,
        kind: "button",
        text: btn[1]?.trim() || "(button)",
      });
      lines.push(line.trim());
      continue;
    }

    let out = "";
    let i = 0;
    while (i < line.length) {
      const c = line[i]!;
      if (c === "\\" && i + 1 < line.length) {
        out += line.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "!" && line[i + 1] === "[") {
        const img = parseInlineLink(line, i + 1);
        if (img) {
          out += img.text; // images degrade to alt text
          i = img.end;
          continue;
        }
      }
      if (c === "[") {
        const link = parseInlineLink(line, i);
        if (link) {
          const id = elements.length + 1;
          const label = link.text || link.href;
          elements.push({ id, kind: "link", text: label, href: link.href });
          out += `[${id}] ${label}`;
          i = link.end;
          continue;
        }
      }
      out += c;
      i++;
    }
    lines.push(out);
  }

  return { lines, elements };
}
