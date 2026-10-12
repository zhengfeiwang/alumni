import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/session/manager.js";
import type { PageElement } from "../src/types.js";
import {
  fakeClock,
  fakeLoader,
  fakeSearchBackend,
  makeContent,
} from "./helpers.js";

const ARTICLE = "https://example.com/article";
const ABOUT = "https://example.com/about";

const articleLines = [
  "An article about grounding tools.",
  "It has a [1] Related page link inside.",
  "Third line.",
  "Fourth line.",
  "Fifth line.",
];

function articleElements(): PageElement[] {
  return [
    { id: 0, kind: "link", text: "Related page", href: "/about" },
    { id: 0, kind: "button", text: "Subscribe" },
    { id: 0, kind: "link", text: "Broken", href: "javascript:void(0)" },
  ];
}

function makeManager(opts: {
  clock?: ReturnType<typeof fakeClock>;
  sessionTtlMs?: number;
  windowMaxLines?: number;
}) {
  const loader = fakeLoader({
    [ARTICLE]: makeContent(ARTICLE, articleLines, articleElements(), "Article"),
    [ABOUT]: makeContent(ABOUT, ["The about page."], [], "About"),
  });
  const manager = new SessionManager({
    loadPage: loader.fn,
    sweepIntervalMs: false,
    now: opts.clock?.now,
    sessionTtlMs: opts.sessionTtlMs,
    windowMaxLines: opts.windowMaxLines,
  });
  return { manager, loader };
}

describe("open (spec §4.2)", () => {
  it("mints a fresh fetch ref for URL targets", async () => {
    const { manager } = makeManager({});
    const res = await manager.open(undefined, [{ url: ARTICLE }]);
    const r = res.results[0]!;
    expect(r.ref).toBe("turn0fetch0");
    expect(r.title).toBe("Article");
    expect(r.window).toEqual({ start: 1, end: 5, total: 5 });
    expect(r.lines?.[0]).toBe("# Article");
    expect(r.lines).toContain("2 | It has a [1] Related page link inside.");
    expect(r.elementCount).toBe(3);
    manager.close();
  });

  it("mints turn{N}fetch0..2 for a batched open of three URLs", async () => {
    const { manager } = makeManager({});
    const res = await manager.open(undefined, [
      { url: ARTICLE },
      { url: ABOUT },
      { url: ARTICLE },
    ]);
    expect(res.results.map((r) => r.ref)).toEqual([
      "turn0fetch0",
      "turn0fetch1",
      "turn0fetch2",
    ]);
    manager.close();
  });

  it("returns per-item INVALID_ARGS for the 4th target", async () => {
    const { manager } = makeManager({});
    const res = await manager.open(undefined, [
      { url: ARTICLE },
      { url: ARTICLE },
      { url: ARTICLE },
      { url: ARTICLE },
    ]);
    expect(res.results[3]!.error?.code).toBe("INVALID_ARGS");
    expect(res.results[2]!.error).toBeUndefined();
    manager.close();
  });

  it("requires exactly one of ref/url", async () => {
    const { manager } = makeManager({});
    const res = await manager.open(undefined, [
      { url: ARTICLE, ref: "turn0fetch0" },
      {},
    ]);
    expect(res.results[0]!.error?.code).toBe("INVALID_ARGS");
    expect(res.results[1]!.error?.code).toBe("INVALID_ARGS");
    manager.close();
  });

  it("repositioning a fetch ref returns the SAME ref and does not re-fetch", async () => {
    const { manager, loader } = makeManager({ windowMaxLines: 2 });
    const first = await manager.open(undefined, [{ url: ARTICLE }]);
    const sid = first.session_id;
    const ref = first.results[0]!.ref!;
    const callsAfterOpen = loader.calls.length;

    const moved = await manager.open(sid, [{ ref, lineno: 3 }]);
    expect(moved.results[0]!.ref).toBe(ref);
    expect(moved.results[0]!.window).toEqual({ start: 3, end: 4, total: 5 });
    expect(loader.calls.length).toBe(callsAfterOpen);
    manager.close();
  });

  it("clamps lineno beyond totalLines to the final window, with a hint", async () => {
    const { manager } = makeManager({ windowMaxLines: 2 });
    const res = await manager.open(undefined, [{ url: ARTICLE, lineno: 9999 }]);
    const r = res.results[0]!;
    expect(r.window).toEqual({ start: 4, end: 5, total: 5 });
    expect(r.hint).toContain("clamp");
    manager.close();
  });

  it("reuses the URL cache but still mints a new ref and new element ids", async () => {
    const { manager, loader } = makeManager({});
    const first = await manager.open(undefined, [{ url: ARTICLE }]);
    const second = await manager.open(first.session_id, [{ url: ARTICLE }]);
    expect(second.results[0]!.ref).not.toBe(first.results[0]!.ref);
    expect(loader.calls.filter((u) => u === ARTICLE)).toHaveLength(1);
    manager.close();
  });

  it("resolves a search ref by fetching its URL and minting a fetch ref", async () => {
    const backend = fakeSearchBackend([
      { title: "Article", url: ARTICLE, snippet: "s" },
    ]);
    const { manager, loader } = makeManager({});
    const withBackend = new SessionManager({
      loadPage: loader.fn,
      sweepIntervalMs: false,
      searchBackend: backend,
    });
    const s = await withBackend.search(undefined, [{ q: "grounding" }]);
    const sref = s.results[0]!.items[0]!.ref;
    const o = await withBackend.open(s.session_id, [{ ref: sref }]);
    expect(o.results[0]!.ref).toBe("turn1fetch0");
    expect(o.results[0]!.title).toBe("Article");
    expect(loader.calls).toContain(ARTICLE);
    withBackend.close();
    manager.close();
  });

  it("returns REF_NOT_FOUND for unknown refs", async () => {
    const { manager } = makeManager({});
    const res = await manager.open(undefined, [{ ref: "turn9fetch9" }]);
    expect(res.results[0]!.error?.code).toBe("REF_NOT_FOUND");
    manager.close();
  });
});

