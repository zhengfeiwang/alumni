/**
 * click tool (spec §4.4). Thin MCP projection of SessionManager.click.
 */

import { z } from "zod";
import type { SessionManager } from "../session/manager.js";
import { SHARED_RULES } from "./descriptions.js";

export const clickInputSchema = {
  session_id: z
    .string()
    .optional()
    .describe(
      "Session id returned by a previous call. Effectively required: a fresh session contains no refs, so omitting it can only yield REF_NOT_FOUND.",
    ),
  ref: z
    .string()
    .describe("The fetch ref (turn{N}fetch{idx}) of the page that issued the element."),
  id: z
    .number()
    .int()
    .describe("Element id within that page, as shown by [{id}] markers."),
};

export const clickDescription = [
  "Follow a link element [{id}] from a fetched page (turn{N}fetch{idx}). Semantically equivalent to open of the element's href, resolved against the page's final URL; returns the same shape as open with a fresh fetch ref.",
  "click always navigates. Buttons shown as [btn] are display-only and return ELEMENT_NOT_ACTIONABLE.",
  SHARED_RULES,
].join(" ");

export async function handleClick(
  manager: SessionManager,
  args: { session_id?: string | undefined; ref: string; id: number },
) {
  return manager.click(args.session_id, args.ref, args.id);
}
