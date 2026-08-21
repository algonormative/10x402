// POST /presence — where a live x402 resource actually stands with the
// registries, from FREE public reads only.
//
// /lint answers "is the declaration right"; this answers the question the
// stuck-seller threads actually open with: "I settle payments — why can nobody
// find me?" Three observations, each from a source that costs nothing:
//
//   bazaar   the CDP discovery catalog, paged in full (limit=1000, ~16 pages
//            observed at ~15k records). The catalog's own `?payTo=` filter is
//            documented-but-inert (first-party corrected, 2026-08-20), so the
//            honest read IS the full scan.
//   x402scan the explorer's public, unauthenticated tRPC surface — the same
//            calls its own web UI makes. Its SOLD API (/api/x402/*, x402-paid
//            at $0.01/call) is the sturdier upgrade path, deliberately
//            deferred by owner decision 2026-08-21: no runtime wallet in this
//            Worker yet. The evidence field says which surface was read.
//   chain    Blockscout's public tokentx for the payTo — has anything ever
//            actually settled here, and when most recently.
//
// VERDICTS DECLINE, NEVER GUESS. A read that fails or times out yields
// `unknown` with the failure named, not a `not_found` — being unable to see a
// registry is not evidence about the registry. This is the same decline
// discipline as the lint engine's context-dependent checks.
//
// PRIVACY: same schema as /lint — nothing about the target (URL, payTo,
// report) is ever written to D1; telemetry records the endpoint id and counts.

import { fetchTarget, timeoutMs } from './fetch-target.js';
import { base64Text, PAYMENT_REQUIRED_HEADER } from './envelope.js';

// Env-overridable bases: production defaults, mock servers in tests. Tests
// never touch the live registries (house rule), so the seam is the base URL.
export const bazaarBase = (env) => String(env?.PRESENCE_BAZAAR_BASE || 'https://api.cdp.coinbase.com');
export const scanBase = (env) => String(env?.PRESENCE_SCAN_BASE || 'https://www.x402scan.com');
export const chainBase = (env) => String(env?.PRESENCE_CHAIN_BASE || 'https://base.blockscout.com');

const BAZAAR_PAGE = 1000;
// The catalog was ~15k records when this was written. A runaway pagination
// (registry bug, moved endpoint answering 200 with something else) must not
// hold a paid request open forever, so the scan is bounded — generously, at
// several times the observed catalog — and a hit of the bound is reported as
// `unknown` with the bound named, never as a completed scan.
const BAZAAR_MAX_PAGES = 64;

