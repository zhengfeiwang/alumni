import { describe, expect, it } from "vitest";
import { computeWindow } from "../src/session/window.js";

const lines = Array.from({ length: 480 }, (_, i) => `line ${i + 1}`);

describe("computeWindow (spec §4.2)", () => {
  it("defaults to the first window", () => {
    const w = computeWindow(lines, undefined, 200, 4000);
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBe(200);
    expect(w.clamped).toBe(false);
  });

  it("starts at lineno (1-based)", () => {
    const w = computeWindow(lines, 214, 200, 4000);
    expect(w.startIdx).toBe(213);
    expect(w.endIdx).toBe(413);
    expect(w.clamped).toBe(false);
  });

  it("clamps lineno beyond totalLines to the final window", () => {
    const w = computeWindow(lines, 9999, 200, 4000);
    expect(w.startIdx).toBe(280);
    expect(w.endIdx).toBe(480);
    expect(w.clamped).toBe(true);
    expect(w.requested).toBe(9999);
  });

  it("stops at the token budget when it is smaller than the line budget", () => {
    const long = Array.from({ length: 10 }, () => "x".repeat(400)); // ~100 tokens each
    const w = computeWindow(long, undefined, 200, 250);
    expect(w.endIdx).toBeLessThan(10);
    expect(w.endIdx).toBeGreaterThan(0);
  });

  it("handles empty pages", () => {
    const w = computeWindow([], 5, 200, 4000);
    expect(w).toMatchObject({ startIdx: 0, endIdx: 0, clamped: false });
  });
});
