/**
 * Pluggable search backend interface (spec §4.1).
 *
 * Backends are injected into the SessionManager, so adding a SearXNG backend
 * later is a matter of implementing this interface and wiring it in index.ts
 * (or a config flag). Do not add business logic here.
 */

export type Recency = "day" | "week" | "month";

export interface SearchQuery {
  q: string;
  recency?: Recency | undefined;
  domains?: string[] | undefined;
}

/** One search result, before ref registration. */
export interface RawSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string; // ISO 8601
}

export interface SearchBackend {
  readonly name: string;
  /**
   * Run one query. Throws GroundingError (BACKEND_ERROR / RATE_LIMITED) on
   * failure; the search tool converts that into a per-item error.
   */
  search(query: SearchQuery): Promise<RawSearchResult[]>;
}
