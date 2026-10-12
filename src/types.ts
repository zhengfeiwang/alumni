/**
 * Shared domain types per spec §3 (Session, Page, Element, refs).
 */

import type { ToolError } from "./errors.js";

export type RenderMode = "static" | "js";

/** A page element as stored on a page instance (spec §3.3). */
export interface PageElement {
  id: number; // valid ONLY within the issuing Page.ref
  kind: "link" | "button"; // buttons are visible but not clickable in v1
  text: string; // anchor text
  href?: string; // raw href, resolved lazily at click time
}

/** Rendered page content: numbered-line source of truth plus element map. */
export interface PageContent {
  finalUrl: string;
  title: string;
  lines: string[]; // content lines WITHOUT "lineno | " prefixes; markers inline
  elements: PageElement[];
  fetchedAt: Date;
  renderMode: RenderMode;
}

/** A fetched page instance (spec §3.3). Instances never supersede. */
export interface Page {
  ref: string; // "turn2fetch0"
  url: string; // requested
  finalUrl: string; // after redirects
  title: string;
  fetchedAt: Date;
  renderMode: RenderMode;
  lines: string[];
  totalLines: number;
  elements: PageElement[];
}

export interface SearchResultItem {
  ref: string; // "turn0search2"
  title: string;
  url: string;
  snippet: string; // <= ~300 chars
  publishedAt?: string; // ISO 8601
}

/** Stored value of a search ref: everything open() needs to fetch it later. */
export interface SearchRefRecord {
  kind: "search";
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface FetchRefRecord {
  kind: "fetch";
  page: Page;
}

export type RefRecord = SearchRefRecord | FetchRefRecord;

export interface Session {
  id: string;
  createdAt: Date;
  lastActiveAt: Date; // TTL eviction key
  turn: number; // ref-issuing call counter, 0-based
  history: string[]; // source page refs pushed by click (future back())
  refs: Map<string, RefRecord>;
}

/** Shared URL cache entry (spec §7.2): content only, keyed by finalUrl. */
export interface CacheEntry {
  finalUrl: string;
  title: string;
  lines: string[];
  elements: PageElement[];
  fetchedAt: Date;
  renderMode: RenderMode;
  cachedAt: number; // ms epoch, for TTL
}

// ---- Tool result shapes (spec §4) ----

export interface SearchToolResult {
  session_id: string;
  results: Array<{
    q: string;
    items: SearchResultItem[];
    error?: ToolError;
  }>;
}

export interface WindowSpec {
  start: number;
  end: number;
  total: number;
}

export interface OpenTargetResult {
  ref?: string;
  url?: string;
  finalUrl?: string;
  title?: string;
  fetchedAt?: string;
  renderMode?: RenderMode;
  window?: WindowSpec;
  lines?: string[]; // "214 | The committee ..." — numbered, windowed
  elementCount?: number;
  hint?: string;
  error?: ToolError;
}

export interface OpenToolResult {
  session_id: string;
  results: OpenTargetResult[];
}

export interface FindToolResult {
  session_id: string;
  ref?: string;
  totalMatches?: number;
  matches?: Array<{
    lineno: number;
    context: string[]; // numbered lines, +/-3 around the match
  }>;
  hint?: string;
  error?: ToolError;
}

/** click returns the same shape as a single open result (spec §4.4). */
export type ClickToolResult = OpenTargetResult & { session_id: string };
