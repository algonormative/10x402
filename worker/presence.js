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
//   chain    the payTo's own chain, chosen by ADDRESS FAMILY. A 0x address is
//            read through Blockscout's public tokentx — has anything ever
//            actually settled here, and when most recently. A base58 address is
//            read through Solana's public JSON-RPC — has this address done
//            anything on chain at all, and when most recently. THE TWO LEGS
//            MEASURE DIFFERENT THINGS, and the report says which: see
//            observeChainSvm and assembleSvmChain, where the difference is the
//            whole of the design.
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
// The Solana leg's base is the whole RPC ENDPOINT, not a host to hang a path
// off: JSON-RPC posts every method to the same URL. Keyless, like the other
// three — api.mainnet-beta.solana.com is rate-limited rather than gated, which
// is exactly the trade the rest of this file already makes.
export const solanaBase = (env) => String(env?.PRESENCE_SOLANA_BASE || 'https://api.mainnet-beta.solana.com');

const BAZAAR_PAGE = 1000;
// The catalog was ~15k records when this was written. A runaway pagination
// (registry bug, moved endpoint answering 200 with something else) must not
// hold a paid request open forever, so the scan is bounded — generously, at
// several times the observed catalog — and a hit of the bound is reported as
// `unknown` with the bound named, never as a completed scan.
const BAZAAR_MAX_PAGES = 64;

// How many signatures the Solana leg asks for. The same 25 the EVM leg asks
// Blockscout for, so the two windows are the same size and the report's `window`
// string means the same kind of thing on both.
const SVM_SIGNATURE_LIMIT = 25;

/**
 * A 429 gets ONE retry after this pause, on EITHER chain leg.
 *
 * The very first production presence call hit one — Cloudflare egress IPs are
 * heavily shared, so explorer and public-RPC rate limits are an operating
 * condition here, not an anomaly. One retry, not a loop: a host that is
 * rate-limiting us twice is telling us something, and the honest verdict for
 * that is `unknown`.
 */
const RATE_LIMIT_PAUSE_MS = 1200;

/** Re-run `again` once, after a beat, if `read` was rate-limited. */
async function retryOn429(read, again) {
  if (read.ok || read.why !== 'answered 429') return read;
  await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_PAUSE_MS));
  return again();
}

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
 * One bounded JSON-RPC POST returning the parsed envelope, or a named failure.
 *
 * A SEPARATE FUNCTION RATHER THAN A FLAG ON readJson, which is GET-shaped
 * throughout: no body, no content-type, and a failure vocabulary ("answered
 * 404") that belongs to a REST surface. JSON-RPC answers 200 to a failure and
 * puts the fault in the body, so the two need different readings of the same
 * status code — bending one into the other would hide exactly that difference.
 * The user-agent is the same one every other read here sends, because a rate
 * limiter that decides to throttle us should be looking at one identity.
 */
async function rpcPost(url, payload, env) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(env));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': '10x402-presence/0.1 (+https://10x402.com)',
      },
      body: JSON.stringify(payload),
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
 * A 0x-prefixed 20-byte EVM address, and a base58 Solana address.
 *
 * MIRRORED FROM worker/lint.js — its ADDRESS_RE and SVM_ADDRESS_RE, which took
 * them byte-identical from x402@1.2.0's own EvmAddressRegex and SvmAddressRegex
 * (dist/esm/chunk-V3RMM5AE.mjs:383 and :361). lint.js does not export them, and
 * exporting a linter internal purely to spare two lines here would couple this
 * module to the check catalogue's guts; the copy is deliberate, and this comment
 * is the link between the two places.
 *
 * THEY CANNOT BOTH MATCH. Base58 excludes `0`, so nothing beginning `0x` is ever
 * a Solana address, and the dispatch below needs no tie-break.
 */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SVM_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Which chain family a payTo belongs to, from the ADDRESS SHAPE alone.
 *
 * NOT from the declared network string, and the reason is what this product is
 * for: the declaration is the thing under examination. A seller whose `network`
 * is misspelled is precisely who buys this report, and dispatching on that field
 * would read the wrong chain for the caller it matters most to. The address is
 * what we look the identity up BY, so the address is what chooses the reader.
 *
 * @returns {'evm'|'svm'|'unknown'}
 */
export function payToFamily(payTo) {
  if (typeof payTo !== 'string') return 'unknown';
  if (EVM_ADDRESS_RE.test(payTo)) return 'evm';
  if (SVM_ADDRESS_RE.test(payTo)) return 'svm';
  return 'unknown';
}

/** UNIX seconds → an ISO string, or null when there is no usable timestamp. */
const isoSeconds = (seconds) => (Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null);

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

