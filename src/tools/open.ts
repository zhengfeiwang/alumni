/**
 * open tool (spec §4.2). Thin MCP projection of SessionManager.open.
 */

import { z } from "zod";
import type { SessionManager } from "../session/manager.js";
import { SHARED_RULES } from "./descriptions.js";

export const openInputSchema = {
  session_id: z
    .string()
    .optional()
    .describe("Session id returned by a previous call. Omit to start a new session."),
  targets: z
    .array(
      z.object({
        ref: z
          .string()
          .optional()
          .describe(
            "A prior ref: turn{N}search{idx} or turn{N}fetch{idx}. Takes precedence over url.",
          ),
        url: z
          .string()
          .optional()
          .describe("Raw http(s) URL; used only when ref is absent."),
        lineno: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Start the window at this line (1-based)."),
      }),
    )
    .min(1)
    .describe("Batched targets; at most 3 are processed per call."),
};

export const openDescription = [
  "Fetch and read a page. Each target is polymorphic: exactly one of ref (a prior turn{N}search{idx} or turn{N}fetch{idx} ref) or url. Batched: up to 3 targets per call, with per-item errors.",
  "Returns numbered lines, windowed to the first ~200 lines or ~4000 tokens; use lineno (1-based) to view other ranges. Opening a search ref or URL mints a fresh turn{N}fetch{idx} ref; repositioning an existing fetch ref returns the SAME ref (no re-fetch).",
  "Links appear inline as [{id}] at their anchor text and can be followed with click; buttons appear as [btn] and are not actionable.",
  SHARED_RULES,
].join(" ");

export async function handleOpen(
  manager: SessionManager,
  args: {
    session_id?: string | undefined;
    targets: Array<{
      ref?: string | undefined;
      url?: string | undefined;
      lineno?: number | undefined;
    }>;
  },
) {
  return manager.open(args.session_id, args.targets);
}
