/**
 * Session manager (spec §3, §7): owns all state — sessions, the source
 * reference registry, page instances, the shared URL cache, TTL eviction.
 * No transport or MCP concerns live here.
 *
 * Turn counter (spec §3.2): each ref-issuing tool call (search/open/click)
 * uses the session's current turn number N for every ref it mints, then
 * increments the counter exactly once — even if some or all items in the
 * call fail. find never issues refs and never advances the counter.
 */

import { randomUUID } from "node:crypto";
import {
  asToolError,
  GroundingError,
  invalidArgs,
  invalidRefType,
  refNotFound,
  sessionExpired,
  unsupportedScheme,
} from "../errors.js";
import type { SearchBackend, SearchQuery } from "../search/backend.js";
import type {
  CacheEntry,
  ClickToolResult,
  FindToolResult,
  OpenTargetResult,
  Page,
  PageContent,
  PageElement,
  RefRecord,
  SearchResultItem,
  SearchToolResult,
  Session,
} from "../types.js";
import { formatRef } from "./refs.js";
import {
  computeWindow,
  formatPageView,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_TOKENS,
} from "./window.js";

/** Injectable page pipeline (engine/pipeline.ts loadPage by default). */
export type PageLoader = (url: string) => Promise<PageContent>;

export interface SessionManagerOptions {
  sessionTtlMs?: number; // default 30 min, sliding
  cacheTtlMs?: number; // default 10 min
  now?: () => number; // injectable clock (tests)
  sweepIntervalMs?: number | false; // default 60 s; false disables the timer
  loadPage?: PageLoader; // injectable pipeline (tests)
  searchBackend?: SearchBackend;
  windowMaxLines?: number;
  windowMaxTokens?: number;
}

const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
const SNIPPET_MAX_CHARS = 300;
export const MAX_SEARCH_QUERIES = 5;
export const MAX_OPEN_TARGETS = 3;
const FIND_MAX_MATCHES = 10;
const FIND_CONTEXT_LINES = 3;

export interface OpenTargetInput {
  ref?: string | undefined;
  url?: string | undefined;
  lineno?: number | undefined;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly sessionTtlMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly loadPage: PageLoader;
  private readonly backend?: SearchBackend;
  private readonly maxLines: number;
  private readonly maxTokens: number;
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(opts: SessionManagerOptions = {}) {
    this.sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
    if (!opts.loadPage) {
      throw new Error("SessionManager requires a loadPage pipeline");
    }
    this.loadPage = opts.loadPage;
    if (opts.searchBackend !== undefined) this.backend = opts.searchBackend;
    this.maxLines = opts.windowMaxLines ?? DEFAULT_MAX_LINES;
    this.maxTokens = opts.windowMaxTokens ?? DEFAULT_MAX_TOKENS;

    const interval = opts.sweepIntervalMs ?? 60_000;
    if (interval !== false) {
      this.sweeper = setInterval(() => this.sweep(), interval);
      this.sweeper.unref?.();
    }
  }

