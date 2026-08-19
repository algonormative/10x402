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

/**
 * The ports a public x402 endpoint may be on.
 *
 * WITHOUT THIS THE SERVICE IS A PORT SCANNER. A caller who can name
 * `https://<any-host>:<any-port>/` and read the answer learns, one cent at a
 * time, which ports are open on a host they do not control — the response text
 * distinguishes a refused connection from a timeout, and that difference IS the
 * scan result. Restricting to the two ports HTTPS is actually served on removes
 * the oracle rather than trying to make its output uninformative; not quoting
 * the transport error (see `unreachable`) is the belt to this braces.
 *
 * The cost to a real caller is nil: an x402 endpoint people are meant to pay is
 * on 443. 8443 is here because it is the one alternate that appears on real
 * staging deployments, and refusing it would be refusing a customer.
 */
const ALLOWED_PORTS = ['', '443', '8443'];

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

  // 64:ff9b::/96 and 64:ff9b:1::/48 — NAT64. These EMBED an IPv4 address and a
  // NAT64 gateway translates them back to it, so `64:ff9b::7f00:1` is a way of
  // writing 127.0.0.1 that none of the rules above would have caught. Whether
  // the surrounding network has such a gateway is not knowable from here, which
  // is exactly why the whole range is refused rather than decoded.
  if (/^64:ff9b(:|$)/.test(addr)) return '64:ff9b::/96 (NAT64 — it embeds an IPv4 address)';

  // ::/96 — IPv4-COMPATIBLE, e.g. ::7f00:1 and ::127.0.0.1, both of which are
  // 127.0.0.1. Deprecated by RFC 4291 and nothing public lives there, so the
  // range goes rather than only the private addresses inside it. `::ffff:…`
  // (IPv4-MAPPED, a different range) is handled above and has already returned.
  if (/^::(?:[0-9a-f]{1,4}:)?[0-9a-f.]+$/.test(addr)) {
    return '::/96 (IPv4-compatible — a deprecated way of writing an IPv4 address)';
  }
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

  // A TRAILING DOT IS THE SAME NAME. `localhost.` is the fully qualified form
  // of `localhost` and resolves identically, but it matched neither
  // BLOCKED_NAMES nor any suffix, and `127.0.0.1.` split into five parts so it
  // was not read as a dotted quad either. One character walked straight past
  // every name rule below. Normalised here, before any of them.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');

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

    // LAST, so an address that is refused for WHAT it is says so rather than
    // reporting the port it happened to be on — `https://127.0.0.1:8787/` is
    // better answered "that is loopback" than "that is not port 443". The
    // ordering costs nothing: every branch here refuses before any connection
    // is attempted, so the oracle is closed by all of them equally.
    if (!ALLOWED_PORTS.includes(url.port)) {
      return {
        error: `\`url\` names port ${url.port}, and only 443 and 8443 are allowed`,
        fix:
          'Lint the endpoint on its https port. This service refuses other ports because a ' +
          'linter that will connect anywhere and report what happened is a port scanner rented ' +
          'by the cent — the difference between "refused" and "timed out" IS the scan result. ' +
          'To lint an endpoint on another port, use POST /lint/envelope and paste the status, ' +
          'headers and body: the same checks with no outbound request.',
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

  // ONE DEADLINE FOR THE WHOLE OPERATION, headers AND body.
  //
  // The timer used to be cleared the moment `fetch` resolved, which is when the
  // response HEADERS arrive — so the body read that follows ran with no bound
  // at all. A target that answered instantly and then dribbled one byte every
  // few seconds held a Worker open far past the ten-second timeout: measured at
  // 17x it before this changed. That is slow loris, and the guard was pointed
  // at the wrong half of the request.
  //
  // The same controller is passed through the read, so the abort cancels the
  // reader, and the timer is cleared only once readCapped has returned.
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
    clearTimeout(timer);
    return {
      ok: false,
      ...(err?.name === 'AbortError' ? timedOut(env) : unreachable(url)),
    };
  }

  // --- read, capped and on the SAME clock -------------------------------
  //
  // Streamed and counted rather than buffered whole: `res.arrayBuffer()` on a
  // hostile target would read as much as it cared to send before the cap could
  // be applied. This stops pulling at the cap and closes the stream — and now
  // also stops when the deadline set before the fetch expires.
  let read;
  try {
    read = await readCapped(res, MAX_BODY_BYTES, controller.signal);
  } finally {
    clearTimeout(timer);
  }
  // A read the DEADLINE ended is a timeout, reported as one. It is distinct
  // from a stream that merely died: there we keep the partial body, because a
  // partial body lints as a JSON parse failure, which is an honest report of
  // what a client would also have seen. Here we never saw the whole response
  // and must not pretend a truncated read is a finding about the envelope.
  if (read.aborted) return { ok: false, ...timedOut(env, 'finish sending its response') };
  const { text, truncated } = read;

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

/** The two transport refusals, written once so they cannot drift apart. */
const timedOut = (env, what = 'answer') => ({
  error: `the target did not ${what} within ${timeoutMs(env) / 1000}s`,
  fix:
    'A paid endpoint must answer its 402 fast — the envelope is built from static data ' +
    'and needs no work at all. If yours is slow, the 402 path is probably doing the work ' +
    'BEFORE checking for payment, which also means you are doing unpaid work for every prober.',
});

/**
 * Could not connect.
 *
 * THE UNDERLYING ERROR IS DELIBERATELY NOT QUOTED. It distinguishes a refused
 * connection from a DNS failure from a TLS error, and a caller who can name a
 * URL and read that distinction has a port scanner: the response text is the
 * oracle. The port allowlist above is what mostly closes this, and not echoing
 * the transport error is the rest of it.
 */
const unreachable = (url) => ({
  error: `could not reach ${url.host}`,
  fix:
    'Check the hostname, the TLS certificate and that the route exists on the port you named. ' +
    'If the endpoint is not deployed yet, use POST /lint/envelope and paste the response ' +
    'instead — the same checks, with no outbound request.',
});

/**
 * Read at most `max` bytes of a response body, then stop.
 *
 * `signal` is the SAME deadline the fetch ran under, so a target that answers
 * its headers instantly and then dribbles cannot outlive the timeout. Returns
 * `aborted: true` when the deadline is what ended the read, which the caller
 * reports as a timeout rather than as a truncated body.
 */
async function readCapped(res, max, signal) {
  const body = res.body;
  // A response with no body stream reached AFTER the deadline fired is still a
  // timeout — every other return path derives this from the signal, and
  // hardcoding false here would report it as a clean empty-body lint.
  if (!body) return { text: '', truncated: false, aborted: signal?.aborted === true };

  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  // HOW THE LOOP ENDED, recorded as it ends rather than inferred afterwards
  // from signal.aborted. A read that finishes in the same tick the timer fires
  // would have `signal.aborted` true against a body we received in full, and
  // reporting that as a timeout would turn a rare race into a wrong answer for
  // a perfectly good endpoint. Only the abort path sets this.
  let endedByDeadline = false;
  // The reader is cancelled from the abort rather than only polled, so a read
  // that is parked waiting for a byte that never comes is woken rather than
  // waiting for a chunk to check a flag against.
  const onAbort = () => {
    endedByDeadline = true;
    reader.cancel().catch(() => {});
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
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
    signal?.removeEventListener('abort', onAbort);
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
  return {
    text: new TextDecoder('utf-8').decode(joined),
    truncated,
    // A body stopped at the CAP is not a timeout: we have what we asked for and
    // the report says it was clipped. Only a deadline that ended the read is.
    aborted: endedByDeadline && !truncated,
  };
}
