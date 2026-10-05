# Alumni Grounding — Tool Contract Specification

**Version:** v0.1 (draft)
**Status:** Design proposal — pre-implementation
**Scope:** Grounding only (web navigation tools). Sandbox execution is explicitly out of scope for this milestone.

---

## 1. Context & Goals

Alumni is an open-source project that gives LLM agents minimal, well-disciplined capabilities. Its first component, **Alumni Grounding**, is a web navigation tool surface inspired by OpenAI's ChatGPT browsing tools — the `web.run` tool contract as observed in the o3 system prompt — redesigned clean-room for the Model Context Protocol (MCP) ecosystem.

Alumni Grounding is designed from public concepts and observed interface behavior only. No proprietary implementation details are used.

**Terminology.** Alumni is the project as a whole; Alumni Grounding is the component specified here — the MCP server exposing the web navigation tools. Below, "Alumni Grounding" and "the server" are used interchangeably. Later components (e.g. sandbox execution) are separate milestones and out of scope for this document.

### Goals

- Give an LLM agent a complete read-oriented web loop: **search → open → find → click → read**, with no host-side execution environment required.
- Make every retrieved artifact addressable through stable **source reference IDs**, so the model never transcribes raw URLs and can cite sources reliably.
- Keep page content token-efficient through **line-windowed rendering**.
- Support **batched operations** to minimize round trips.
- Remain host-agnostic: any MCP client (Claude, custom agents, or other MCP-capable hosts) can integrate.

### Non-goals (v1)

- Sandbox / arbitrary code execution (planned for a later milestone; grounding must stand alone).
- Write interactions: form filling, button clicking, JS-driven page interaction (see §11, Known Limitations).
- Rich host-rendered widgets (finance charts, weather cards, image carousels).
- Multi-user tenancy, authentication, or hosted deployment. v1 runs as a local MCP server process.
- Host-side behavioral policy (when to browse, how much to cite). Alumni Grounding ships tool contracts; usage policy belongs to the host's system prompt.

### Relationship to reference contracts

| Concept | OpenAI `web.run` (o3) | Alumni Grounding |
|---|---|---|
| Tool shape | Single tool, command union | Four separate MCP tools (idiomatic MCP) |
| Batching | Multiple commands per call | Array parameters in `search` / `open` |
| Source identity | `turn{N}{type}{idx}` ref IDs | Same format, adopted wholesale; scoped to the MCP session (§3.2) |
| Page addressing | `ref_id` + `lineno` | Same, adopted wholesale |
| Element addressing | `click(ref_id, id)` | Same: page-scoped integer element IDs |
| Citations | Ref-ID-based, URLs forbidden in output | Same contract, enforced via tool descriptions |

---

## 2. Architecture

```
┌──────────────────────────────────────────────┐
│  Transport: MCP server (stdio; HTTP optional) │  ← thin, replaceable
├──────────────────────────────────────────────┤
│  Session manager                              │  ← sessions, ref registry, page cache
├──────────────────────────────────────────────┤
│  Core engine                                  │  ← fetch, extract, render, search backends
└──────────────────────────────────────────────┘
```

- **Core engine** — stateless-ish primitives: `fetch(url) → raw`, `extract(raw) → readable markdown`, `render(markdown) → numbered lines + element map`, `query(q) → results`. Pure and independently testable.
- **Session manager** — owns all state: sessions, the source reference registry, page instances, the URL cache, TTL eviction.
- **Transport** — a projection of the session manager onto MCP. stdio first (zero-deploy); Streamable HTTP from day one since it is nearly free with official SDKs. No business logic lives here.

**Language:** TypeScript (first-party MCP SDK, first-class Playwright for JS rendering).

---

## 3. Core Concepts

### 3.1 Session

A session is the unit of state. All four tools accept a `session_id`; when it is omitted, the server creates a session implicitly and returns its id in every response.

