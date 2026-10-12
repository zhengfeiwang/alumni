/**
 * The fetch → extract → render pipeline (spec §5 rule 5). Pure composition of
 * engine primitives; all state (sessions, cache) lives in the session manager.
 */

import { fetchPage, type FetchPolicy, type FetchLike, type LookupLike } from "./fetch.js";
import { extractReadable } from "./extract.js";
import { renderMarkdown } from "./render.js";
import { JsRenderer } from "./jsrender.js";
import { GroundingError } from "../errors.js";
import type { PageContent } from "../types.js";

export interface PipelineOptions {
  policy: FetchPolicy;
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
  lookupImpl?: LookupLike;
  /**
   * Extension point for the JS-rendered fallback. Defaults to the stub
   * JsRenderer, which is never "available"; when a real backend exists it
   * will be invoked when static extraction yields too little content.
   */
  jsRenderer?: JsRenderer;
}

export async function loadPage(
  url: string,
  opts: PipelineOptions,
): Promise<PageContent> {
  const fetched = await fetchPage(
    url,
    opts.policy,
    opts.fetchImpl,
    opts.lookupImpl,
  );

  let extracted;
  try {
    extracted = extractReadable(fetched.body, fetched.finalUrl);
  } catch (err) {
    // JS-rendered fallback extension point (spec §5 rule 5). The stub
    // renderer is never available, so the static error surfaces unchanged.
    const js = opts.jsRenderer ?? new JsRenderer();
    if (err instanceof GroundingError && err.code === "EXTRACTION_FAILED" && JsRenderer.available) {
      const rendered = await js.render(fetched.finalUrl);
      return { ...rendered, renderMode: "js" };
    }
    throw err;
  }

  const { lines, elements } = renderMarkdown(extracted.markdown);
  if (lines.length === 0) {
    throw new GroundingError(
      "EXTRACTION_FAILED",
      `"${fetched.finalUrl}" yielded no readable content after rendering.`,
    );
  }

  return {
    finalUrl: fetched.finalUrl,
    title: extracted.title,
    lines,
    elements,
    fetchedAt: new Date(),
    renderMode: "static",
  };
}
