// The outbound half of POST /lint, and the only place this service makes a
// request on a stranger's behalf.
//
// THAT IS THE WHOLE THREAT MODEL. A caller who can name a URL and see the
// response has, for one dollar-cent, rented our network position. Everything
// below exists so the position is worth nothing:
//
//   https only          plain http would let a caller probe unencrypted
//                       internal services and read what comes back
//   no private targets  loopback, RFC 1918, link-local, CGNAT, ULA — the
//                       addresses that only mean something from inside
//   no name targets     `localhost`, `*.internal`, `*.local`, bare hostnames
//                       with no dot: the split-horizon names of a private network
//   no redirects        `redirect: 'manual'`. A 302 is the classic bypass —
//                       the URL passes every check above and the redirect lands
//                       on 169.254.169.254. It is also a real finding for the
//                       seller, so it is reported rather than silently followed.
//   one request         no retry, no preflight, no second call
//   a hard timeout      a target that never answers cannot pin a Worker open
//   a byte cap          the response is read to 256 KB and no further
//
// WHAT THIS DOES NOT DEFEND, stated plainly rather than implied away: DNS
// REBINDING. The guard resolves nothing — a Worker has no DNS API — so a
// hostname whose A record points at 127.0.0.1, or one that answers a public
// address on the first lookup and a private one on the connect, is not caught
// here. Cloudflare's egress does not route to our own private ranges, which
// removes the usual prize; the honest statement is that this is a public-URL
// linter, and it should not be deployed anywhere its egress can see a private
// network. That limitation is in the README, not just in this comment.
//
// ------------------------------------------------------------------ the test gate
//
// LINT_UNSAFE_TARGETS relaxes the scheme and address rules so the suite can
// point /lint at a mock target on 127.0.0.1. It is OFF unless the var is
// exactly "1", anything unparseable reads as off, and no production deployment
// ever sets it. It is named to be alarming on purpose: a var called
// ALLOW_LOCAL would look like a feature.

import { MAX_BODY_BYTES } from './catalog.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 200;

/** Hostnames that are private by NAME rather than by address. */
const BLOCKED_SUFFIXES = ['.internal', '.local', '.localhost', '.home.arpa'];
const BLOCKED_NAMES = ['localhost'];

/** URLs longer than this are refused unread; no legitimate endpoint needs it. */
const MAX_URL_LENGTH = 2048;

export const unsafeTargetsAllowed = (env) => String(env?.LINT_UNSAFE_TARGETS ?? '') === '1';

/**
 * The timeout, in ms. Env-tunable so the suite can prove the timeout PATH in
 * under a second instead of ten, and clamped so a bad value cannot turn a
 * bounded wait into an unbounded one — or into an instant failure that would
 * make every lint report a timeout.
 */
export function timeoutMs(env) {
  const raw = Number(env?.LINT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  return Math.min(DEFAULT_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(raw)));
}

// ------------------------------------------------------------------ address rules

/** Dotted-quad → the four octets, or null if it is not one. */
function ipv4Octets(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : null;
}

/**
 * Is this dotted quad in a range that only means something from inside?
 *
 * Every range here is one that a public endpoint can never legitimately live
 * on, so blocking them costs a real caller nothing.
 */
function privateIpv4(octets) {
  const [a, b] = octets;
  if (a === 0) return '0.0.0.0/8 (this network)';
  if (a === 10) return '10.0.0.0/8 (RFC 1918 private)';
  if (a === 127) return '127.0.0.0/8 (loopback)';
  if (a === 169 && b === 254) return '169.254.0.0/16 (link-local — cloud metadata lives here)';
  if (a === 172 && b >= 16 && b <= 31) return '172.16.0.0/12 (RFC 1918 private)';
  if (a === 192 && b === 168) return '192.168.0.0/16 (RFC 1918 private)';
  if (a === 100 && b >= 64 && b <= 127) return '100.64.0.0/10 (carrier-grade NAT)';
  if (a === 192 && b === 0) return '192.0.0.0/24 (IETF protocol assignments)';
  if (a === 198 && (b === 18 || b === 19)) return '198.18.0.0/15 (benchmarking)';
  if (a >= 224) return '224.0.0.0/4 and above (multicast / reserved)';
  return null;
}