```typescript
interface Session {
  id: string;
  createdAt: Date;
  lastActiveAt: Date;          // TTL eviction key
  turn: number;                // ref-issuing call counter, 0-based
  history: PageRef[];          // internal breadcrumb stack (future back())
  refs: RefRegistry;           // all refs issued in this session
}
```

- Default TTL: 30 minutes idle, sliding. Evicted sessions return `SESSION_EXPIRED` (§9).
- Sessions are independent; no state crosses session boundaries except the shared URL cache (§7.2).

### 3.2 Source Reference IDs

Every artifact returned to the model carries a ref ID. Refs are the **only** way the model addresses prior results. The format is adopted from the o3 `web.run` contract: `turn{N}{type}{idx}`.

| Ref | Artifact | Issued by | Resolvable by |
|---|---|---|---|
| `turn{N}search{idx}` | A single search result | `search` | `open` |
| `turn{N}fetch{idx}` | A fetched page instance | `open`, `click` | `open`, `find`, `click` |

Where:

- `N` — the session's turn counter, incremented once per ref-issuing tool call (`search`, `open`, `click`). `find` issues no refs and does not advance the counter. 0-based. Unlike o3, where `N` is the host's conversation turn, the server's counter is internal to the MCP session; the host never sets it.
- `{idx}` — index within the turn and type, 0-based. A batched `open` of three URL targets in one call mints `turn4fetch0`, `turn4fetch1`, `turn4fetch2`.

Properties:

- Monotonic per session via the turn counter. Never reused within a session.
- **Fetch refs identify a page instance, not a URL.** Re-fetching the same URL mints a new `turn{N}fetch{idx}`. Element IDs and line numbers are only valid against the specific instance that issued them.
- Refs expire with their session; resolving an unknown ref returns `REF_NOT_FOUND`.

### 3.3 Page

The canonical rendered representation of a fetched URL: extracted readable content as **numbered lines**, plus an element map.

```typescript
interface Page {
  ref: string;                 // "turn2fetch0"
  url: string;                 // requested
  finalUrl: string;            // after redirects
  title: string;
  fetchedAt: Date;
  renderMode: "static" | "js"; // whether headless rendering was needed
  lines: string[];             // full line-numbered content (server-side)
  totalLines: number;
  elements: Element[];         // actionable items, document order
}

interface Element {
  id: number;                  // 17 — valid ONLY within this Page.ref
  kind: "link" | "button";     // buttons are visible but not clickable in v1
  text: string;                // anchor text
  href?: string;               // raw href, resolved lazily at click time
}
```

**Line-addressability is a hard contract.** Extraction produces markdown; markdown is split into numbered lines; all windows, `find` results, and `lineno` jumps speak line numbers. This closes the loop: `open` shows a window → `find` returns line numbers → `open(lineno)` jumps to the region.

### 3.4 Element IDs

Integer IDs assigned per page instance, in document order, rendered inline in the page view (e.g., `[12]` preceding link text). Scoping rules:

- `click` validates that `id` belongs to the referenced page instance.
- Page instances never supersede. Re-fetching a URL mints a new instance, but prior instances remain valid until session expiry, and `click` always resolves against the issuing instance's own element map. Stale navigation is impossible by construction, not by error handling.

---

## 4. Tool Contract

Common conventions:

- All tools take `session_id?: string`. All responses include `session_id`. For `find` and `click`, omitting `session_id` creates a fresh session that contains no refs, so the call can only yield `REF_NOT_FOUND` — hosts should treat `session_id` as effectively required for these two tools.
- Array parameters express batching. Items within one call are independent: one failing item does not fail the batch; each result carries its own `error` field if applicable.
- Optional parameters are omitted, never null.
- All tool responses are JSON. Content-bearing responses are line-windowed (§5).

### 4.1 `search`

Query a search backend; results are registered as `turn{N}search{idx}` refs.

**Input**