describe("find (spec §4.3)", () => {
  async function openArticle(manager: SessionManager) {
    const res = await manager.open(undefined, [{ url: ARTICLE }]);
    return { sid: res.session_id, ref: res.results[0]!.ref! };
  }

  it("matches case-insensitively and returns ±3 lines of context", async () => {
    const { manager } = makeManager({});
    const { sid, ref } = await openArticle(manager);
    const res = manager.find(sid, ref, "GROUNDING");
    expect(res.error).toBeUndefined();
    expect(res.totalMatches).toBe(1);
    const m = res.matches![0]!;
    expect(m.lineno).toBe(1);
    expect(m.context[0]).toBe("1 | An article about grounding tools.");
    expect(m.context.length).toBe(4); // lines 1..4 around line 1
    manager.close();
  });

  it("caps matches at 10 but keeps totalMatches exact, with a hint", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `hit ${i}`);
    const loader = fakeLoader({ [ARTICLE]: makeContent(ARTICLE, many) });
    const manager = new SessionManager({ loadPage: loader.fn, sweepIntervalMs: false });
    const res = await manager.open(undefined, [{ url: ARTICLE }]);
    const found = manager.find(res.session_id, res.results[0]!.ref!, "hit");
    expect(found.totalMatches).toBe(12);
    expect(found.matches).toHaveLength(10);
    expect(found.hint).toContain("2 more");
    manager.close();
  });

  it("does not advance the turn counter", async () => {
    const { manager } = makeManager({});
    const { sid, ref } = await openArticle(manager);
    manager.find(sid, ref, "article");
    const next = await manager.open(sid, [{ url: ABOUT }]);
    expect(next.results[0]!.ref).toBe("turn1fetch0");
    manager.close();
  });

  it("rejects search refs with INVALID_REF_TYPE", async () => {
    const backend = fakeSearchBackend([
      { title: "A", url: ARTICLE, snippet: "s" },
    ]);
    const loader = fakeLoader({ [ARTICLE]: makeContent(ARTICLE, articleLines) });
    const manager = new SessionManager({
      loadPage: loader.fn,
      sweepIntervalMs: false,
      searchBackend: backend,
    });
    const s = await manager.search(undefined, [{ q: "x" }]);
    const sref = s.results[0]!.items[0]!.ref;
    const found = manager.find(s.session_id, sref, "anything");
    expect(found.error?.code).toBe("INVALID_REF_TYPE");
    manager.close();
  });
});

