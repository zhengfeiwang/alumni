/**
 * STUB — Brave Search API backend.
 *
 * Behavior (deliberate, pending a real client):
 * - BRAVE_API_KEY absent  → BACKEND_ERROR "not configured" on every query.
 * - BRAVE_API_KEY present → BACKEND_ERROR explaining this is a stub; no
 *   network call is made.
 *
 * The request-shaping logic (recency → freshness param, domains → site:
 * operators) is implemented below so the real client only needs to perform
 * the HTTP call and map the response. A SearXNG backend can be added by
 * implementing SearchBackend in a sibling module and wiring it in index.ts.
 */

import { GroundingError } from "../errors.js";
import type {
  RawSearchResult,
  Recency,
  SearchBackend,
  SearchQuery,
} from "./backend.js";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

const RECENCY_TO_FRESHNESS: Record<Recency, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
};

export class BraveSearchBackend implements SearchBackend {
  readonly name = "brave";

  constructor(private readonly apiKey: string | undefined) {}

  async search(query: SearchQuery): Promise<RawSearchResult[]> {
    if (!this.apiKey) {
      throw new GroundingError(
        "BACKEND_ERROR",
        'Brave Search backend is not configured: BRAVE_API_KEY is not set.',
        "Set the BRAVE_API_KEY environment variable and restart the server, or configure a different search backend.",
      );
    }
    // Build (but never send) the request so the shape is ready to fill in.
    const _request = this.buildRequest(query);
    throw new GroundingError(
      "BACKEND_ERROR",
      "Brave Search backend is a stub in v0.1: no API call is implemented yet.",
      "Implement BraveSearchBackend.callApi() (see src/search/brave.ts) or plug in a SearXNG backend.",
    );
  }

  /** Request shaping for the future real client. */
  private buildRequest(query: SearchQuery): { url: string; headers: Record<string, string> } {
    const params = new URLSearchParams({ q: query.q });
    if (query.recency) {
      params.set("freshness", RECENCY_TO_FRESHNESS[query.recency]);
    }
    if (query.domains && query.domains.length > 0) {
      // Brave has no multi-domain filter param; restrict via site: operators.
      const restrict = query.domains.map((d) => `site:${d}`).join(" OR ");
      params.set("q", `(${restrict}) ${query.q}`);
    }
    return {
      url: `${BRAVE_ENDPOINT}?${params.toString()}`,
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.apiKey ?? "",
      },
    };
  }

  // Future real implementation:
  // private async callApi(req): Promise<RawSearchResult[]> { ... }
}