```typescript
{
  session_id?: string,
  queries: [{
    q: string,                              // required
    recency?: "day" | "week" | "month",     // freshness filter
    domains?: string[]                      // restrict to domains
  }]                                        // max 5 per call
}
```

**Output**

```typescript
{
  session_id: string,
  results: [{                               // grouped per query, in order
    q: string,
    items: [{
      ref: string,                          // "turn0search2"
      title: string,
      url: string,
      snippet: string,                      // ≤ ~300 chars
      publishedAt?: string                  // ISO 8601, when known
    }],
    error?: ToolError
  }]
}
```

Notes:

- Default backend: pluggable `SearchBackend` interface; SearXNG (self-hosted) or Brave Search API ship as defaults.
- Snippets are capped; `search` is for discovery, not reading. Reading requires `open`.
- The `recency` enum is deliberately coarse. Both default backends support these filters directly. Absolute date ranges are deferred.

### 4.2 `open`

Fetch and render a page. Polymorphic target: a prior ref **or** a raw URL. Mints a `turn{N}fetch{idx}` ref for URL and `search`-ref targets; repositioning a `fetch` ref returns the same ref (see notes).

**Input**

```typescript
{
  session_id?: string,
  targets: [{
    ref?: string,          // "turn0search1" or "turn3fetch0" — takes precedence over url
    url?: string,          // raw URL; used iff ref absent
    lineno?: number        // start window at this line (1-based)
  }]                       // max 3 per call
}
```

**Output** (per target)

```typescript
{
  ref: string,             // "turn2fetch0" — minted fresh for search-ref/URL targets;
                           // unchanged when repositioning an existing fetch ref
  url: string,
  finalUrl: string,
  title: string,
  fetchedAt: string,
  renderMode: "static" | "js",
  window: { start: number, end: number, total: number },
  lines: string[],         // "214 | The committee ..." — numbered, windowed
  elementCount: number,
  hint?: string,           // e.g. "480 lines total; use find to locate content" — present when useful
  error?: ToolError
}
```

Notes:

- **Exactly one of `ref` / `url`** must be present; both or neither → `INVALID_ARGS`. `ref` accepts `search` or `fetch` refs; anything else → `INVALID_REF_TYPE`.
- Opening a `fetch` ref re-renders that same instance (no re-fetch) and returns the **same** ref, even when `lineno` repositions the window — window moves never mint a new ref, so element IDs stay valid across jumps. New refs are minted only when opening a `search` ref or a raw URL.
- `lineno` is 1-based; a value beyond `totalLines` clamps to the final window and the response `hint` notes the clamp.
- Default window: first ~200 lines or ~4,000 tokens, whichever is smaller.
- Re-opening the same URL within cache TTL reuses fetched content but mints a fresh `turn{N}fetch{idx}` (element IDs regenerate; old page ref remains valid until session expiry).

### 4.3 `find`

Locate a pattern within a fetched page; return line numbers with context.

**Input**

```typescript
{
  session_id?: string,
  ref: string,                  // a fetch ref — required
  pattern: string,              // required
  mode?: "literal"              // v1: literal only. v1.1: + "regex". v2: + "semantic"
}
```

**Output**

```typescript
{
  session_id: string,
  ref: string,
  totalMatches: number,
  matches: [{                   // capped at 10
    lineno: number,             // primary match line
    context: string[]           // numbered lines, ±3 around the match
  }],
  hint?: string                 // e.g. "12 more matches; narrow the pattern"
}
```

Notes:

- Literal matching is **case-insensitive by default** (models are sloppy about capitalization; spurious "not found" is worse than loose matching).
- Matching runs against the content of rendered lines — the text after the `lineno | ` prefix, including inline `[{id}]` element markers — so patterns can target link anchor text as displayed.
- `totalMatches` is always exact even when `matches` is truncated, so the model can decide to narrow.
- `find` on a `search` ref → `INVALID_REF_TYPE`.

### 4.4 `click`

