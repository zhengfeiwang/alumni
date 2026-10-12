/**
 * Shared test helpers: fake page pipeline + canned content, so session/tool
 * tests run with no network.
 */

import { GroundingError } from "../src/errors.js";
import type { PageLoader } from "../src/session/manager.js";
import type { PageContent, PageElement } from "../src/types.js";
import type { RawSearchResult, SearchBackend, SearchQuery } from "../src/search/backend.js";

export function makeContent(
  url: string,
  lines: string[],
  elements: PageElement[] = [],
  title = `Title for ${url}`,
): PageContent {
  return {
    finalUrl: url,
    title,
    lines,
    elements,
    fetchedAt: new Date("2026-01-01T00:00:00.000Z"),
    renderMode: "static",
  };
}

export interface FakeLoader {
  fn: PageLoader;
  calls: string[];
}

export function fakeLoader(pages: Record<string, PageContent>): FakeLoader {
  const calls: string[] = [];
  const fn: PageLoader = async (url: string) => {
    calls.push(url);
    const page = pages[url];
    if (!page) {
      throw new GroundingError("FETCH_FAILED", `no fixture for ${url}`);
    }
    return page;
  };
  return { fn, calls };
}

export function fakeSearchBackend(
  results: RawSearchResult[] | ((q: SearchQuery) => RawSearchResult[]),
): SearchBackend {
  return {
    name: "fake",
    async search(q: SearchQuery) {
      return typeof results === "function" ? results(q) : results;
    },
  };
}

/** A controllable clock for TTL tests. */
export function fakeClock(start = 1_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
