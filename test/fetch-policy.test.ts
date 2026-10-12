import { describe, expect, it } from "vitest";
import {
  DEFAULT_FETCH_POLICY,
  fetchPage,
  isPrivateIp,
  type FetchLike,
  type LookupLike,
} from "../src/engine/fetch.js";
import { GroundingError } from "../src/errors.js";

const publicLookup: LookupLike = async () => [{ address: "93.184.216.34", family: 4 }];

function okResponse(body = "ok"): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

async function expectCode(p: Promise<unknown>, code: string): Promise<GroundingError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(GroundingError);
    expect((err as GroundingError).code).toBe(code);
    return err as GroundingError;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

describe("isPrivateIp (spec §8)", () => {
  it.each([
    ["10.0.0.1", true],
    ["192.168.1.1", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.15.0.1", false],
    ["127.0.0.1", true],
    ["169.254.169.254", true],
    ["0.0.0.0", true],
    ["100.64.0.1", true],
    ["8.8.8.8", false],
    ["93.184.216.34", false],
    ["::1", true],
    ["::", true],
    ["fe80::1", true],
    ["fc00::1", true],
    ["ff02::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:8.8.8.8", false],
    ["2606:4700:4700::1111", false],
    ["not-an-ip", false],
  ])("classifies %s → %s", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

describe("fetchPage policy (spec §8)", () => {
  it("rejects non-http(s) schemes with UNSUPPORTED_SCHEME", async () => {
    const err = await expectCode(fetchPage("file:///etc/passwd"), "UNSUPPORTED_SCHEME");
    expect(err.message).toContain("file");
  });

  it("rejects hosts that resolve to private addresses", async () => {
    const lookup: LookupLike = async () => [{ address: "10.0.0.5", family: 4 }];
    const fetchImpl: FetchLike = async () => okResponse();
    const err = await expectCode(
      fetchPage("http://intranet.local/", DEFAULT_FETCH_POLICY, fetchImpl, lookup),
      "FETCH_FAILED",
    );
    expect(err.message).toContain("private");
  });

  it("allows private addresses when the policy allows it", async () => {
    const lookup: LookupLike = async () => [{ address: "127.0.0.1", family: 4 }];
    const fetchImpl: FetchLike = async () => okResponse("hello");
    const res = await fetchPage(
      "http://localhost:8000/",
      { ...DEFAULT_FETCH_POLICY, allowPrivateEgress: true },
      fetchImpl,
      lookup,
    );
    expect(res.body).toBe("hello");
  });

  it("re-checks every redirect hop against the private-egress rule", async () => {
    const lookups: Record<string, string> = {
      "public.example": "93.184.216.34",
      "169.254.169.254": "169.254.169.254",
    };
    const lookup: LookupLike = async (h) => [{ address: lookups[h]!, family: 4 }];
    const fetchImpl: FetchLike = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      });
    const err = await expectCode(
      fetchPage("http://public.example/", DEFAULT_FETCH_POLICY, fetchImpl, lookup),
      "FETCH_FAILED",
    );
    expect(err.message).toContain("169.254.169.254");
  });

  it("rejects redirects to non-http(s) schemes", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } });
    await expectCode(
      fetchPage("http://public.example/", DEFAULT_FETCH_POLICY, fetchImpl, publicLookup),
      "UNSUPPORTED_SCHEME",
    );
  });

  it("fails after too many redirects", async () => {
    const fetchImpl: FetchLike = async (url) =>
      new Response(null, { status: 302, headers: { location: url } });
    const err = await expectCode(
      fetchPage(
        "http://public.example/loop",
        { ...DEFAULT_FETCH_POLICY, maxRedirects: 3 },
        fetchImpl,
        publicLookup,
      ),
      "FETCH_FAILED",
    );
    expect(err.message).toContain("redirect");
  });

  it("enforces the response size cap via content-length", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": String(20 * 1024 * 1024) },
      });
    const err = await expectCode(
      fetchPage(
        "http://public.example/big",
        { ...DEFAULT_FETCH_POLICY, maxBytes: 1024 },
        fetchImpl,
        publicLookup,
      ),
      "FETCH_FAILED",
    );
    expect(err.message).toContain("cap");
  });

  it("surfaces non-2xx statuses as FETCH_FAILED", async () => {
    const fetchImpl: FetchLike = async () => new Response("nope", { status: 404 });
    const err = await expectCode(
      fetchPage("http://public.example/missing", DEFAULT_FETCH_POLICY, fetchImpl, publicLookup),
      "FETCH_FAILED",
    );
    expect(err.message).toContain("404");
  });
});
