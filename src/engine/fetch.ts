/**
 * Policy-checked HTTP(S) fetch (spec §8).
 *
 * - Scheme allowlist: http/https only (UNSUPPORTED_SCHEME), checked on the
 *   initial URL and after every redirect hop.
 * - Private-network egress denied by default: loopback, RFC-1918, link-local
 *   (incl. 169.254.169.254) and related non-public ranges, re-checked after
 *   every redirect hop. Disabled by --allow-private-egress.
 * - Limits: max 10 redirects, 15 s total timeout, 10 MB response cap;
 *   violations surface as FETCH_FAILED with the reason in message.
 *
 * Known v1 limitation: we resolve and classify the host's addresses, but the
 * underlying fetch re-resolves DNS, so a DNS-rebinding attacker could race the
 * check. Pinning the connection to the validated address is future work.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import {
  fetchFailed,
  invalidArgs,
  unsupportedScheme,
  type GroundingError,
} from "../errors.js";

export interface FetchPolicy {
  allowPrivateEgress: boolean;
  maxRedirects: number;
  timeoutMs: number;
  maxBytes: number;
}

export const DEFAULT_FETCH_POLICY: FetchPolicy = {
  allowPrivateEgress: false,
  maxRedirects: 10,
  timeoutMs: 15_000,
  maxBytes: 10 * 1024 * 1024,
};

export interface FetchedPage {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
}

export type FetchLike = (
  url: string,
  init?: { redirect?: "manual" | "follow"; signal?: AbortSignal },
) => Promise<Response>;

export type LookupLike = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupLike = async (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

// ---------------------------------------------------------------------------
// IP classification (pure, unit-tested)
// ---------------------------------------------------------------------------

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

/** Expand an IPv6 address to 8 hextets, or null if malformed. */
function parseIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const firstDbl = s.indexOf("::");
  if (firstDbl !== -1 && firstDbl !== s.lastIndexOf("::")) return null;

  let head: string[];
  let tail: string[];
  if (firstDbl === -1) {
    head = s.split(":");
    tail = [];
  } else {
    const h = s.slice(0, firstDbl);
    const t = s.slice(firstDbl + 2);
    head = h === "" ? [] : h.split(":");
    tail = t === "" ? [] : t.split(":");
  }

  // Embedded IPv4 in the final group, e.g. ::ffff:127.0.0.1
  const v4hextets: number[] = [];
  const lastGroup = tail.length > 0 ? tail[tail.length - 1] : head[head.length - 1];
  if (lastGroup !== undefined && lastGroup.includes(".")) {
    const v4 = parseIpv4(lastGroup);
    if (!v4) return null;
    v4hextets.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
    if (tail.length > 0) tail = tail.slice(0, -1);
    else head = head.slice(0, -1);
  }

  const parseGroup = (g: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    return parseInt(g, 16);
  };
  const headNums = head.map(parseGroup);
  const tailNums = tail.map(parseGroup);
  if (headNums.includes(null) || tailNums.includes(null)) return null;

  const explicit = headNums.length + tailNums.length + v4hextets.length;
  if (firstDbl === -1) {
    if (explicit !== 8) return null;
  } else if (explicit >= 8) {
    return null; // "::" must compress at least one zero group
  }
  const zeros = new Array<number>(8 - explicit).fill(0);
  return [
    ...(headNums as number[]),
    ...zeros,
    ...(tailNums as number[]),
    ...v4hextets,
  ];
}

function isPrivateV4(o: [number, number, number, number]): boolean {
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC-1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC-1918
  if (a === 192 && b === 168) return true; // RFC-1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18.0.0/15
  if (a >= 224) return true; // multicast 224/4 + reserved 240/4
  return false;
}

