/**
 * STUB — JS rendering fallback (spec §5: "JS-rendered fallback (Playwright)
 * triggers when static extraction yields below a content threshold").
 *
 * Playwright is intentionally NOT a dependency yet. This module defines the
 * extension point: when the real implementation lands it should
 *
 *   1. launch headless Chromium and navigate to the URL (still subject to the
 *      fetch policy in engine/fetch.ts — scheme allowlist + private-egress
 *      denial must be enforced by routing browser traffic through a policy
 *      check, since the browser resolves its own DNS),
 *   2. wait for network idle, take the rendered DOM's HTML,
 *   3. feed that HTML through extractReadable + renderMarkdown with
 *      renderMode "js".
 *
 * pipeline.ts calls this stub when static extraction fails below the content
 * threshold; today it always throws, so the caller surfaces the original
 * EXTRACTION_FAILED error.
 */

import { GroundingError } from "../errors.js";
import type { PageContent } from "../types.js";

export class JsRenderer {
  /** Whether a real JS-rendering backend is available in this build. */
  static get available(): boolean {
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async render(_url: string): Promise<PageContent> {
    throw new GroundingError(
      "EXTRACTION_FAILED",
      "JS rendering is not available in this build (Playwright backend not installed). " +
        "This is a deliberate stub; see src/engine/jsrender.ts for the extension point.",
      "Try a different source, or build the JS-rendered fallback (spec §5).",
    );
  }
}
