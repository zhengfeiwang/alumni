/**
 * find tool (spec §4.3). Thin MCP projection of SessionManager.find.
 */

import { z } from "zod";
import type { SessionManager } from "../session/manager.js";
import { SHARED_RULES } from "./descriptions.js";

export const findInputSchema = {
  session_id: z
    .string()
    .optional()
    .describe(
      "Session id returned by a previous call. Effectively required: a fresh session contains no refs, so omitting it can only yield REF_NOT_FOUND.",
    ),
  ref: z.string().describe("A fetch ref (turn{N}fetch{idx})."),
  pattern: z
    .string()
    .min(1)
    .describe(
      "Literal pattern; matching is case-insensitive against rendered line content (including [id] markers).",
    ),
  mode: z
    .enum(["literal"])
    .optional()
    .describe("v1 supports literal matching only."),
};

export const findDescription = [
  "Locate a pattern within a fetched page (a fetch ref, turn{N}fetch{idx}; search refs are rejected with INVALID_REF_TYPE).",
  "Returns up to 10 matches with ±3 lines of numbered context each; totalMatches is always exact so you can decide to narrow the pattern.",
  "Pair with open(ref, lineno) to jump to a match. find issues no refs and does not advance the turn counter.",
  SHARED_RULES,
].join(" ");

export async function handleFind(
  manager: SessionManager,
  args: {
    session_id?: string | undefined;
    ref: string;
    pattern: string;
    mode?: "literal" | undefined;
  },
) {
  return manager.find(args.session_id, args.ref, args.pattern);
}