/**
 * The chain leg, dispatched on the payTo's address family.
 *
 * WHAT THIS FIXES. There used to be one leg, hardcoded to Blockscout, which
 * lowercase-compared 0x addresses. A Solana seller's base58 payTo went into
 * `address=` anyway, the explorer answered with nothing that matched, and the
 * empty read rendered as `none_seen` — "no USDC transfers to this payTo were
 * observed on Base" — about a wallet that was never on Base. A confident wrong
 * claim, produced by the endpoint whose entire job is evidence.
 *
 * A family with no reader here is `ok: false` with the reason named, which
 * assembles into the honest `unknown`: the same decline the registry legs make
 * when a surface cannot be read, and for the same reason. We did not look, so we
 * know nothing — and `none_seen` would be a claim about a chain never queried.
 *
 * STILL THE FIRST payTo ONLY, as before. An envelope declaring one address per
 * chain would want a reading per chain, and that is a bigger answer than this
 * field can hold.
 */
async function observeChain(env, payToList) {
  const payTo = payToList[0];
  const family = payToFamily(payTo);
  if (family === 'evm') return observeChainEvm(env, payTo);
  if (family === 'svm') return observeChainSvm(env, payTo);
  return { ok: false, why: 'no chain reader for this address family' };
}

/** Blockscout tokentx: has anything settled to this payTo, and how recently. */
async function observeChainEvm(env, payTo) {
  const url = `${chainBase(env)}/api?module=account&action=tokentx&address=${payTo}&page=1&offset=25&sort=desc`;
  const once = () => readJson(url, env);
  const read = await retryOn429(await once(), once);
  if (!read.ok) return { ok: false, why: `chain explorer ${read.why}` };
  const rows = Array.isArray(read.json?.result) ? read.json.result : [];
  const incoming = rows.filter((t) => String(t?.to || '').toLowerCase() === payTo.toLowerCase());
  const latest = incoming[0] ?? null;
  return {
    ok: true,
    family: 'evm',
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

/**
 * Solana, via the public JSON-RPC `getSignaturesForAddress`.
 *
 * WHAT THIS MEASURES, AND WHAT IT CANNOT. There is no Solana analogue of
 * Blockscout's tokentx on a keyless public endpoint. Signatures are
 * TRANSACTIONS THAT MENTION THE ADDRESS — in any role and either direction: fee
 * payer, signer, or merely an account an instruction touched. So this leg
 * answers "is this address alive on chain, and when was it last used", and it
 * must never be reported as "money arrived here". Nothing in what comes back
 * carries a counterparty, a token or an amount, so the evidence object is shaped
 * differently from the EVM leg's and none of those words appear in it.
 *
 * AN ERRORED SIGNATURE STILL COUNTS. A transaction that failed on chain was
 * still built, signed, submitted and paid for by someone, so it is evidence the
 * address is in use — which is the whole of what this leg claims. The failures
 * are counted BESIDE the total rather than subtracted from it, so a reader can
 * see how much of the activity did not land without the count quietly changing
 * meaning.
 */
async function observeChainSvm(env, payTo) {
  const url = solanaBase(env);
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getSignaturesForAddress',
    params: [payTo, { limit: SVM_SIGNATURE_LIMIT }],
  };
  const once = () => rpcPost(url, payload, env);
  const read = await retryOn429(await once(), once);
  if (!read.ok) return { ok: false, why: `Solana RPC ${read.why}` };

  // JSON-RPC PUTS FAILURE INSIDE A 200: a bad address, a method the node has
  // disabled, or a node under load all come back as `error` on an OK status. An
  // errored envelope is a read that did not happen, so it declines like any
  // other unreadable surface rather than being counted as zero activity.
  if (read.json?.error) {
    const detail = typeof read.json.error?.message === 'string' ? read.json.error.message : 'no message given';
    return { ok: false, why: `Solana RPC answered a JSON-RPC error: ${detail}` };
  }
  const rows = read.json?.result;
  if (!Array.isArray(rows)) return { ok: false, why: 'Solana RPC returned an unexpected shape' };

  // NEWEST FIRST is the RPC's own ordering — getSignaturesForAddress walks
  // backwards from the most recent confirmed signature — which is the same
  // ordering the EVM leg asks Blockscout for with `sort=desc`. Both legs take
  // row zero as "latest" for that reason, and neither sorts a second time.
  const latest = rows[0] ?? null;
  return {
    ok: true,
    family: 'svm',
    signatures: rows.length,
    failed: rows.filter((row) => row?.err != null).length,
    window:
      rows.length >= SVM_SIGNATURE_LIMIT ? `the ${SVM_SIGNATURE_LIMIT} most recent signatures` : 'all signatures',
    latest: latest
      ? {
          signature: latest.signature ?? null,
          slot: latest.slot ?? null,
          // `blockTime` is UNIX SECONDS or null — a node with no block time for
          // that slot returns null, and null is reported as null rather than as
          // an epoch date. Renamed on the way out because it is CONVERTED here;
          // the raw field name would advertise a number that is no longer there.
          block_time: isoSeconds(latest.blockTime),
          confirmation_status: latest.confirmationStatus ?? null,
          failed: latest.err != null,
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
  // A SEPARATE FIX, not the one above with the nouns swapped. The EVM text says
  // "nothing has settled here", which this leg has no standing to say — the most
  // it saw was that the address has not been used at all.
  chain_svm:
    'No transactions involving this payTo were seen on Solana. Either this address has never been ' +
    'used on chain, or settlement pays a different address than the one your 402 declares — ' +
    'compare the payTo in your envelope against the wallet you expect to be paid at. Note what ' +
    'this leg reads: SIGNATURES, not incoming payments. It can tell you an address is unused; it ' +
    'can never tell you a payment arrived.',
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

  // TWO CHAIN LEGS THAT MEASURE DIFFERENT THINGS, so two assemblies rather than
  // one with the nouns parameterised. The EVM branch is selected by the ABSENCE
  // of `family` as well as by `family: 'evm'`, because worker/presence-control.js
  // is a real capture frozen before the field existed and the published output
  // sample is assembled from it.
  const onchain = !chain.ok
    ? { verdict: 'unknown', why: chain.why, evidence: null, fix: null }
    : chain.family === 'svm'
      ? assembleSvmChain(chain)
      : assembleEvmChain(chain);

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
      //
      // AND null ON THE SOLANA LEG WHATEVER IT SAW — the same rule from the
      // other side. That leg counted signatures, so a busy address proves the
      // address is in use and says nothing at all about money arriving; `true`
      // would be an answer to a question this leg never asked, and `false` would
      // be the same mistake on a quiet address. The verdict and its evidence
      // carry what was actually measured.
      settlement_seen:
        onchain.verdict === 'unknown' || chain.family === 'svm' ? null : onchain.verdict === 'active',
    },
    notes: [
      'Verdicts are observations of public read surfaces at one moment, not guarantees. An ' +
        '`unknown` means the surface could not be read and says nothing about the listing.',
      'x402-list (manual registry) is not machine-checkable and is not covered here.',
      // Said in the notes as well as in the evidence, and ONLY where it is true.
      // The difference between the two chain legs changes what the whole report
      // can be used for, which is more than an evidence field can carry.
      ...(chain.family === 'svm'
        ? [
            'The on-chain leg for this Solana payTo counted SIGNATURES — transactions that ' +
              'mention the address, in any role and either direction — not incoming payments. It ' +
              'shows the address is in use; it is not evidence that anything settled to it, which ' +
              'is why summary.settlement_seen is null rather than true or false.',
          ]
        : []),
    ],
  };
}

/** The Base leg's report: transfers that arrived, with the most recent one. */
function assembleEvmChain(chain) {
  const source = 'Base via Blockscout tokentx';
  return chain.transfers > 0
    ? {
        verdict: 'active',
        evidence: {
          source,
          incoming_transfers_in_window: chain.transfers,
          window: chain.window,
          latest: chain.latest,
        },
        fix: null,
      }
    : { verdict: 'none_seen', evidence: { source }, fix: FIXES.chain };
}

/**
 * The Solana leg's report.
 *
 * DIFFERENT FIELD NAMES ON PURPOSE, because a different thing was measured.
 * There is no transfer, counterparty, token or amount in what this leg reads, so
 * `incoming_transfers_in_window` and the EVM `latest`'s value/tokenSymbol have no
 * honest value here and do not appear under any spelling. `measures` states in
 * one line what was actually looked at: a verdict of `active` sitting beside a
 * settlement question would otherwise be read as "money arrived", which is the
 * exact misreading this whole branch exists to prevent.
 */
function assembleSvmChain(chain) {
  const source = 'Solana via the public JSON-RPC getSignaturesForAddress';
  const measures =
    'recent on-chain ACTIVITY involving this address — signatures, in any role and either ' +
    'direction. Not incoming payments: this read cannot see who paid whom, or how much.';
  return chain.signatures > 0
    ? {
        verdict: 'active',
        evidence: {
          source,
          measures,
          signatures_in_window: chain.signatures,
          // Counted beside the total, never subtracted from it: a transaction
          // that failed on chain was still signed, submitted and paid for, so it
          // is evidence the address is alive.
          failed_transactions_in_window: chain.failed,
          window: chain.window,
          latest: chain.latest,
        },
        fix: null,
      }
    : { verdict: 'none_seen', evidence: { source, measures, window: chain.window }, fix: FIXES.chain_svm };
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
