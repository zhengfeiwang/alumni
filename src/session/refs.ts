/**
 * Source reference IDs (spec §3.2): `turn{N}{type}{idx}`.
 */

export type RefType = "search" | "fetch";

export interface ParsedRef {
  turn: number;
  type: RefType;
  idx: number;
}

const REF_PATTERN = /^turn(\d+)(search|fetch)(\d+)$/;

export function formatRef(turn: number, type: RefType, idx: number): string {
  return `turn${turn}${type}${idx}`;
}

export function parseRef(ref: string): ParsedRef | null {
  const m = REF_PATTERN.exec(ref);
  if (!m) return null;
  return {
    turn: Number(m[1]),
    type: m[2] as RefType,
    idx: Number(m[3]),
  };
}