Follow a link element from a fetched page. Semantically equivalent to `open` of the element's resolved href; returns the same shape as `open` (a fresh `turn{N}fetch{idx}`).

**Input**

```typescript
{
  session_id?: string,
  ref: string,        // the fetch ref of the page that issued the element
  id: number          // element ID within that page
}
```

Notes:

- `click` always navigates. v1 extracts links only; buttons appear in the rendered view marked non-actionable (`[btn]` prefix) and clicking one returns `ELEMENT_NOT_ACTIONABLE`.
- Relative hrefs resolve against the page's `finalUrl`, not the requested URL.
- The source page ref is pushed onto session history (internal; enables a future `back` with no contract change).

---

## 5. Page Rendering Format

The rendered view is what the model actually reads. Format stability matters as much as the JSON schema.

```
# {title}
URL: {finalUrl}
Fetched: {fetchedAt} · {renderMode} · lines {window.start}–{window.end} of {total}

1 | # Example Domain
2 | 
3 | This domain is for use in illustrative examples [1] in documents.
4 | You may use this domain in literature without prior coordination.
5 | 
6 | [2] More information...
```

Rules:

1. **Every line is numbered**, `lineno | content`. Numbers are absolute (window line 214 is `214 |`), so `find` results and `open(lineno)` compose.
2. Links render as `[{element_id}]` inline at their anchor text position. Buttons render as `[btn]` (non-actionable marker).
3. Boilerplate (nav, cookie banners, footers) is removed at extraction time, not by the model.
4. Windows end with a continuation hint: `— lines 201–480 not shown; open(ref, lineno=201) or use find —`.
5. Extraction pipeline: fetch → readability extraction → markdown → line split. JS-rendered fallback (Playwright) triggers when static extraction yields below a content threshold.

---

## 6. Citation Contract

An MCP server cannot enforce host behavior, but the contract is designed to make correct attribution the path of least resistance:

- Every `search` item and every `open`/`click` page carries its `ref` in the response payload.
- Tool descriptions instruct the model: *cite sources using their ref IDs; never reproduce raw URLs in user-facing text; place citations adjacent to the claims they support.*
- A companion host-prompt snippet (`docs/host-prompt-snippet.md`) restates this for hosts that support system-prompt configuration.

---

## 7. State & Cache Semantics

### 7.1 Session lifecycle

- Created implicitly on any call without a `session_id`; returned in the response.
- Sliding TTL: 30 min idle. Eviction removes all refs, pages, and history for the session.
- Sessions live in memory only. A server restart ends all sessions; persistent storage is intentionally excluded from v1.

### 7.2 URL cache

- `finalUrl → { fetched content, extracted lines, fetchedAt }`, TTL ~10 minutes.
- Shared across sessions (content only — refs and element IDs are always per-session).
- Cache hit still mints a new page ref and new element IDs.

### 7.3 Staleness

- Element IDs and line numbers are valid only against the issuing page instance. Page instances never become stale: a re-fetched URL is a new instance, and older instances keep working until session expiry.
- Operations on evicted sessions → `SESSION_EXPIRED`; unknown refs → `REF_NOT_FOUND`. All include a next-action hint (§9).

---

## 8. Security & Fetch Policy

Fetched content is untrusted input to the model, and a local MCP server fetching arbitrary URLs on the model's behalf is an SSRF primitive. v1 policy:

- **Scheme allowlist.** Only `http` and `https` are fetchable. Any other scheme (`file:`, `ftp:`, `javascript:`, `data:`, …) in an `open` URL or a clicked href → `UNSUPPORTED_SCHEME`.
- **Private-network egress.** By default the server refuses to fetch loopback, RFC-1918, and link-local addresses (including `169.254.169.254`), checked after every redirect hop, not just against the initial URL. A `--allow-private-egress` server flag disables this for development use.
- **Fetch limits.** At most 10 redirects, 15 s total fetch timeout, 10 MB response cap. Violations surface as `FETCH_FAILED` with the specific reason in `message`.
- **Untrusted content.** Page text is data, not instructions. Tool descriptions and the companion host-prompt snippet (§6) state that fetched content may contain adversarial instructions that the agent must not act on.