  close(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /** Evict expired sessions and stale cache entries. */
  sweep(): void {
    const now = this.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastActiveAt.getTime() > this.sessionTtlMs) {
        this.sessions.delete(id);
      }
    }
    for (const [url, entry] of this.cache) {
      if (now - entry.cachedAt > this.cacheTtlMs) {
        this.cache.delete(url);
      }
    }
  }

  /** Visible for tests. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Resolve the session for a call: create implicitly when session_id is
   * omitted; touch the sliding TTL on use. A provided-but-unknown id is
   * treated as expired (spec §7.3).
   */
  resolveSession(sessionId?: string): Session {
    if (sessionId === undefined) {
      return this.createSession();
    }
    this.sweep();
    const s = this.sessions.get(sessionId);
    if (!s) throw sessionExpired(sessionId);
    s.lastActiveAt = new Date(this.now());
    return s;
  }

  private createSession(): Session {
    const session: Session = {
      id: randomUUID(),
      createdAt: new Date(this.now()),
      lastActiveAt: new Date(this.now()),
      turn: 0,
      history: [],
      refs: new Map(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  // -------------------------------------------------------------------------
  // search (spec §4.1)
  // -------------------------------------------------------------------------

  async search(
    sessionId: string | undefined,
    queries: SearchQuery[],
  ): Promise<SearchToolResult> {
    let session: Session;
    try {
      session = this.resolveSession(sessionId);
    } catch (err) {
      return {
        session_id: sessionId ?? "",
        results: queries.map((q) => ({ q: q.q, items: [], error: asToolError(err) })),
      };
    }

    const turn = session.turn++;
    const results: SearchToolResult["results"] = [];
    let idx = 0; // flat ref index across the whole call (spec §3.2)

    for (const [i, query] of queries.entries()) {
      if (i >= MAX_SEARCH_QUERIES) {
        results.push({
          q: query.q,
          items: [],
          error: invalidArgs(
            `Batch limit exceeded: at most ${MAX_SEARCH_QUERIES} queries per call.`,
            "Re-submit the remaining queries in a follow-up search call.",
          ).toToolError(),
        });
        continue;
      }
      if (!query.q || query.q.trim() === "") {
        results.push({
          q: query.q ?? "",
          items: [],
          error: invalidArgs('Query parameter "q" must be a non-empty string.').toToolError(),
        });
        continue;
      }
      try {
        if (!this.backend) {
          throw new GroundingError(
            "BACKEND_ERROR",
            "No search backend is configured on this server.",
          );
        }
        const raw = await this.backend.search(query);
        const items: SearchResultItem[] = raw.map((r) => {
          const ref = formatRef(turn, "search", idx++);
          const record: RefRecord = {
            kind: "search",
            title: r.title,
            url: r.url,
            snippet: r.snippet.slice(0, SNIPPET_MAX_CHARS),
          };
          if (r.publishedAt !== undefined) record.publishedAt = r.publishedAt;
          session.refs.set(ref, record);
          const item: SearchResultItem = {
            ref,
            title: r.title,
            url: r.url,
            snippet: r.snippet.slice(0, SNIPPET_MAX_CHARS),
          };
          if (r.publishedAt !== undefined) item.publishedAt = r.publishedAt;
          return item;
        });
        results.push({ q: query.q, items });
      } catch (err) {
        results.push({ q: query.q, items: [], error: asToolError(err) });
      }
    }

    return { session_id: session.id, results };
  }

  // -------------------------------------------------------------------------
  // open (spec §4.2)
  // -------------------------------------------------------------------------

  async open(
    sessionId: string | undefined,
    targets: OpenTargetInput[],
  ): Promise<{ session_id: string; results: OpenTargetResult[] }> {
    let session: Session;
    try {
      session = this.resolveSession(sessionId);
    } catch (err) {
      return {
        session_id: sessionId ?? "",
        results: targets.map(() => ({ error: asToolError(err) })),
      };
    }

    const turn = session.turn++;
    let fetchIdx = 0;
    const mintFetchRef = () => formatRef(turn, "fetch", fetchIdx++);

    const results: OpenTargetResult[] = [];
    for (const [i, target] of targets.entries()) {
      if (i >= MAX_OPEN_TARGETS) {
        results.push({
          error: invalidArgs(
            `Batch limit exceeded: at most ${MAX_OPEN_TARGETS} targets per call.`,
            "Re-submit the remaining targets in a follow-up open call.",
          ).toToolError(),
        });
        continue;
      }
      results.push(await this.openTarget(session, target, mintFetchRef));
    }
    return { session_id: session.id, results };
  }

  private async openTarget(
    session: Session,
    target: OpenTargetInput,
    mintFetchRef: () => string,
  ): Promise<OpenTargetResult> {
    try {
      const hasRef = target.ref !== undefined;
      const hasUrl = target.url !== undefined;
      if (hasRef === hasUrl) {
        throw invalidArgs(
          'Exactly one of "ref" or "url" must be provided per target.',
        );
      }

      if (hasRef) {
        const ref = target.ref!;
        const record = session.refs.get(ref);
        if (!record) throw refNotFound(ref);
        if (record.kind === "fetch") {
          // Window repositioning: same instance, SAME ref, no re-fetch (§4.2).
          return this.pageResult(record.page, target.lineno);
        }
        // Opening a search ref fetches its URL and mints a fresh fetch ref.
        return await this.openUrl(session, record.url, target.lineno, mintFetchRef);
      }

      return await this.openUrl(session, target.url!, target.lineno, mintFetchRef);
    } catch (err) {
      return { error: asToolError(err) };
    }
  }

  /** Fetch (or reuse cached) content for a URL and mint a new page instance. */
  private async openUrl(
    session: Session,
    url: string,
    lineno: number | undefined,
    mintFetchRef: () => string,
  ): Promise<OpenTargetResult> {
    const content = await this.loadContent(url);
    const ref = mintFetchRef();
    const page = this.instantiatePage(ref, url, content);
    session.refs.set(ref, { kind: "fetch", page });
    return this.pageResult(page, lineno);
  }

  /**
   * URL cache (spec §7.2): keyed by finalUrl, ~10 min TTL, shared across
   * sessions. Lookups use the requested URL — a hit means that URL was the
   * final URL of a recent fetch.
   */
  private async loadContent(url: string): Promise<PageContent> {
    const now = this.now();
    const hit = this.cache.get(url);
    if (hit && now - hit.cachedAt <= this.cacheTtlMs) {
      return {
        finalUrl: hit.finalUrl,
        title: hit.title,
        lines: hit.lines,
        elements: hit.elements,
        fetchedAt: hit.fetchedAt,
        renderMode: hit.renderMode,
      };
    }
    const content = await this.loadPage(url);
    this.cache.set(content.finalUrl, { ...content, cachedAt: this.now() });
    return content;
  }

  /** Build a per-session page instance from content; element IDs regenerate. */
  private instantiatePage(
    ref: string,
    requestedUrl: string,
    content: PageContent,
  ): Page {
    const elements: PageElement[] = content.elements.map((e, i) => ({
      ...e,
      id: i + 1,
    }));
    return {
      ref,
      url: requestedUrl,
      finalUrl: content.finalUrl,
      title: content.title,
      fetchedAt: content.fetchedAt,
      renderMode: content.renderMode,
      lines: content.lines,
      totalLines: content.lines.length,
      elements,
    };
  }

  private pageResult(page: Page, lineno: number | undefined): OpenTargetResult {
    const win = computeWindow(page.lines, lineno, this.maxLines, this.maxTokens);
    const view = formatPageView(page, win);
    const result: OpenTargetResult = {
      ref: page.ref,
      url: page.url,
      finalUrl: page.finalUrl,
      title: page.title,
      fetchedAt: page.fetchedAt.toISOString(),
      renderMode: page.renderMode,
      window: view.window,
      lines: view.lines,
      elementCount: page.elements.length,
    };
    if (view.hint !== undefined) result.hint = view.hint;
    return result;
  }

  // -------------------------------------------------------------------------
  // find (spec §4.3) — issues no refs, never advances the turn counter
  // -------------------------------------------------------------------------

  find(
    sessionId: string | undefined,
    ref: string,
    pattern: string,
  ): FindToolResult {
    let session: Session;
    try {
      session = this.resolveSession(sessionId);
    } catch (err) {
      return { session_id: sessionId ?? "", error: asToolError(err) };
    }
    try {
      if (!pattern || pattern.length === 0) {
        throw invalidArgs('"pattern" must be a non-empty string.');
      }
      const record = session.refs.get(ref);
      if (!record) throw refNotFound(ref);
      if (record.kind !== "fetch") {
        throw invalidRefType(ref, "search", "a fetch ref (turn{N}fetch{idx})");
      }
      const page = record.page;

      // Case-insensitive literal matching against rendered line content
      // (markers included); one match per matching line (spec §4.3).
      const needle = pattern.toLowerCase();
      const matchLines: number[] = [];
      for (let i = 0; i < page.lines.length; i++) {
        if (page.lines[i]!.toLowerCase().includes(needle)) matchLines.push(i);
      }

      const totalMatches = matchLines.length;
      const matches = matchLines.slice(0, FIND_MAX_MATCHES).map((i) => {
        const from = Math.max(0, i - FIND_CONTEXT_LINES);
        const to = Math.min(page.lines.length - 1, i + FIND_CONTEXT_LINES);
        const context: string[] = [];
        for (let j = from; j <= to; j++) {
          context.push(`${j + 1} | ${page.lines[j]!}`);
        }
        return { lineno: i + 1, context };
      });

      const result: FindToolResult = {
        session_id: session.id,
        ref,
        totalMatches,
        matches,
      };
      if (totalMatches > FIND_MAX_MATCHES) {
        result.hint = `${totalMatches - FIND_MAX_MATCHES} more matches not shown; narrow the pattern.`;
      }
      return result;
    } catch (err) {
      return { session_id: session.id, error: asToolError(err) };
    }
  }

  // -------------------------------------------------------------------------
  // click (spec §4.4)
  // -------------------------------------------------------------------------

  async click(
    sessionId: string | undefined,
    ref: string,
    id: number,
  ): Promise<ClickToolResult> {
    let session: Session;
    try {
      session = this.resolveSession(sessionId);
    } catch (err) {
      return { session_id: sessionId ?? "", error: asToolError(err) };
    }
    try {
      // Ref-issuing call: advance the turn counter once, up front (§3.2).
      const turn = session.turn++;
      const record = session.refs.get(ref);
      if (!record) throw refNotFound(ref);
      if (record.kind !== "fetch") {
        throw invalidRefType(ref, "search", "a fetch ref (turn{N}fetch{idx})");
      }
      const page = record.page;

      const element = page.elements.find((e) => e.id === id);
      if (!element) {
        throw new GroundingError(
          "ELEMENT_NOT_FOUND",
          `Page ${ref} has no element with id ${id} (it has ${page.elements.length} elements).`,
        );
      }
      if (element.kind === "button") {
        throw new GroundingError(
          "ELEMENT_NOT_ACTIONABLE",
          `Element ${id} on ${ref} is a button ("${element.text}"); buttons are display-only in v1.`,
        );
      }
      if (!element.href) {
        throw new GroundingError(
          "ELEMENT_NOT_ACTIONABLE",
          `Element ${id} on ${ref} has no href to follow.`,
        );
      }

      // Relative hrefs resolve against the page's finalUrl (spec §4.4).
      let targetUrl: string;
      try {
        targetUrl = new URL(element.href, page.finalUrl).href;
      } catch {
        throw new GroundingError(
          "FETCH_FAILED",
          `Element ${id} on ${ref} has an unresolvable href: "${element.href}".`,
        );
      }
      const scheme = new URL(targetUrl).protocol;
      if (scheme !== "http:" && scheme !== "https:") {
        throw unsupportedScheme(targetUrl);
      }

      const fetchRef = formatRef(turn, "fetch", 0);
      const content = await this.loadContent(targetUrl);
      const newPage = this.instantiatePage(fetchRef, targetUrl, content);
      session.refs.set(fetchRef, { kind: "fetch", page: newPage });
      session.history.push(ref); // breadcrumb for a future back() (§4.4)
      return { session_id: session.id, ...this.pageResult(newPage, undefined) };
    } catch (err) {
      return { session_id: session.id, error: asToolError(err) };
    }
  }
}
