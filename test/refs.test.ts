import { describe, expect, it } from "vitest";
import { formatRef, parseRef } from "../src/session/refs.js";

describe("refs (spec §3.2)", () => {
  it("formats turn{N}{type}{idx}", () => {
    expect(formatRef(0, "search", 2)).toBe("turn0search2");
    expect(formatRef(4, "fetch", 0)).toBe("turn4fetch0");
  });

  it("parses what it formats", () => {
    expect(parseRef("turn12search3")).toEqual({ turn: 12, type: "search", idx: 3 });
    expect(parseRef("turn4fetch0")).toEqual({ turn: 4, type: "fetch", idx: 0 });
  });

  it("rejects malformed refs", () => {
    expect(parseRef("turn4fetch")).toBeNull();
    expect(parseRef("turnfetch0")).toBeNull();
    expect(parseRef("s4")).toBeNull();
    expect(parseRef("turn4view0")).toBeNull();
    expect(parseRef("")).toBeNull();
  });
});
