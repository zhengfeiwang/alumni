import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/session/manager.js";
import { fakeClock, fakeLoader, fakeSearchBackend, makeContent } from "./helpers.js";

function makeManager(backend?: ReturnType<typeof fakeSearchBackend>) {
  return new SessionManager({
    loadPage: fakeLoader({}).fn,
    sweepIntervalMs: false,
    ...(backend ? { searchBackend: backend } : {}),
  });
}

describe("search (spec §4.1)", () => {
  it("registers results as turn{N}search{idx} refs", async () => {
    const m = makeManager(
      fakeSearchBackend([
        { title: "A", url: "https://a.example", snippet: "alpha" },
        { title: "B", url: "https://b.example", snippet: "beta" },
      ]),
    );
    const res = await m.search(undefined, [{ q: "test" }]);
    expect(res.session_id).toBeTruthy();
    const items = res.results[0]!.items;
    expect(items.map((i) => i.ref)).toEqual(["turn0search0", "turn0search1"]);
    m.close();
  });

  it("returns a per-item BACKEND_ERROR when no backend is configured", async () => {
    const m = makeManager();
    const res = await m.search(undefined, [{ q: "x" }]);
    expect(res.results[0]!.items).toEqual([]);
    expect(res.results[0]!.error?.code).toBe("BACKEND_ERROR");
    expect(res.results[0]!.error?.hint).toBeTruthy();
    m.close();
  });

  it("caps snippets at ~300 chars", async () => {
    const m = makeManager(
      fakeSearchBackend([{ title: "T", url: "https://t.example", snippet: "s".repeat(500) }]),
    );
    const res = await m.search(undefined, [{ q: "x" }]);
    expect(res.results[0]!.items[0]!.snippet.length).toBe(300);
    m.close();
  });

  it("fails items beyond the batch limit without failing the batch", async () => {
    const m = makeManager(
      fakeSearchBackend([{ title: "A", url: "https://a.example", snippet: "a" }]),
    );
    const queries = Array.from({ length: 6 }, (_, i) => ({ q: `q${i}` }));
    const res = await m.search(undefined, queries);
    expect(res.results).toHaveLength(6);
    expect(res.results[4]!.error).toBeUndefined();
    expect(res.results[5]!.error?.code).toBe("INVALID_ARGS");
    m.close();
  });

  it("rejects empty queries with INVALID_ARGS per item", async () => {
    const m = makeManager(fakeSearchBackend([]));
    const res = await m.search(undefined, [{ q: "  " }]);
    expect(res.results[0]!.error?.code).toBe("INVALID_ARGS");
    m.close();
  });

  it("advances the turn counter once per call", async () => {
    const m = makeManager(
      fakeSearchBackend([{ title: "A", url: "https://a.example", snippet: "a" }]),
    );
    const first = await m.search(undefined, [{ q: "one" }]);
    const second = await m.search(first.session_id, [{ q: "two" }]);
    expect(first.results[0]!.items[0]!.ref).toBe("turn0search0");
    expect(second.results[0]!.items[0]!.ref).toBe("turn1search0");
    m.close();
  });
});