---

## 9. Error Model

Errors are structured **and** model-actionable: every error carries a `hint` telling the agent what to do next. An agent that reads hints can self-recover without host intervention.

```typescript
interface ToolError {
  code: ErrorCode;
  message: string;     // human/model-readable
  hint: string;        // prescribed recovery action
}

type ErrorCode =
  | "INVALID_ARGS"          // e.g. both ref and url, or neither
  | "SESSION_EXPIRED"       // hint: omit session_id to start fresh
  | "REF_NOT_FOUND"         // hint: re-run search or open
  | "INVALID_REF_TYPE"      // e.g. find on a search ref
  | "UNSUPPORTED_SCHEME"    // non-http(s) URL or clicked href (§8)
  | "ELEMENT_NOT_FOUND"     // id not in this page's element map
  | "ELEMENT_NOT_ACTIONABLE"// button in v1
  | "FETCH_FAILED"          // network/HTTP error, or fetch-limit violation (§8); includes status
  | "EXTRACTION_FAILED"     // page yielded no readable content
  | "RATE_LIMITED"          // search backend quota exhausted; hint: back off or narrow batches
  | "BACKEND_ERROR";        // search backend failure
```

Batch calls never fail wholesale: per-item `error` fields.

---

## 10. Versioning Policy

- **Version parameters, not tools.** New `find` modes, new `search` filters arrive as additive optional parameters. Tool names and required parameters are frozen within a major version.
- Enum extension is minor-version (`mode: "regex"` in v1.1) — except when an extension changes result determinism, which is a major-version behavioral change. Hence `mode: "semantic"` is deferred to v2 deliberately: non-deterministic results are hard for agents to reason about, and query reformulation covers most of its value.
- The four-tool surface is frozen for v1.x. Candidate v2 additions (`back`, `screenshot`, `submit_form`) require an RFC in the repo first.
- Deferred candidates for v1.1: line-addressable `search` snippets (jump straight to the snippet's location on first `open`) and per-session fetch-rate limits (§11).

---

## 11. Known Limitations (v1)

- **Read-oriented web only.** Content behind JS interaction (click-to-reveal, infinite scroll) is partially reachable via the JS-rendered fallback, but interactions themselves are out of scope.
- **Buttons are display-only.** Shown as `[btn]`, not clickable. Keeps `click` semantics crisp: click always = navigation.
- **No auth-walled content.** No cookie/session persistence across fetches.
- **No client-side rate limiting.** A misbehaving model can fetch in a tight loop. Per-session fetch budgets are a candidate for v1.1; until then, hosts that need protection must throttle tool calls themselves.
- **Extraction quality is the binding constraint.** Paywalls, aggressive anti-bot, and non-article pages (SPAs, web apps) will degrade gracefully via `EXTRACTION_FAILED` rather than return garbage.

---

## Appendix A. Reference: o3 `web.run` command mapping

| o3 command | Alumni Grounding equivalent | Notes |
|---|---|---|
| `search_query[{q, recency, domains}]` | `search` | `recency` becomes an enum; absolute dates deferred |
| `open[{ref_id \| url, lineno}]` | `open` | Same semantics; window moves on a `fetch` ref return the same ref (§4.2) |
| `find[{ref_id, pattern}]` | `find` | v1 literal-only; o3's pattern semantics appear literal |
| `click[{ref_id, id}]` | `click` | Identical semantics, adopted as-is |
| `image_query`, `finance`, `weather`, `sports`, `calculator`, `time` | — | Host-widget concerns; out of scope |
| Citation rules (ref-based, no raw URLs) | §6 | Enforced via tool descriptions + host snippet |
| `response_length` param | — | Replaced by deterministic windowing (§5) |