function isPrivateV6(h: number[]): boolean {
  const isZero = (n: number) => n === 0;
  if (h.every(isZero)) return true; // :: unspecified
  if (h.slice(0, 7).every(isZero) && h[7] === 1) return true; // ::1 loopback
  // IPv4-mapped ::ffff:0:0/96 and deprecated IPv4-compatible ::/96:
  // classify by the embedded IPv4 address.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0) {
    if (h[5] === 0xffff || h[5] === 0) {
      const v4: [number, number, number, number] = [
        (h[6]! >> 8) & 0xff,
        h[6]! & 0xff,
        (h[7]! >> 8) & 0xff,
        h[7]! & 0xff,
      ];
      return isPrivateV4(v4);
    }
  }
  if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((h[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** True if the IP literal is loopback / RFC-1918 / link-local / otherwise non-public. */
export function isPrivateIp(ip: string): boolean {
  const s = ip.trim().toLowerCase();
  if (s.includes(":")) {
    const v6 = parseIpv6(s);
    return v6 ? isPrivateV6(v6) : false;
  }
  const v4 = parseIpv4(s);
  return v4 ? isPrivateV4(v4) : false;
}

// ---------------------------------------------------------------------------
// Fetch with policy enforcement
// ---------------------------------------------------------------------------

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function parseHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw invalidArgs(`"${raw}" is not a valid URL.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw unsupportedScheme(raw);
  }
  return u;
}

async function assertPublicHost(
  url: URL,
  policy: FetchPolicy,
  lookup: LookupLike,
): Promise<void> {
  if (policy.allowPrivateEgress) return;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw fetchFailed(`DNS resolution failed for "${hostname}": ${msg}`);
  }
  if (addresses.length === 0) {
    throw fetchFailed(`DNS resolution failed for "${hostname}": no addresses`);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw fetchFailed(
        `Refusing to fetch "${hostname}": resolves to private/loopback/link-local address ${address}. ` +
          `Private-network egress is disabled by default (spec §8); restart the server with --allow-private-egress to allow it.`,
      );
    }
  }
}

async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    throw fetchFailed(
      `Response exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB cap (content-length: ${declared} bytes).`,
    );
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw fetchFailed(
          `Response exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB cap.`,
        );
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(buf);
}

/**
 * Fetch `url` per the given policy, following redirects manually so every hop
 * is re-checked against the scheme allowlist and the private-egress rule.
 */
export async function fetchPage(
  rawUrl: string,
  policy: FetchPolicy = DEFAULT_FETCH_POLICY,
  fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  lookupImpl: LookupLike = defaultLookup,
): Promise<FetchedPage> {
  let current = parseHttpUrl(rawUrl);
  const deadline = Date.now() + policy.timeoutMs;

  for (let hop = 0; ; hop++) {
    if (hop > policy.maxRedirects) {
      throw fetchFailed(
        `Too many redirects (more than ${policy.maxRedirects}) while fetching "${rawUrl}".`,
      );
    }
    await assertPublicHost(current, policy, lookupImpl);

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw fetchFailed(
        `Fetch of "${rawUrl}" timed out after ${policy.timeoutMs} ms.`,
      );
    }

    let res: Response;
    try {
      res = await fetchImpl(current.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(remaining),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw fetchFailed(
          `Fetch of "${rawUrl}" timed out after ${policy.timeoutMs} ms.`,
        );
      }
      throw fetchFailed(
        `Network error fetching "${current.href}": ${e.message ?? String(err)}`,
      );
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get("location");
      if (!location) {
        throw fetchFailed(
          `HTTP ${res.status} redirect from "${current.href}" has no Location header.`,
        );
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw fetchFailed(
          `Invalid redirect Location "${location}" from "${current.href}".`,
        );
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw unsupportedScheme(next.href);
      }
      current = next;
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      throw fetchFailed(`HTTP ${res.status} from "${current.href}".`);
    }

    const body = await readBodyCapped(res, policy.maxBytes);
    return {
      finalUrl: current.href,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body,
    };
  }
}

/** Type guard helper for tests. */
export function isGroundingError(err: unknown): err is GroundingError {
  return err instanceof Error && err.name === "GroundingError";
}
