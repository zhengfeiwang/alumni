/**
 * Line-window computation and rendered page formatting (spec §4.2/§5).
 *
 * Windows are 1-based and inclusive at both ends in the wire format
 * ("lines 214–420 of 480"); internally they are 0-based [startIdx, endIdx).
 * Default window: ~200 lines or ~4,000 tokens (est. 4 chars/token), whichever
 * is smaller. A lineno beyond totalLines clamps to the final window.
 */

import type { Page, WindowSpec } from "../types.js";

export const DEFAULT_MAX_LINES = 200;
export const DEFAULT_MAX_TOKENS = 4000;
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

export interface ComputedWindow {
  startIdx: number; // 0-based inclusive
  endIdx: number; // 0-based exclusive
  clamped: boolean; // requested lineno was beyond totalLines
  requested: number; // the 1-based lineno actually requested
}

/** Grow a window forward from startIdx, bounded by line and token budgets. */
function growForward(
  lines: string[],
  startIdx: number,
  maxLines: number,
  maxTokens: number,
): number {
  let endIdx = startIdx;
  let tokens = 0;
  while (endIdx < lines.length && endIdx - startIdx < maxLines) {
    const t = estimateTokens(lines[endIdx]!);
    if (endIdx > startIdx && tokens + t > maxTokens) break;
    tokens += t;
    endIdx++;
  }
  return endIdx;
}

export function computeWindow(
  lines: string[],
  lineno: number | undefined,
  maxLines: number = DEFAULT_MAX_LINES,
  maxTokens: number = DEFAULT_MAX_TOKENS,
): ComputedWindow {
  const total = lines.length;
  const requested = lineno ?? 1;
  if (total === 0) return { startIdx: 0, endIdx: 0, clamped: false, requested };

  if (requested <= total) {
    const startIdx = requested - 1;
    return {
      startIdx,
      endIdx: growForward(lines, startIdx, maxLines, maxTokens),
      clamped: false,
      requested,
    };
  }

  // Clamp to the final window: the largest window ending at the last line
  // that respects both budgets.
  let startIdx = total - 1;
  let tokens = estimateTokens(lines[startIdx]!);
  while (startIdx > 0 && total - startIdx < maxLines) {
    const t = estimateTokens(lines[startIdx - 1]!);
    if (tokens + t > maxTokens) break;
    tokens += t;
    startIdx--;
  }
  return { startIdx, endIdx: total, clamped: true, requested };
}

export interface FormattedPageView {
  /** Header block + numbered lines + optional continuation hint (spec §5). */
  lines: string[];
  window: WindowSpec;
  hint?: string;
}

export function formatPageView(
  page: Page,
  win: ComputedWindow,
): FormattedPageView {
  const total = page.totalLines;
  const start = win.startIdx + 1; // 1-based
  const end = win.endIdx; // inclusive 1-based == exclusive 0-based

  const out: string[] = [
    `# ${page.title}`,
    `URL: ${page.finalUrl}`,
    `Fetched: ${page.fetchedAt.toISOString()} · ${page.renderMode} · lines ${start}–${end} of ${total}`,
    "",
  ];
  for (let i = win.startIdx; i < win.endIdx; i++) {
    out.push(`${i + 1} | ${page.lines[i]!}`);
  }

  let hint: string | undefined;
  if (win.endIdx < total) {
    out.push(
      `— lines ${win.endIdx + 1}–${total} not shown; open(${page.ref}, lineno=${win.endIdx + 1}) or use find —`,
    );
    hint = `${total} lines total; showing lines ${start}–${end}. Use find to locate content, or open the same ref with lineno=${win.endIdx + 1} to continue.`;
  }
  if (win.clamped) {
    const clampMsg = `Requested lineno ${win.requested} exceeds totalLines ${total}; clamped to the final window (lines ${start}–${end}).`;
    hint = hint ? `${clampMsg} ${hint}` : clampMsg;
  }

  const view: FormattedPageView = {
    lines: out,
    window: { start, end, total },
  };
  if (hint !== undefined) view.hint = hint;
  return view;
}