/**
 * The same question for an IPv6 literal.
 *
 * `new URL()` hands back the bracketed, lower-cased, compressed form, so the
 * comparisons below are against a normalised string rather than against
 * whatever the caller typed. IPv4-mapped addresses (`::ffff:127.0.0.1`) are
 * unwrapped first — they are the v6 spelling of a v4 address and must not slip
 * past the v4 rules by changing notation.
 */
function privateIpv6(host) {
  const addr = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!addr.includes(':')) return null;

  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) {
    const octets = ipv4Octets(mapped[1]);
    const why = octets && privateIpv4(octets);
    return why ? `an IPv4-mapped address in ${why}` : null;
  }
  // The hex form of the same thing, e.g. ::ffff:7f00:1.
  const mappedHex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const n = (parseInt(mappedHex[1], 16) << 16) | parseInt(mappedHex[2], 16);
    const octets = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const why = privateIpv4(octets);
    return why ? `an IPv4-mapped address in ${why}` : null;
  }

  if (addr === '::1') return '::1 (loopback)';
  if (addr === '::') return ':: (unspecified)';
  // fc00::/7 — unique local. The first byte is 0xfc or 0xfd.
  if (/^f[cd][0-9a-f]{0,2}:/.test(addr)) return 'fc00::/7 (unique local)';
  // fe80::/10 — link-local. The first 10 bits are 1111111010, i.e. fe8/fe9/fea/feb.
  if (/^fe[89ab][0-9a-f]?:/.test(addr)) return 'fe80::/10 (link-local)';
  if (/^ff[0-9a-f]{2}:/.test(addr)) return 'ff00::/8 (multicast)';
  return null;
}

/**
 * Validate a target URL. Returns { url } or { error, fix }.
 *
 * Exported so the suite can assert on the RULES directly, without a fetch —
 * every branch below has a test, and a guard whose branches are only reachable
 * through the network is a guard nobody has actually read.
 */
export function checkTargetUrl(raw, { unsafe = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: '`url` is required', fix: 'POST {"url": "https://your-endpoint.example.com/path"}' };
  }
  if (raw.length > MAX_URL_LENGTH) {
    return {
      error: `\`url\` is longer than ${MAX_URL_LENGTH} characters`,
      fix: 'Lint the endpoint URL itself. A URL this long is a query string, and the 402 does not depend on it.',
    };
  }

  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return {
      error: `\`url\` is not a valid absolute URL: ${raw.slice(0, 120)}`,
      fix: 'Include the scheme: "https://example.com/api/thing", not "example.com/api/thing".',
    };
  }

  if (url.protocol !== 'https:' && !unsafe) {
    return {
      error: `\`url\` must be https, not ${url.protocol.replace(':', '')}`,
      fix:
        'Lint the https URL. x402 payments carry a signed authorization in a request header, ' +
        'so an endpoint served over plain http is not one anybody should be paying — fix the ' +
        'TLS before you fix the envelope.',
    };
  }

  if (url.username || url.password) {
    return {
      error: '`url` carries credentials in the authority',
      fix: 'Remove the "user:pass@" part. x402 endpoints are authenticated by payment, not by basic auth.',
    };
  }

  const host = url.hostname.toLowerCase();

  if (!unsafe) {
    const octets = ipv4Octets(host);
    const why = octets ? privateIpv4(octets) : privateIpv6(host);
    if (why) {
      return {
        error: `\`url\` points at ${host}, which is in ${why}`,
        fix:
          'Lint a publicly reachable URL. This service refuses private and reserved addresses ' +
          'because a linter that fetches whatever it is told is a proxy into whatever network ' +
          'it runs in. To lint an endpoint that is not deployed yet, use POST /lint/envelope ' +
          'and paste the response instead — it runs the same checks with no outbound request.',
      };
    }
    if (BLOCKED_NAMES.includes(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
      return {
        error: `\`url\` points at "${host}", which is a private-network name`,
        fix:
          'Lint a publicly resolvable hostname. For a local or staging endpoint, use POST ' +
          '/lint/envelope and paste the status, headers and body — same checks, no fetch.',
      };
    }
    // The bare-hostname rule is about NAMES — `https://redis/`, the container
    // network name people paste by accident. An IPv6 literal has no dots and is
    // not a name, and `new URL()` hands it back bracketed; without this it was
    // refused as "only resolves inside a private network", which is both wrong
    // and confusing advice for a public address like 2606:4700:4700::1111.
    const isIpLiteral = host.startsWith('[') || octets !== null;
    if (!isIpLiteral && !host.includes('.')) {
      return {
        error: `\`url\` points at the bare hostname "${host}", which only resolves inside a private network`,
        fix:
          'Use the fully qualified public hostname. For an internal endpoint, use POST ' +
          '/lint/envelope and paste the response instead.',
      };
    }
  }

  return { url };
}

