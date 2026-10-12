#!/usr/bin/env node
/**
 * End-to-end smoke test: drives the real MCP server (dist/index.js) over
 * stdio with the official SDK client. Run `npm run build` first.
 *
 *   node scripts/smoke.mjs
 *
 * A local fixture server provides deterministic pages, and the MCP server
 * runs with --allow-private-egress so it can fetch them (spec §8: private
 * egress is denied by default; loopback fixtures need the flag).
 *
 * Scenarios (per the spec):
 *   1. tools/list exposes the four tools
 *   2. open a URL -> a turn{N}fetch{idx} ref with numbered lines + markers
 *   3. find on that ref -> line-addressed matches
 *   4. open the same fetch ref with lineno -> SAME ref returned
 *   5. click a link element -> a fresh fetch ref
 *   6. click a button element -> ELEMENT_NOT_ACTIONABLE
 *   7. open file:///etc/passwd -> UNSUPPORTED_SCHEME
 *   8. search without BRAVE_API_KEY -> per-item BACKEND_ERROR with a hint
 */

import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let failures = 0;

function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

// --- Fixture pages ----------------------------------------------------------

const ARTICLE_HTML = `<!doctype html>
<html><head><title>Grounding Fixture Article</title></head>
<body><article>
<h1>Grounding Fixture Article</h1>
<p>This article exists so the smoke test has stable content to read.
It talks about grounding tools and line-windowed rendering.</p>
<p>The article links to an <a href="/about">About page</a> and to the
<a href="https://example.org/">Example organization</a> for more context.</p>
<p>A final paragraph with a <button>Subscribe now</button> control that
must be visible but not clickable in v1.</p>
</article></body></html>`;

const ABOUT_HTML = `<!doctype html>
<html><head><title>About the Fixture</title></head>
<body><article>
<h1>About the Fixture</h1>
<p>This is the target page of the article's first link. It exists so the
click scenario has somewhere deterministic to land.</p>
</article></body></html>`;

const fixture = createServer((req, res) => {
  const page = req.url === "/about" ? ABOUT_HTML : ARTICLE_HTML;
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${fixture.address().port}`;

// --- MCP client over stdio --------------------------------------------------

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js", "--allow-private-egress"],
  env: { ...process.env, BRAVE_API_KEY: "" }, // force the unconfigured-backend path
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

try {
  // 1. tools/list
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check("tools/list exposes search, open, find, click",
    JSON.stringify(names) === JSON.stringify(["click", "find", "open", "search"]),
    names.join(", "));

  // 2. open a URL
  const opened = parse(await client.callTool({
    name: "open",
    arguments: { targets: [{ url: `${base}/` }] },
  }));
  const page = opened.results[0];
  const ref = page.ref;
  const sessionId = opened.session_id;
  check("open URL mints a fetch ref", /^turn\d+fetch0$/.test(ref ?? ""), ref);
  check("open returns numbered lines with element markers",
    (page.lines ?? []).some((l) => /\d+ \| /.test(l)) &&
    (page.lines ?? []).some((l) => /\[\d+\]/.test(l)) &&
    (page.lines ?? []).some((l) => /\[btn\]/.test(l)),
    `window ${page.window?.start}–${page.window?.end} of ${page.window?.total}, ${page.elementCount} elements`);

  // 3. find on the fetch ref
  const found = parse(await client.callTool({
    name: "find",
    arguments: { session_id: sessionId, ref, pattern: "grounding" },
  }));
  check("find returns line-addressed matches (case-insensitive)",
    (found.totalMatches ?? 0) >= 1 && found.matches[0].lineno >= 1,
    `${found.totalMatches} match(es)`);

  // 4. reposition the window: same ref back
  const moved = parse(await client.callTool({
    name: "open",
    arguments: { session_id: sessionId, targets: [{ ref, lineno: 2 }] },
  }));
  check("open(fetch ref, lineno) returns the SAME ref", moved.results[0].ref === ref,
    moved.results[0].ref);

  // 5. click the first link element (the relative /about link)
  const clicked = parse(await client.callTool({
    name: "click",
    arguments: { session_id: sessionId, ref, id: 1 },
  }));
  check("click follows the link and mints a fresh fetch ref",
    clicked.ref !== undefined && clicked.ref !== ref &&
    (clicked.title ?? "").includes("About"),
    `${ref} -> ${clicked.ref ?? clicked.error?.code} (${clicked.title ?? clicked.error?.message})`);

  // 6. click the button element
  const btn = parse(await client.callTool({
    name: "click",
    arguments: { session_id: sessionId, ref, id: 3 },
  }));
  check("click on a button -> ELEMENT_NOT_ACTIONABLE",
    btn.error?.code === "ELEMENT_NOT_ACTIONABLE", btn.error?.code);

  // 7. unsupported scheme
  const file = parse(await client.callTool({
    name: "open",
    arguments: { targets: [{ url: "file:///etc/passwd" }] },
  }));
  check("file:// URL -> UNSUPPORTED_SCHEME",
    file.results[0].error?.code === "UNSUPPORTED_SCHEME");

  // 8. search with no backend configured
  const searched = parse(await client.callTool({
    name: "search",
    arguments: { queries: [{ q: "alumni grounding" }] },
  }));
  const item = searched.results[0];
  check("search without BRAVE_API_KEY -> per-item BACKEND_ERROR with hint",
    item.error?.code === "BACKEND_ERROR" &&
    typeof item.error?.hint === "string" && item.error.hint.length > 0);
} finally {
  await client.close();
  fixture.close();
}

console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