/** One bounded GET returning parsed JSON, or a named failure. */
async function readJson(url, env) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(env));
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': '10x402-presence/0.1 (+https://10x402.com)' },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, why: `answered ${res.status}` };
    return { ok: true, json: await res.json() };
  } catch (err) {
    return { ok: false, why: err?.name === 'AbortError' ? 'timed out' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * payTo addresses and the declared resource url, pulled from whichever
 * envelopes the 402 carries. Defensive throughout: a malformed envelope
 * yields fewer identities, not a throw — /lint is the product that reports
 * WHY it is malformed, and the response points there.
 */
export function extractIdentity(input) {
  const payTo = new Set();
  let declaredUrl = null;

  const headers = input.headers || {};
  const headerValue = headers[PAYMENT_REQUIRED_HEADER];
  if (typeof headerValue === 'string') {
    try {
      const v2 = JSON.parse(base64Text(headerValue.trim()));
      for (const accept of Array.isArray(v2?.accepts) ? v2.accepts : []) {
        if (typeof accept?.payTo === 'string' && accept.payTo) payTo.add(accept.payTo);
      }
      const url = v2?.resource?.url;
      if (typeof url === 'string' && url) declaredUrl = url;
    } catch {
      /* /lint reports why; here it is simply not an identity source */
    }
  }

  try {
    const v1 = JSON.parse(input.body || '');
    for (const accept of Array.isArray(v1?.accepts) ? v1.accepts : []) {
      if (typeof accept?.payTo === 'string' && accept.payTo) payTo.add(accept.payTo);
      if (!declaredUrl && typeof accept?.resource === 'string' && accept.resource) declaredUrl = accept.resource;
    }
  } catch {
    /* same */
  }

  return { payTo: [...payTo], declaredUrl };
}

/** URL equality for catalog matching: scheme+host case-insensitive, one trailing slash forgiven. */
const normalizeUrl = (raw) => {
  try {
    const u = new URL(String(raw));
    u.hash = '';
    return `${u.origin.toLowerCase()}${u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch {
    return String(raw);
  }
};

/**
 * The full-catalog Bazaar scan. Pages are fetched SEQUENTIALLY on purpose:
 * the reads are cheap, the total is bounded, and a polite client of a free
 * public API does not fan out sixteen concurrent requests against it.
 */
async function observeBazaar(env, targetUrls, payToSet) {
  const matches = [];
  let payToMatches = 0;
  let total = null;
  const wanted = new Set(targetUrls.map(normalizeUrl));
  const payToLower = new Set([...payToSet].map((a) => a.toLowerCase()));

  for (let page = 0; page < BAZAAR_MAX_PAGES; page++) {
    const offset = page * BAZAAR_PAGE;
    const read = await readJson(
      `${bazaarBase(env)}/platform/v2/x402/discovery/resources?limit=${BAZAAR_PAGE}&offset=${offset}`,
      env
    );
    if (!read.ok) return { ok: false, why: `catalog page at offset ${offset} ${read.why}` };
    const { items, pagination } = read.json || {};
    if (!Array.isArray(items) || !pagination) return { ok: false, why: 'catalog page had an unexpected shape' };
    total = pagination.total;

    for (const item of items) {
      const url = typeof item?.resource === 'string' ? item.resource : item?.resource?.url;
      const accepts = Array.isArray(item?.accepts) ? item.accepts : [];
      const itemPayTos = accepts.map((a) => String(a?.payTo || '').toLowerCase());
      const payToHit = itemPayTos.some((a) => payToLower.has(a));
      if (payToHit) payToMatches++;
      if (url && wanted.has(normalizeUrl(url))) {
        matches.push({
          resource: url,
          x402Version: item.x402Version ?? null,
          lastUpdated: item.lastUpdated ?? null,
          payTo: accepts[0]?.payTo ?? null,
        });
      }
    }
    if (offset + BAZAAR_PAGE >= total) return { ok: true, total, matches, payToMatches };
  }
  return { ok: false, why: `catalog reported more than ${BAZAAR_MAX_PAGES * BAZAAR_PAGE} records — scan bound hit, result would be partial` };
}

/** x402scan, by payTo, via the explorer's own public tRPC surface. */
async function observeScan(env, payToList) {
  for (const payTo of payToList) {
    const input = encodeURIComponent(JSON.stringify({ json: payTo }));
    const read = await readJson(
      `${scanBase(env)}/api/trpc/public.resources.getResourceByAddress?input=${input}`,
      env
    );
    if (!read.ok) return { ok: false, why: `explorer lookup ${read.why}` };
    const record = read.json?.result?.data?.json;
    if (record && typeof record === 'object') {
      return {
        ok: true,
        match: {
          resource: record.resource ?? null,
          method: record.method ?? null,
          x402Version: record.x402Version ?? null,
          lastUpdated: record.lastUpdated ?? null,
        },
      };
    }
  }
  return { ok: true, match: null };
}

/** Blockscout tokentx: has anything settled to this payTo, and how recently. */
async function observeChain(env, payToList) {
  const payTo = payToList[0];
  const url = `${chainBase(env)}/api?module=account&action=tokentx&address=${payTo}&page=1&offset=25&sort=desc`;
  let read = await readJson(url, env);
  // A 429 gets ONE retry after a beat: the very first production presence call
  // hit one — Cloudflare egress IPs are heavily shared, so explorer rate
  // limits are an operating condition here, not an anomaly. One retry, not a
  // loop: a host that is rate-limiting us twice is telling us something, and
  // the honest verdict for it is `unknown`.
  if (!read.ok && read.why === 'answered 429') {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    read = await readJson(url, env);
  }
  if (!read.ok) return { ok: false, why: `chain explorer ${read.why}` };
  const rows = Array.isArray(read.json?.result) ? read.json.result : [];
  const incoming = rows.filter((t) => String(t?.to || '').toLowerCase() === payTo.toLowerCase());
  const latest = incoming[0] ?? null;
  return {
    ok: true,
    transfers: incoming.length,
    window: rows.length >= 25 ? 'the 25 most recent transfers' : 'all transfers',
    latest: latest
      ? {
          value: latest.value,
          tokenSymbol: latest.tokenSymbol,
          timeStamp: latest.timeStamp,
          hash: latest.hash,
          from: latest.from,
          to: latest.to,
          contractAddress: latest.contractAddress,
        }
      : null,
  };
}

const FIXES = {
  bazaar:
    'Bazaar rows are written by SETTLEMENT, per resource: the catalog lists a resource after a ' +
    'real payment settles against that exact URL with a valid declaration (extensions.bazaar in ' +
    'the v2 header — POST /lint finds what blocks it). One settled call per endpoint, then allow ' +
    'minutes-scale crawl latency. A listing is never written by deploying, only by settling.',
  x402scan:
    'Register at https://www.x402scan.com/resources/register — it accepts an openapi.json import ' +
    'and validates your resource against the live discovery data.',
  chain:
    'No USDC transfers to this payTo were observed on Base. Either nothing has ever settled here, ' +
    'or settlement pays a different address than the one your 402 declares — compare the payTo in ' +
    'your envelope against the wallet you expect to be paid at.',
};

/**
 * Observations → report. PURE, and exported for exactly one caller besides
 * runPresence: the envelope sample (worker/envelope.js runSample), which runs
 * it over the frozen PRESENCE_CONTROL capture so the published output example
 * is this real code over real observations with no network at build time.
 */
export function assemblePresence({ target, identity, bazaar, scan, chain }) {
  const registries = {};

  registries.bazaar = !bazaar.ok
    ? { verdict: 'unknown', why: bazaar.why, evidence: null, fix: null }
    : bazaar.matches.length > 0
      ? {
          verdict: 'listed',
          evidence: {
            source: 'CDP discovery catalog, scanned in full',
            catalog_total: bazaar.total,
            matches: bazaar.matches,
            resources_on_same_payTo: bazaar.payToMatches,
          },
          fix: null,
        }
      : {
          verdict: 'not_found',
          evidence: {
            source: 'CDP discovery catalog, scanned in full',
            catalog_total: bazaar.total,
            resources_on_same_payTo: bazaar.payToMatches,
          },
          fix: FIXES.bazaar,
        };

  registries.x402scan = !scan.ok
    ? { verdict: 'unknown', why: scan.why, evidence: null, fix: null }
    : scan.match
      ? {
          verdict: 'listed',
          evidence: { source: 'x402scan public explorer API, looked up by payTo', match: scan.match },
          fix: null,
        }
      : {
          verdict: 'not_found',
          evidence: { source: 'x402scan public explorer API, looked up by payTo' },
          fix: FIXES.x402scan,
        };

  const onchain = !chain.ok
    ? { verdict: 'unknown', why: chain.why, evidence: null, fix: null }
    : chain.transfers > 0
      ? {
          verdict: 'active',
          evidence: {
            source: 'Base via Blockscout tokentx',
            incoming_transfers_in_window: chain.transfers,
            window: chain.window,
            latest: chain.latest,
          },
          fix: null,
        }
      : { verdict: 'none_seen', evidence: { source: 'Base via Blockscout tokentx' }, fix: FIXES.chain };

  const verdicts = Object.values(registries).map((r) => r.verdict);
  return {
    target,
    identity,
    registries,
    onchain,
    summary: {
      listed: verdicts.filter((v) => v === 'listed').length,
      of: verdicts.length,
      unknown: verdicts.filter((v) => v === 'unknown').length,
      // null, not false, when the chain could not be read: `false` is a claim
      // ("nothing has settled here") and an unreadable explorer cannot back it.
      settlement_seen: onchain.verdict === 'unknown' ? null : onchain.verdict === 'active',
    },
    notes: [
      'Verdicts are observations of public read surfaces at one moment, not guarantees. An ' +
        '`unknown` means the surface could not be read and says nothing about the listing.',
      'x402-list (manual registry) is not machine-checkable and is not covered here.',
    ],
  };
}

/** The route handler: fetch the 402, extract identity, observe, assemble. */
export async function runPresence(body, env) {
  if (body.url === undefined) {
    return {
      error: '`url` is required',
      fix: 'POST {"url": "https://your-endpoint.example.com/path"} — the live x402 resource whose registry presence you want checked.',
    };
  }

  const fetched = await fetchTarget(body.url, body.method, env);
  if (!fetched.ok) return { error: fetched.error, fix: fetched.fix };
  const input = fetched.input;

  const identity = extractIdentity(input);
  if (identity.payTo.length === 0) {
    return {
      error: `the response from ${input.url} carries no readable payTo in either envelope`,
      fix:
        'Presence is looked up by the payTo and resource URL your 402 declares, so a readable ' +
        'envelope is the precondition. POST /lint on the same URL reports exactly what is wrong ' +
        'with the envelope, with a fix per finding.',
    };
  }

  // The declared URL and the probed URL are BOTH searched for: a catalog row
  // written from a slightly different declaration (trailing slash, apex vs
  // www) is still this seller's listing, and finding it under the other
  // spelling is a more useful answer than a blind not_found.
  const targetUrls = [input.url, ...(identity.declaredUrl ? [identity.declaredUrl] : [])];

  const payToSet = new Set(identity.payTo);
  const [bazaar, scan, chain] = await Promise.all([
    observeBazaar(env, targetUrls, payToSet),
    observeScan(env, identity.payTo),
    observeChain(env, identity.payTo),
  ]);

  return assemblePresence({
    target: { url: input.url, method: input.method, status: input.status },
    identity,
    bazaar,
    scan,
    chain,
  });
}