describe("click (spec §4.4)", () => {
  async function openArticle(manager: SessionManager) {
    const res = await manager.open(undefined, [{ url: ARTICLE }]);
    return { sid: res.session_id, ref: res.results[0]!.ref! };
  }

  it("resolves relative hrefs against finalUrl and mints a fresh fetch ref", async () => {
    const { manager, loader } = makeManager({});
    const { sid, ref } = await openArticle(manager);
    const res = await manager.click(sid, ref, 1);
    expect(res.error).toBeUndefined();
    expect(res.ref).toBe("turn1fetch0");
    expect(res.title).toBe("About");
    expect(loader.calls).toContain(ABOUT);
    manager.close();
  });

  it("pushes the source ref onto session history", async () => {
    const { manager } = makeManager({});
    const { sid, ref } = await openArticle(manager);
    await manager.click(sid, ref, 1);
    expect(manager.getSession(sid)!.history).toEqual([ref]);
    manager.close();
  });

  it("rejects unknown element ids with ELEMENT_NOT_FOUND", async () => {
    const { manager } = makeManager({});
    const { sid, ref } = await openArticle(manager);
    const res = await manager.click(sid, ref, 99);
    expect(res.error?.code).toBe("ELEMENT_NOT_FOUND");
    manager.close();
  });

  it("rejects buttons with ELEMENT_NOT_ACTIONABLE", async () => {
    const { manager } = makeManager({});
    const { sid, ref } = await openArticle(manager);
    const res = await manager.click(sid, ref, 2);
    expect(res.error?.code).toBe("ELEMENT_NOT_ACTIONABLE");
    manager.close();
  });

  it("rejects non-http(s) hrefs with UNSUPPORTED_SCHEME", async () => {
    const { manager } = makeManager({});
    const { sid, ref } = await openArticle(manager);
    const res = await manager.click(sid, ref, 3);
    expect(res.error?.code).toBe("UNSUPPORTED_SCHEME");
    manager.close();
  });
});

describe("sessions (spec §3.1/§7.1)", () => {
  it("creates a session implicitly and returns its id", async () => {
    const { manager } = makeManager({});
    const res = await manager.open(undefined, [{ url: ARTICLE }]);
    expect(res.session_id).toBeTruthy();
    expect(manager.sessionCount).toBe(1);
    manager.close();
  });

  it("evicts sessions after the idle TTL and returns SESSION_EXPIRED", async () => {
    const clock = fakeClock();
    const { manager } = makeManager({ clock, sessionTtlMs: 30 * 60_000 });
    const res = await manager.open(undefined, [{ url: ARTICLE }]);
    const sid = res.session_id;

    clock.advance(29 * 60_000);
    const alive = await manager.open(sid, [{ url: ABOUT }]);
    expect(alive.results[0]!.error).toBeUndefined();

    clock.advance(31 * 60_000);
    const gone = await manager.open(sid, [{ url: ABOUT }]);
    expect(gone.results[0]!.error?.code).toBe("SESSION_EXPIRED");
    expect(gone.results[0]!.error?.hint).toContain("Omit session_id");
    manager.close();
  });
});