// ------------------------------------------------------------------ the fetch

/**
 * ONE unauthenticated request to the target, with no payment headers.
 *
 * The point of the call is to see what an unpaid caller sees, so it must carry
 * nothing that could be mistaken for payment or for an identity — no X-PAYMENT,
 * no PAYMENT-SIGNATURE, no cookie, no authorization. A POST sends `{}`, which
 * is the smallest body a JSON endpoint will accept and, more importantly, is
 * never mistaken for real work: a paid endpoint that answers 402 will never read it.
 *
 * Returns { ok: true, input } where `input` is what lint() takes, or
 * { ok: false, error, fix }.
 */
export async function fetchTarget(rawUrl, method, env) {
  const unsafe = unsafeTargetsAllowed(env);
  const checked = checkTargetUrl(rawUrl, { unsafe });
  if (checked.error) return { ok: false, ...checked };

  const url = checked.url;
  const verb = String(method || 'POST').toUpperCase();
  if (verb !== 'POST' && verb !== 'GET') {
    return {
      error: `\`method\` must be "POST" or "GET", not ${JSON.stringify(method)}`,
      fix: 'Omit `method` to use POST, which is what most paid x402 endpoints take.',
      ok: false,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(env));
  let res;
  try {
    res = await fetch(url.href, {
      method: verb,
      // MANUAL, not 'follow'. A redirect is both a security bypass (the checked
      // URL passes, the redirect target does not) and a genuine finding for the
      // seller, so it is surfaced as HTTP_REDIRECT rather than chased.
      redirect: 'manual',
      headers: {
        accept: 'application/json, */*',
        'user-agent': '10x402-lint/0.1 (+https://10x402.com)',
        ...(verb === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      body: verb === 'POST' ? '{}' : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      error: aborted
        ? `the target did not answer within ${timeoutMs(env) / 1000}s`
        : `could not reach ${url.host}: ${String(err?.message || err).slice(0, 160)}`,
      fix: aborted
        ? 'A paid endpoint must answer its 402 fast — the envelope is built from static data ' +
          'and needs no work at all. If yours is slow, the 402 path is probably doing the work ' +
          'BEFORE checking for payment, which also means you are doing unpaid work for every prober.'
        : 'Check the hostname, the TLS certificate and that the route exists. If the endpoint ' +
          'is not deployed yet, use POST /lint/envelope and paste the response instead.',
    };
  } finally {
    clearTimeout(timer);
  }

  // --- read, capped -----------------------------------------------------
  //
  // Streamed and counted rather than buffered whole: `res.arrayBuffer()` on a
  // hostile target would read as much as it cared to send before the cap could
  // be applied. This stops pulling at the cap and closes the stream.
  const { text, truncated } = await readCapped(res, MAX_BODY_BYTES);

  const headers = {};
  for (const [key, value] of res.headers) headers[key.toLowerCase()] = value;

  return {
    ok: true,
    input: {
      status: res.status,
      headers,
      body: text,
      url: url.href,
      method: verb,
      redirectedTo: res.status >= 300 && res.status < 400 ? res.headers.get('location') : null,
      truncated,
    },
  };
}

/** Read at most `max` bytes of a response body, then stop. */
async function readCapped(res, max) {
  const body = res.body;
  if (!body) return { text: '', truncated: false };

  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > max) {
        chunks.push(value.subarray(0, max - size));
        size = max;
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // A stream that dies mid-read still yields whatever arrived; a partial body
    // lints as a JSON parse failure, which is an honest report of what a client
    // would also have seen.
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }

  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder('utf-8').decode(joined), truncated };
}
