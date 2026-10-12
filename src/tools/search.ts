/**
 * search tool (spec §4.1). Thin MCP projection of SessionManager.search.
 */

import { z } from "zod";
import type { SessionManager } from "../session/manager.js";
import { SHARED_RULES } from "./descriptions.js";

export const searchInputSchema = {
  session_id: z
    .string()
    .optional()
    .describe("Session id returned by a previous call. Omit to start a new session."),
  queries: z
    .array(
      z.object({
        q: z.string().describe("The search query."),
        recency: z
          .enum(["day", "week", "month"])
          .optional()
          .describe("Freshness filter."),
        domains: z
          .array(z.string())
          .optional()
          .describe("Restrict results to these domains."),
      }),
    )
    .min(1)
    .describe("Batched queries; at most 5 are processed per call."),
};

export const searchDescription = [
  "Search the web. Batched: up to 5 queries per call; items are independent and each carries its own error field on failure.",
  "Results are grouped per query and each item carries a ref (turn{N}search{idx}). Refs are the only way to address results: pass one to open to read the page.",
  "Snippets are capped at ~300 chars — search is for discovery, not reading; reading requires open.",
  SHARED_RULES,
].join(" ");

export async function handleSearch(
  manager: SessionManager,
  args: {
    session_id?: string | undefined;
    queries: Array<{
      q: string;
      recency?: "day" | "week" | "month" | undefined;
      domains?: string[] | undefined;
    }>;
  },
) {
  return manager.search(args.session_id, args.queries);
}
