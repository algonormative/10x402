// The lint engine. THIS FILE IS THE PRODUCT.
//
// It is deliberately pure: no Worker globals, no fetch, no D1, no env. It takes
// a normalised HTTP response and returns a report. That purity is what lets the
// same code be
//
//   - imported by the Worker (worker/worker.js) to serve /lint and /lint/envelope,
//   - imported by build.mjs to render the check catalogue into the static page,
//   - imported by the suite and run against fixtures with no server at all,
//   - and pointed at 10x402's OWN 402 by test/self-lint.test.mjs.
//
// The last one is the invariant this repo lives or dies by: a conformance
// linter that does not pass its own lint is a shop with a broken sign.
//
// ------------------------------------------------------------------ what it knows
//
// x402 has two live generations and they are NOT a rename of each other. The
// checks below encode where each one puts what, because putting a v1 field in a
// v2 envelope is the single most common way a seller's endpoint is silently
// uncallable — the client reads the field it expects, finds nothing, and the
// seller sees a request that simply never arrives.
//
//   transport   v1: the envelope IS the 402's JSON body
//               v2: the envelope is standard-base64 in a PAYMENT-REQUIRED
//                   response header; the body is ignored by a v2 client
//   price       v1: accepts[].maxAmountRequired
//               v2: accepts[].amount
//   network     v1: "base"          (a plain name)
//               v2: "eip155:8453"   (CAIP-2; the colon is required by schema)
//   resource    v1: a flat URL STRING on the accepts entry
//               v2: an OBJECT at the top level: { url, method, description, … }
//   discovery   v1: accepts[].outputSchema
//               v2: extensions.bazaar, whose `info` MUST validate against its
//                   own `schema` or the facilitator declines to catalogue it
//
// ------------------------------------------------------------------ severities
//
//   error  a client, a facilitator or the discovery index will reject or
//          mis-read this. Something is broken right now.
//   warn   it works, but it costs the seller something they probably want —
//          discovery, a listing, a class of client.
//   info   a nit. Never affects the grade.
//
// Every finding carries a `fix` that says exactly what to change. A linter that
// reports "invalid envelope" and stops has told the seller nothing they did not
// already know from the silence.

import { validateAgainstSchema } from './json-schema.js';

// ------------------------------------------------------------------ constants

/** A 0x-prefixed 20-byte EVM address. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Standard base64 with optional padding, and NOTHING ELSE.
 *
 * This is @x402/core's own Base64EncodedRegex. A url-safe envelope (`-`/`_`
 * instead of `+`/`/`) is thrown out by the client BEFORE it is decoded, which
 * from the buyer's side is indistinguishable from a seller that published no
 * envelope at all — the most expensive one-character bug in this space.
 */
const STANDARD_B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** CAIP-2: `namespace:reference`. v2 network strings must match. */
const CAIP2_RE = /^[a-z0-9][a-z0-9-]{2,7}:[a-zA-Z0-9._-]{1,32}$/;

/** USDC on Base has 6 decimals; atomic → dollars for the summary line. */
const USDC_DECIMALS = 6;

/** The chain each v1 network name denotes, so dual-stack can be compared. */
const V1_NETWORK_CHAIN = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  avalanche: 'eip155:43114',
  'avalanche-fuji': 'eip155:43113',
  iotex: 'eip155:4689',
  sei: 'eip155:1329',
  'sei-testnet': 'eip155:1328',
  polygon: 'eip155:137',
  'polygon-amoy': 'eip155:80002',
};

const PAYMENT_REQUIRED_HEADER = 'payment-required';

// ------------------------------------------------------------------ bounds
//
// A LINT REPORT IS A FUNCTION OF ATTACKER-CONTROLLED INPUT, and without the
// three bounds below it is an amplifier: the caller pays for one small request
// and gets back a response orders of magnitude larger, computed at our expense
// and rendered into an isolate's memory. Measured before these existed: a 60 KB
// envelope with a long accepts[] produced a 56 MB report — 945x — which is an
// out-of-memory for the price of one cent.
//
// Each bound reports itself. A silent truncation would be worse than the
// amplification, because the seller would read a short report as a clean one.

/**
 * How many accepts[] entries are linted, per envelope.
 *
 * Real envelopes publish one entry, occasionally a handful — one per (scheme,
 * network, asset) pair a seller will take. Past this the entries are no longer
 * telling the reader anything new: whatever is wrong with the ninth is almost
 * certainly what was already reported about the first.
 */
const MAX_ACCEPTS_LINTED = 8;

/** How many findings a report may carry before the rest are suppressed. */
const MAX_FINDINGS = 200;

/** How much of any attacker-controlled string may be quoted back in a message. */
const MAX_QUOTED = 200;

/**
 * Quote a value from the envelope INTO a message, bounded.
 *
 * Every message below that interpolates envelope content goes through this.
 * A network name, a payTo, a resource URL and a price are all strings the
 * caller chose, and a check that echoes one unbounded turns a 2 KB field into
 * 2 KB of report — once per accepts entry, once per check.
 */
function clip(value, max = MAX_QUOTED) {
  const raw =
    typeof value === 'string' ? value : value === undefined ? 'undefined' : JSON.stringify(value) ?? String(value);
  return raw.length > max ? `${raw.slice(0, max)}… (+${raw.length - max} more characters)` : raw;
}

// ------------------------------------------------------------------ the catalogue
//
// One entry per check. `id` is the finding's `code`, so the catalogue published
// at GET /check and the codes in a report are the same vocabulary — a caller can
// look up any code it received without guessing.
//
// `core` marks the checks whose failure makes the envelope INVALID rather than
// merely impoverished. A single core error is an F: the endpoint does not work.

export const CHECKS = [
  // --- HTTP layer -------------------------------------------------------
  { id: 'HTTP_STATUS_402', area: 'http', severity: 'error', core: true,
    summary: 'an unauthenticated request answers 402' },
  { id: 'HTTP_FREE_TIER_200', area: 'http', severity: 'warn',
    summary: 'no free tier serving 200s to unauthenticated callers' },
  { id: 'HTTP_SERVER_ERROR', area: 'http', severity: 'error', core: true,
    summary: 'the endpoint is not 5xx' },
  { id: 'HTTP_REDIRECT', area: 'http', severity: 'warn',
    summary: 'the 402 is not behind a redirect' },
  { id: 'HTTP_CONTENT_TYPE_JSON', area: 'http', severity: 'warn',
    summary: 'the v1 envelope body is served as JSON' },
  { id: 'ENVELOPE_PRESENT', area: 'http', severity: 'error', core: true,
    summary: 'at least one x402 envelope is published' },

  // --- v2 envelope ------------------------------------------------------
  { id: 'V2_HEADER_PRESENT', area: 'v2', severity: 'warn',
    summary: 'a PAYMENT-REQUIRED response header is present' },
  { id: 'V2_B64_URLSAFE', area: 'v2', severity: 'error', core: true,
    summary: 'the header is standard base64, not base64url' },
  { id: 'V2_B64_DECODE', area: 'v2', severity: 'error', core: true,
    summary: 'the header decodes as base64' },
  { id: 'V2_JSON', area: 'v2', severity: 'error', core: true,
    summary: 'the decoded header is JSON' },
  { id: 'V2_VERSION', area: 'v2', severity: 'error', core: true,
    summary: 'the v2 payload declares x402Version 2' },
  { id: 'V2_ACCEPTS_NONEMPTY', area: 'v2', severity: 'error', core: true,
    summary: 'accepts[] is a non-empty array' },
  { id: 'V2_SCHEME', area: 'v2', severity: 'error', core: true,
    summary: 'each accept names a scheme' },
  { id: 'V2_SCHEME_KNOWN', area: 'v2', severity: 'info',
    summary: 'the scheme is one clients implement' },
  { id: 'V2_NETWORK_CAIP2', area: 'v2', severity: 'error', core: true,
    summary: 'network is CAIP-2, not a v1 plain name' },
  { id: 'V2_AMOUNT', area: 'v2', severity: 'error', core: true,
    summary: 'the price is in `amount`, not the v1 `maxAmountRequired`' },
  { id: 'V2_AMOUNT_ATOMIC', area: 'v2', severity: 'error', core: true,
    summary: 'the amount is a string of atomic units' },
  { id: 'V2_PAYTO', area: 'v2', severity: 'error', core: true,
    summary: 'payTo is a 0x address' },
  { id: 'V2_ASSET', area: 'v2', severity: 'error', core: true,
    summary: 'asset names the token contract' },
  { id: 'V2_MAX_TIMEOUT', area: 'v2', severity: 'warn',
    summary: 'maxTimeoutSeconds is present' },
  { id: 'V2_EXTRA_EIP712', area: 'v2', severity: 'warn',
    summary: 'extra carries the EIP-712 domain the client signs over' },
  // A WARN, NOT A CORE ERROR, and the downgrade is deliberate. The concern is
  // real — the client echoes the entry back as `accepted` and the server
  // deep-equals the two — but it is a claim about what @x402/core's schema
  // REJECTS that has not been verified against the published v2 schema, and a
  // stray field must not be an instant F on that much certainty. Where a stray
  // field genuinely breaks the envelope (a `maxAmountRequired` with no
  // `amount`), V2_AMOUNT already says so at core severity.
  { id: 'V2_ACCEPTS_V1_FIELDS', area: 'v2', severity: 'warn',
    summary: 'the accept carries no v1-only fields' },
  { id: 'V2_RESOURCE_OBJECT', area: 'v2', severity: 'error', core: true,
    summary: 'resource is the v2 object, not a v1 flat string' },
  { id: 'V2_RESOURCE_URL', area: 'v2', severity: 'error', core: true,
    summary: 'resource.url is an absolute URL' },
  { id: 'V2_RESOURCE_METHOD', area: 'v2', severity: 'warn',
    summary: 'resource.method says how to call it' },
  { id: 'V2_RESOURCE_DESCRIPTION', area: 'v2', severity: 'warn',
    summary: 'resource.description is present and non-empty' },
  { id: 'V2_RESOURCE_MIMETYPE', area: 'v2', severity: 'warn',
    summary: 'resource.mimeType says what comes back' },
  { id: 'V2_RESOURCE_URL_MATCHES', area: 'v2', severity: 'info',
    summary: 'resource.url is the URL that was called' },
  { id: 'V2_SERVICE_NAME', area: 'v2', severity: 'info',
    summary: 'resource.serviceName is set' },
  { id: 'V2_TAGS', area: 'v2', severity: 'info',
    summary: 'resource.tags are set' },
  { id: 'V2_BAZAAR_PRESENT', area: 'v2', severity: 'warn',
    summary: 'extensions.bazaar is present' },
  { id: 'V2_BAZAAR_INFO', area: 'v2', severity: 'error',
    summary: 'extensions.bazaar.info is present' },
  { id: 'V2_BAZAAR_SCHEMA', area: 'v2', severity: 'error',
    summary: 'extensions.bazaar.schema is present' },
  { id: 'V2_BAZAAR_INFO_VALIDATES', area: 'v2', severity: 'error',
    summary: 'info validates against its own schema' },
  { id: 'V2_BAZAAR_INPUT', area: 'v2', severity: 'warn',
    summary: 'bazaar.info.input carries a worked sample call' },
  { id: 'V2_BAZAAR_OUTPUT_EXAMPLE', area: 'v2', severity: 'warn',
    summary: 'bazaar.info.output.example is a computed response' },

  // --- v1 envelope ------------------------------------------------------
  //
  // THE V1 CHECKS ONLY RUN ON A V1 ATTEMPT. Four checks divide one question —
  // "what is in the 402 body?" — and the division is the whole of this repo's
  // most expensive near-miss, so it is written out.
  //
  //   V1_ABSENT           info. There is a v2 envelope in the header and the
  //                       body is not trying to be a v1 envelope. That is a
  //                       CHOICE, and the only thing it costs is the shrinking
  //                       population of pre-header clients. Never a grade.
  //   V1_BODY_NOT_ENVELOPE warn. The same, except the body is serving something
  //                       — `{"error":"payment required"}`, an HTML page — that
  //                       a v1 client will parse as an envelope and get nothing
  //                       usable from.
  //   V1_BODY_PRESENT     warn. NOTHING was published, in either transport.
  //   V1_BODY_JSON        core error. The body IS a v1 attempt and it is broken.
  //
  // The asymmetry with V2_HEADER_PRESENT (a warn for the mirror case) is
  // deliberate rather than an oversight: a v1-only endpoint is invisible to
  // every CURRENT client and is what CDP Bazaar answers with "upgrade to x402
  // v2 to be discoverable", while a v2-only endpoint is missing only legacy
  // ones. A v2-only seller is modern, not broken, and grading them F alongside
  // someone serving an HTML error page would make the grade meaningless in both
  // directions.
  { id: 'V1_ABSENT', area: 'v1', severity: 'info',
    summary: 'a v1 body envelope is published alongside the v2 header' },
  { id: 'V1_BODY_NOT_ENVELOPE', area: 'v1', severity: 'warn',
    summary: 'the 402 body is a v1 envelope or is empty, not something else' },
  { id: 'V1_BODY_PRESENT', area: 'v1', severity: 'warn',
    summary: 'a v1 envelope is published in the 402 body' },
  { id: 'V1_BODY_JSON', area: 'v1', severity: 'error', core: true,
    summary: 'the 402 body parses as JSON' },
  { id: 'V1_VERSION', area: 'v1', severity: 'error', core: true,
    summary: 'the body declares x402Version 1' },
  { id: 'V1_ACCEPTS_NONEMPTY', area: 'v1', severity: 'error', core: true,
    summary: 'accepts[] is a non-empty array' },
  { id: 'V1_SCHEME', area: 'v1', severity: 'error', core: true,
    summary: 'each accept names a scheme' },
  { id: 'V1_MAX_AMOUNT_REQUIRED', area: 'v1', severity: 'error', core: true,
    summary: 'the price is in `maxAmountRequired`, not the v2 `amount`' },
  { id: 'V1_AMOUNT_ATOMIC', area: 'v1', severity: 'error', core: true,
    summary: 'maxAmountRequired is a string of atomic units' },
  { id: 'V1_NETWORK_NAME', area: 'v1', severity: 'error', core: true,
    summary: 'network is a v1 plain name, not CAIP-2' },
  { id: 'V1_RESOURCE_STRING', area: 'v1', severity: 'error', core: true,
    summary: 'resource is a flat URL string, not the v2 object' },
  { id: 'V1_PAYTO', area: 'v1', severity: 'error', core: true,
    summary: 'payTo is a 0x address' },
  { id: 'V1_ASSET', area: 'v1', severity: 'error', core: true,
    summary: 'asset names the token contract' },
  { id: 'V1_MIMETYPE', area: 'v1', severity: 'warn',
    summary: 'mimeType says what comes back' },
  { id: 'V1_DESCRIPTION', area: 'v1', severity: 'warn',
    summary: 'description is present and non-empty' },
  { id: 'V1_MAX_TIMEOUT', area: 'v1', severity: 'warn',
    summary: 'maxTimeoutSeconds is present' },
  { id: 'V1_EXTRA_EIP712', area: 'v1', severity: 'warn',
    summary: 'extra carries the EIP-712 domain the client signs over' },
  { id: 'V1_OUTPUT_SCHEMA', area: 'v1', severity: 'warn',
    summary: 'outputSchema is present for v1 discovery' },
  { id: 'V1_DISCOVERABLE', area: 'v1', severity: 'warn',
    summary: 'outputSchema.input.discoverable opts into the v1 index' },

  // --- dual-stack consistency -------------------------------------------
  { id: 'DUAL_PAYTO', area: 'dual', severity: 'error', core: true,
    summary: 'both versions pay the same address' },
  { id: 'DUAL_PRICE', area: 'dual', severity: 'error', core: true,
    summary: 'both versions quote the same price' },
  { id: 'DUAL_NETWORK', area: 'dual', severity: 'error', core: true,
    summary: 'both versions name the same chain' },
  { id: 'DUAL_ASSET', area: 'dual', severity: 'error', core: true,
    summary: 'both versions name the same asset' },
  { id: 'DUAL_RESOURCE', area: 'dual', severity: 'warn',
    summary: 'both versions name the same resource URL' },

  // --- version-detection hygiene ----------------------------------------
  { id: 'VERSION_HEADER_SAYS_V1', area: 'version', severity: 'error', core: true,
    summary: 'the PAYMENT-REQUIRED header does not carry a v1 payload' },
  { id: 'VERSION_BODY_SAYS_V2', area: 'version', severity: 'error', core: true,
    summary: 'the 402 body does not carry a v2 payload' },

  // --- the report's own bounds ------------------------------------------
  //
  // Not conformance checks: these say what the LINTER did, and they exist
  // because the alternative to a bound that reports itself is a bound that
  // lies. A truncated report read as a clean one is worse than no report.
  { id: 'ACCEPTS_TRUNCATED', area: 'report', severity: 'info',
    summary: `at most ${MAX_ACCEPTS_LINTED} accepts[] entries are linted per envelope` },
  { id: 'FINDINGS_TRUNCATED', area: 'report', severity: 'info',
    summary: `a report carries at most ${MAX_FINDINGS} findings` },
];

export const CHECKS_BY_ID = new Map(CHECKS.map((c) => [c.id, c]));

/** The grade ladder, published verbatim at GET /check so nobody has to guess. */
export const GRADE_RULES = [
  { grade: 'A', when: 'zero errors and zero warnings' },
  { grade: 'B', when: 'zero errors, one or two warnings' },
  { grade: 'C', when: 'zero errors, three or more warnings' },
  { grade: 'D', when: 'one or more errors, none of them core' },
  { grade: 'F', when: 'any core error — the envelope is not usable as published' },
];

// ------------------------------------------------------------------ report builder

/**
 * Accumulates findings and, just as importantly, COUNTS THE CHECKS THAT RAN.
 *
 * `checks_run` is reported because a lint of a v1-only endpoint legitimately
 * skips every v2 check, and a caller comparing two reports needs to know the
 * denominator changed rather than assuming the second endpoint is cleaner.
 */
class Report {
  constructor() {
    this.findings = [];
    this.ran = new Set();
    /** Findings dropped by the MAX_FINDINGS cap. Reported, never swallowed. */
    this.suppressed = 0;
    /** The open accepts[] group, when one is being collapsed by code. */
    this.group = null;
  }

  /** Record that a check executed. Returns `ok` so callers can chain. */
  ran_(id, ok) {
    if (!CHECKS_BY_ID.has(id)) throw new Error(`unknown check id ${id} — add it to CHECKS`);
    this.ran.add(id);
    return ok;
  }

  /**
   * Run one check. `ok === true` is silence; anything else emits the finding.
   * `severity` may be overridden per call — a few checks report the same
   * concern at different weights depending on what else is present.
   */
  check(id, ok, message, fix, severity) {
    this.ran_(id, ok);
    if (ok) return true;
    const def = CHECKS_BY_ID.get(id);
    this.emit({ severity: severity || def.severity, code: id, message, fix });
    return false;
  }

  /** A finding for a check that has already been counted (loops over accepts). */
  add(id, message, fix, severity) {
    const def = CHECKS_BY_ID.get(id);
    if (!def) throw new Error(`unknown check id ${id} — add it to CHECKS`);
    this.ran.add(id);
    this.emit({ severity: severity || def.severity, code: id, message, fix });
    return false;
  }

  /**
   * The one place a finding enters the report, and therefore the one place the
   * cap can be applied. Past MAX_FINDINGS the finding is counted and dropped;
   * lint() turns that count into a terminal FINDINGS_TRUNCATED notice, so a
   * short report is never mistaken for a clean one.
   */
  emit(finding) {
    if (this.group) return this.groupEmit(finding);
    if (this.findings.length >= MAX_FINDINGS) {
      this.suppressed++;
      return;
    }
    this.findings.push(finding);
  }

  // ---------------------------------------------------------------- accepts groups
  //
  // ONE FINDING PER FAULT ACROSS A MULTI-ENTRY accepts[], not one per entry.
  // Without this the grade scales with the length of the array: an envelope with
  // forty entries each missing `extra` produced forty identical findings and a
  // C, while the same fault in a one-entry envelope was a B. The fault is the
  // same fault; what changes is only how many places it is in, and that belongs
  // in the message rather than in the count.
  //
  // PER FAULT, NOT PER CODE, and the distinction is the whole correctness of
  // this. Several checks reach the same code from branches that diagnose
  // different things — V2_NETWORK_CAIP2 fires for "names no network", for "uses
  // the v1 name base" (whose fix spells out the exact CAIP-2 replacement) and
  // for "is not a CAIP-2 identifier". Collapsing those three on the code alone
  // kept the first message and threw the other two away, then asserted "the
  // same fault is also in accepts[1]" — which was FALSE, and cost the seller
  // the most actionable fix string in the catalogue. Two findings are the same
  // fault only when they say the same thing.

  /**
   * Begin collapsing findings by fault. `total` is the array's real length and
   * `label` is how an entry is named in a message — the same spelling the
   * per-entry messages use, so the two halves of one sentence agree.
   */
  beginAccepts(total, label) {
    // A group left open would silently swallow everything buffered in it. Not
    // reachable in the current call graph — the v2 group closes before the v1
    // one opens — and nothing enforced that, so this does.
    if (this.group) this.endAccepts();
    this.group = { total, label, at: 0, byFault: new Map() };
  }

  /** Which entry the checks that follow are about. */
  atIndex(index) {
    if (this.group) this.group.at = index;
  }

  groupEmit(finding) {
    const key = faultKey(finding);
    const bucket = this.group.byFault.get(key);
    if (bucket) {
      bucket.indexes.push(this.group.at);
      return;
    }
    this.group.byFault.set(key, { finding, indexes: [this.group.at] });
  }

  /** Emit the collapsed findings, each naming every entry it was found in. */
  endAccepts() {
    const group = this.group;
    this.group = null;
    if (!group) return;

    for (const { finding, indexes } of group.byFault.values()) {
      if (indexes.length > 1) {
        // The message already names the FIRST entry, so the list is the rest.
        const rest = indexes.slice(1);
        const shown = rest.slice(0, 8).map((i) => `${group.label}[${i}]`).join(', ');
        const more = rest.length > 8 ? ` and ${rest.length - 8} more` : '';
        finding.message +=
          ` The same fault is also in ${shown}${more} — ${indexes.length} of the ${group.total} accepts[] entries in total.`;
      }
      this.emit(finding);
    }
  }
}

/**
 * The identity of a FAULT, for collapsing a multi-entry accepts[].
 *
 * Code, message and fix — with the entry index normalised out of all three, so
 * `accepts[0] names no scheme` and `accepts[3] names no scheme` are one fault
 * while `accepts[1] uses the v1 network name "base"` stays its own. The values
 * quoted out of the envelope are deliberately LEFT IN: two entries naming two
 * different unknown schemes are two things for the seller to look at, and a
 * report that mentioned only the first would be hiding the second.
 */
const faultKey = (finding) => {
  const normalise = (text) => String(text ?? '').replace(/\b(?:v1 )?accepts\[\d+\]/g, 'accepts[]');
  // JSON.stringify of the triple rather than a joined string: it needs no
  // separator character, so there is none for a message to contain.
  return JSON.stringify([finding.code, normalise(finding.message), normalise(finding.fix)]);
};

const isCore = (code) => CHECKS_BY_ID.get(code)?.core === true;

/**
 * The grade. Core errors are a separate tier from ordinary ones because they
 * mean different things to the seller: an F is "this does not work", a D is
 * "this works and something about it is wrong".
 */
export function grade(findings) {
  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warn');
  if (errors.some((f) => isCore(f.code))) return 'F';
  if (errors.length) return 'D';
  if (warns.length >= 3) return 'C';
  if (warns.length) return 'B';
  return 'A';
}

// ------------------------------------------------------------------ helpers

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/** Header lookup that does not care about case, on a plain object. */
function headerOf(headers, name) {
  if (!isObject(headers)) return null;
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === want) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

/** Standard base64 → UTF-8 text, or null. Works in workerd and in Node. */
function decodeBase64(raw) {
  try {
    const binary = atob(String(raw).trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Atomic units → a readable price, assuming a 6-decimal stablecoin. */
function formatPrice(atomic) {
  const raw = String(atomic ?? '');
  if (!/^\d+$/.test(raw)) return null;
  const padded = raw.padStart(USDC_DECIMALS + 1, '0');
  const frac = padded.slice(-USDC_DECIMALS).replace(/0+$/, '');
  return `$${padded.slice(0, -USDC_DECIMALS)}${frac ? `.${frac}` : ''}`;
}

/** The CAIP-2 chain a network string denotes, in either version's spelling. */
const chainOf = (network) =>
  typeof network === 'string' ? V1_NETWORK_CHAIN[network] || (network.includes(':') ? network : null) : null;

// ------------------------------------------------------------------ v2

/**
 * Lint the v2 half. Returns the facts dual-stack consistency needs, or null when
 * there is no v2 envelope to read.
 */
function lintV2(report, headers, requestUrl) {
  const raw = headerOf(headers, PAYMENT_REQUIRED_HEADER);

  if (!nonEmptyString(raw)) {
    report.check(
      'V2_HEADER_PRESENT',
      false,
      'no PAYMENT-REQUIRED response header — this endpoint publishes no x402 v2 envelope.',
      'Add a PAYMENT-REQUIRED response header to the 402 carrying the standard-base64 ' +
        'JSON v2 envelope. A v2 client reads that header FIRST and never falls back to the ' +
        'body, so a v1-only endpoint is invisible to every current client, and CDP Bazaar ' +
        'answers v1-only sellers with "upgrade to x402 v2 to be discoverable". Keep the v1 ' +
        'body exactly as it is — the two versions share a 402 without either noticing the other.'
    );
    return null;
  }
  report.check('V2_HEADER_PRESENT', true);

  const value = String(raw).trim();
  if (
    !report.check(
      'V2_B64_URLSAFE',
      STANDARD_B64_RE.test(value),
      'the PAYMENT-REQUIRED header is not standard base64 — it contains characters outside ' +
        '[A-Za-z0-9+/=]' +
        (/[-_]/.test(value) ? ', including the base64url characters "-" and/or "_".' : '.'),
      'Encode the header with STANDARD base64, not base64url. Clients validate the header ' +
        'against /^[A-Za-z0-9+/]*={0,2}$/ BEFORE decoding it, so a url-safe envelope is ' +
        'discarded unread and your endpoint looks like it published no envelope at all. In ' +
        'JS: btoa(binaryString) — not the .replace(/\\+/g,"-").replace(/\\//g,"_") form you ' +
        'use for JWTs. In Python: base64.b64encode, not base64.urlsafe_b64encode. In Go: ' +
        'base64.StdEncoding, not base64.URLEncoding.'
    )
  ) {
    return null;
  }

  const text = decodeBase64(value);
  if (
    !report.check(
      'V2_B64_DECODE',
      text !== null,
      'the PAYMENT-REQUIRED header could not be base64-decoded to UTF-8 text.',
      'The header value must be base64 of the UTF-8 JSON envelope. Check for stray ' +
        'whitespace, a double-encoding, or a truncated value — some proxies clip very long ' +
        'header values, so keep the envelope small (drop long descriptions and big samples).'
    )
  ) {
    return null;
  }

  let env;
  try {
    env = JSON.parse(text);
  } catch (err) {
    report.check(
      'V2_JSON',
      false,
      `the decoded PAYMENT-REQUIRED header is not valid JSON: ${String(err.message).slice(0, 120)}`,
      'Base64-encode the exact bytes of JSON.stringify(envelope). A common cause is encoding ' +
        'a JS object via String(obj), which yields "[object Object]".'
    );
    return null;
  }
  report.check('V2_JSON', isObject(env), 'the decoded PAYMENT-REQUIRED header is not a JSON object.',
    'The envelope is a JSON object with x402Version, resource, accepts and extensions.');
  if (!isObject(env)) return null;

  // Version-detection hygiene. Clients key on the PAYLOAD's x402Version, not on
  // the transport they found it in, so a v1 payload in the v2 header is read as
  // v1 by a v2 client — and then it looks for v1 fields that are not there.
  report.check(
    'VERSION_HEADER_SAYS_V1',
    env.x402Version !== 1,
    'the PAYMENT-REQUIRED header carries a payload declaring x402Version 1.',
    'A client branches on the payload\'s x402Version field, not on which transport carried ' +
      'it. Put the v1 envelope (x402Version: 1) in the 402 BODY and the v2 envelope ' +
      '(x402Version: 2) in the header. Serving a v1 payload in the v2 header makes a v2 ' +
      'client parse it with v1 rules and find none of the v2 fields it needs.'
  );

  report.check(
    'V2_VERSION',
    env.x402Version === 2,
    `the v2 envelope declares x402Version ${clip(JSON.stringify(env.x402Version))}, not 2.`,
    'Set "x402Version": 2 at the top level of the PAYMENT-REQUIRED envelope. This is the ' +
      'field every client dispatches on.'
  );

  const accepts = Array.isArray(env.accepts) ? env.accepts : [];
  if (
    !report.check(
      'V2_ACCEPTS_NONEMPTY',
      accepts.length > 0,
      Array.isArray(env.accepts)
        ? 'the v2 envelope\'s accepts[] is empty — there is no way to pay.'
        : 'the v2 envelope has no accepts[] array.',
      'accepts[] lists the payment terms you will take, one entry per (scheme, network, ' +
        'asset). At least one entry is required; most sellers publish exactly one.'
    )
  ) {
    return { env, accept: null, resource: env.resource };
  }

  const accept = accepts[0];
  lintV2Accept(report, accept, accepts);
  lintV2Resource(report, env.resource, requestUrl);
  lintBazaar(report, env.extensions);

  return { env, accept, resource: env.resource };
}

function lintV2Accept(report, accept, accepts) {
  report.beginAccepts(accepts.length, 'accepts');
  for (const [i, entry] of lintedAccepts(accepts).entries()) {
    report.atIndex(i);
    const where = accepts.length > 1 ? `accepts[${i}]` : 'the v2 accept';

    // A NON-OBJECT ENTRY IS A FINDING WHEREVER IT IS. This used to be two
    // different silences: a non-object at index 0 returned early and skipped
    // the whole array — including the truncation notice, so forty unread
    // entries went unmentioned — and a non-object at any later index was
    // `continue`d past with nothing said at all. A v2 client iterating accepts
    // faults on those entries; a report that does not mention them is telling
    // the seller their envelope is better than it is.
    if (!isObject(entry)) {
      report.add(
        'V2_SCHEME',
        `${where} is ${clip(JSON.stringify(entry), 60)}, not an object.`,
        'Each accepts[] entry is an object: { scheme, network, amount, asset, payTo, ' +
          'maxTimeoutSeconds, extra }. A null or a string in the array is not skipped by a ' +
          'client — it is iterated, and reading a field off it is where the client throws.'
      );
      continue;
    }

    report.check(
      'V2_SCHEME',
      nonEmptyString(entry.scheme),
      `${where} names no scheme.`,
      'Set "scheme": "exact" unless you have implemented another one. `exact` is the ' +
        'EIP-3009 transferWithAuthorization scheme every current client and facilitator supports.'
    );
    report.check(
      'V2_SCHEME_KNOWN',
      !nonEmptyString(entry.scheme) || entry.scheme === 'exact',
      `${where} uses the scheme "${clip(entry.scheme)}", which is not the "exact" scheme most clients implement.`,
      'Unless you have a facilitator that speaks this scheme, publish "exact" as well so ' +
        'ordinary x402 clients can pay you.'
    );

    // NETWORK. The v1 plain name in a v2 envelope is the flagship version-confusion
    // bug: v2  schema requires a colon, so "base" is not a lenient variant, it is
    // an invalid envelope.
    if (typeof entry.network !== 'string' || !entry.network) {
      report.check('V2_NETWORK_CAIP2', false, `${where} names no network.`,
        'Set "network" to the CAIP-2 id of the chain, e.g. "eip155:8453" for Base mainnet.');
    } else if (V1_NETWORK_CHAIN[entry.network]) {
      report.check(
        'V2_NETWORK_CAIP2',
        false,
        `${where} uses the v1 network name "${clip(entry.network)}" in a v2 envelope.`,
        `v2 networks are CAIP-2 and the schema requires the colon: replace "${clip(entry.network)}" ` +
          `with "${V1_NETWORK_CHAIN[entry.network]}". Keep "${clip(entry.network)}" in the v1 body — ` +
          'the same chain has two spellings and the version decides which one is legal.'
      );
    } else {
      report.check(
        'V2_NETWORK_CAIP2',
        CAIP2_RE.test(entry.network),
        `${where} network "${clip(entry.network)}" is not a CAIP-2 identifier.`,
        'Use `namespace:reference`, e.g. "eip155:8453" (Base mainnet) or "eip155:84532" ' +
          '(Base Sepolia). The colon is required by the v2 schema.'
      );
    }

    // PRICE. v2 renamed the field; carrying the v1 name means a v2 client reads
    // `undefined` and signs for nothing.
    if (entry.amount === undefined && entry.maxAmountRequired !== undefined) {
      report.check(
        'V2_AMOUNT',
        false,
        `${where} carries the v1 field "maxAmountRequired" instead of v2's "amount".`,
        `Rename it: "amount": ${clip(JSON.stringify(entry.maxAmountRequired))}. v2 reads accepts[].amount; a v2 ` +
          'client that finds no amount has no price to sign over. Keep maxAmountRequired in ' +
          'the v1 body.'
      );
    } else {
      report.check('V2_AMOUNT', entry.amount !== undefined, `${where} has no amount.`,
        'Set "amount" to the price in the asset\'s ATOMIC units, as a string — "10000" is ' +
          '$0.01 of a 6-decimal USDC.');
    }
    if (entry.amount !== undefined) {
      report.check(
        'V2_AMOUNT_ATOMIC',
        typeof entry.amount === 'string' && /^\d+$/.test(entry.amount),
        `${where} amount ${clip(JSON.stringify(entry.amount))} is not a decimal string of atomic units.`,
        'Amounts are STRINGS of integer atomic units, never numbers and never decimals — ' +
          '"10000", not 0.01 and not "0.01". A JSON number loses precision on large amounts ' +
          'and a decimal string is rejected by the facilitator.'
      );
    }

    report.check(
      'V2_PAYTO',
      ADDRESS_RE.test(String(entry.payTo || '')),
      entry.payTo ? `${where} payTo "${clip(entry.payTo)}" is not a 0x EVM address.`
        : `${where} has no payTo — there is nowhere to send the money.`,
      'payTo is the 20-byte receiving address, 0x-prefixed and 40 hex characters. Paste the ' +
        'address from your wallet rather than a name or an ENS entry; clients do not resolve names.'
    );

    report.check(
      'V2_ASSET',
      nonEmptyString(entry.asset),
      `${where} names no asset.`,
      'Set "asset" to the token contract address on that chain — for USDC on Base, ' +
        '"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913". Without it the client does not know ' +
        'what token to sign a transfer of.'
    );

    report.check(
      'V2_MAX_TIMEOUT',
      Number.isFinite(Number(entry.maxTimeoutSeconds)) && Number(entry.maxTimeoutSeconds) > 0,
      `${where} has no usable maxTimeoutSeconds.`,
      'Set "maxTimeoutSeconds" to how long a signed authorization stays valid — 60 is the ' +
        'common value. Clients use it to set validBefore on the authorization they sign; ' +
        'without it they must guess, and a guess that is too short fails verification.'
    );

    // `extra` is the EIP-712 domain. Omitting it is the classic silent killer:
    // the client signs over `name: undefined` while the facilitator recomputes
    // the domain from its own table, and every real payment comes back
    // invalid_exact_evm_payload_signature.
    report.check(
      'V2_EXTRA_EIP712',
      isObject(entry.extra) && nonEmptyString(entry.extra.name) && entry.extra.version !== undefined,
      `${where} has no extra.{name,version} — the EIP-712 domain is missing.`,
      'Add "extra": { "name": "<the token\'s on-chain name()>", "version": "<its EIP-712 ' +
        'version>" }. For USDC on Base that is { "name": "USD Coin", "version": "2" } — note ' +
        'the NAME, not the ticker. The client builds the typed-data domain from these with no ' +
        'fallback while the facilitator falls back to its own table, so omitting them makes ' +
        'every genuine payment fail as invalid_exact_evm_payload_signature, with nothing in ' +
        'your logs to explain it.'
    );

    // A v2 accept is exactly seven fields. Extra ones are not inert: the client
    // echoes the entry back as `accepted` and the server deep-equals the two.
    const v1Only = ['maxAmountRequired', 'resource', 'description', 'mimeType', 'outputSchema'].filter(
      (f) => entry[f] !== undefined
    );
    report.check(
      'V2_ACCEPTS_V1_FIELDS',
      v1Only.length === 0,
      `${where} carries v1-only field(s): ${v1Only.join(', ')}.`,
      'A v2 accepts[] entry is exactly scheme, network, amount, asset, payTo, ' +
        'maxTimeoutSeconds and extra. `resource`, `description` and `mimeType` moved to the ' +
        'top-level `resource` object; `outputSchema` became `extensions.bazaar`; ' +
        '`maxAmountRequired` became `amount`. Strays are not harmless — the client echoes ' +
        'this entry back as `accepted` and the two are deep-compared.'
    );
  }
  report.endAccepts();
  acceptsTruncated(report, accepts, 'v2');
}

/** The accepts[] entries this report will actually read. See MAX_ACCEPTS_LINTED. */
const lintedAccepts = (accepts) => accepts.slice(0, MAX_ACCEPTS_LINTED);

/** Say so, in the report, when accepts[] was longer than the linter reads. */
function acceptsTruncated(report, accepts, version) {
  const skipped = accepts.length - MAX_ACCEPTS_LINTED;
  report.check(
    'ACCEPTS_TRUNCATED',
    skipped <= 0,
    `the ${version} envelope publishes ${accepts.length} accepts[] entries; the first ` +
      `${MAX_ACCEPTS_LINTED} were checked and ${skipped} were not.`,
    `Publish one accepts[] entry per (scheme, network, asset) you will actually take — real ` +
      `envelopes have one, occasionally a handful. If you genuinely offer more than ` +
      `${MAX_ACCEPTS_LINTED}, lint the remainder by posting a response whose accepts[] carries ` +
      'them, or expect that whatever is wrong with the later entries is what this report ' +
      'already says about the first.'
  );
}

function lintV2Resource(report, resource, requestUrl) {
  if (typeof resource === 'string') {
    report.check(
      'V2_RESOURCE_OBJECT',
      false,
      'the v2 envelope\'s top-level `resource` is a flat string — that is the v1 form.',
      `Replace it with the v2 object: { "url": "${clip(resource)}", "method": "POST", ` +
        '"description": "<what the call does>", "mimeType": "<what comes back>" } — plus ' +
        'optional serviceName and tags. Keep the flat string in the v1 body\'s accepts entry.'
    );
    return;
  }
  if (!isObject(resource)) {
    report.check(
      'V2_RESOURCE_OBJECT',
      false,
      'the v2 envelope has no top-level `resource` object.',
      'Add "resource": { "url", "method", "description", "mimeType" } at the top level of ' +
        'the v2 envelope, next to accepts. It is what a discovery index catalogues; without ' +
        'it your listing has no name, no description and no calling convention.'
    );
    return;
  }
  report.check('V2_RESOURCE_OBJECT', true);

  let parsed = null;
  try {
    parsed = new URL(String(resource.url));
  } catch {
    /* reported below */
  }
  report.check(
    'V2_RESOURCE_URL',
    parsed !== null,
    resource.url ? `resource.url "${clip(resource.url)}" is not an absolute URL.` : 'resource.url is missing.',
    'resource.url must be the absolute https URL of the paid endpoint, e.g. ' +
      '"https://example.com/api/thing". A relative path cannot be resolved by an indexer ' +
      'that only has the envelope.'
  );

  report.check(
    'V2_RESOURCE_METHOD',
    nonEmptyString(resource.method),
    'resource.method is missing.',
    'Add "method": "POST" (or GET). Live v2 sellers in the CDP index publish it, and a ' +
      'POST-only resource that does not say so is a listing every agent calls wrong on the ' +
      'first try. Say it a second time, schema-legally, as ' +
      'extensions.bazaar.info.input.method.'
  );
  report.check(
    'V2_RESOURCE_DESCRIPTION',
    nonEmptyString(resource.description),
    'resource.description is missing or empty.',
    'Write one sentence saying what the call does, under 500 characters — the facilitator ' +
      'rejects longer. This is the line an agent reads when deciding whether to pay you.'
  );
  report.check(
    'V2_RESOURCE_MIMETYPE',
    nonEmptyString(resource.mimeType),
    'resource.mimeType is missing.',
    'Add "mimeType" naming what a successful response returns, e.g. "application/json".'
  );

  if (requestUrl && parsed) {
    report.check(
      'V2_RESOURCE_URL_MATCHES',
      parsed.href.replace(/\/$/, '') === String(requestUrl).replace(/\/$/, ''),
      `resource.url is "${clip(parsed.href)}" but this envelope was served from "${clip(requestUrl)}".`,
      'Point resource.url at the URL that actually answers the 402. A mismatch sends the ' +
        'discovery index — and the settlement record attached to it — at a different URL ' +
        'from the one buyers call.'
    );
  }

  report.check(
    'V2_SERVICE_NAME',
    nonEmptyString(resource.serviceName),
    'resource.serviceName is not set.',
    'Add "serviceName" (max 32 printable ASCII characters). It is the name your listing ' +
      'appears under; without it an index shows a bare URL.'
  );
  report.check(
    'V2_TAGS',
    Array.isArray(resource.tags) && resource.tags.length > 0,
    'resource.tags is not set.',
    'Add "tags": ["x402", "<your category>"] — up to 5 entries of 32 characters. Tags are ' +
      'how an agent filters a directory down to the tools it is looking for.'
  );
}

// ------------------------------------------------------------------ bazaar

/**
 * `extensions.bazaar` — the v2 successor to v1's `outputSchema`, and the half
 * that decides whether the resource is INDEXABLE rather than merely payable.
 *
 * The `info` / `schema` pair is validated one against the other here for real,
 * because that is what the facilitator does before cataloguing: a schema that
 * does not admit its own info is a silent delisting, and "silent" is the whole
 * problem — nothing in the seller's logs ever mentions it.
 */
function lintBazaar(report, extensions) {
  const bazaar = isObject(extensions) ? extensions.bazaar : undefined;

  if (!isObject(bazaar)) {
    report.check(
      'V2_BAZAAR_PRESENT',
      false,
      'extensions.bazaar is absent — this resource is payable but not discoverable.',
      'Add "extensions": { "bazaar": { "info": {…}, "schema": {…} } } to the v2 envelope. ' +
        'CDP Bazaar requires it to index a resource: `info` is one worked example of the ' +
        'call and `schema` is the JSON Schema that example validates against. In v2 the ' +
        'presence of this extension IS the opt-in — there is no `discoverable` flag any more.'
    );
    return;
  }
  report.check('V2_BAZAAR_PRESENT', true);

  const hasInfo = report.check(
    'V2_BAZAAR_INFO',
    isObject(bazaar.info),
    'extensions.bazaar has no `info` object.',
    'bazaar.info is ONE concrete example of the call: { "input": { "type": "http", ' +
      '"method": "POST", "bodyType": "text", "body": "<a real request body>" }, "output": ' +
      '{ "type": "text", "format": "<mime>", "example": "<what that body returns>" } }.'
  );
  const hasSchema = report.check(
    'V2_BAZAAR_SCHEMA',
    isObject(bazaar.schema),
    'extensions.bazaar has no `schema` object.',
    'bazaar.schema is the JSON Schema that bazaar.info is validated against. The facilitator ' +
      'MUST check one against the other before cataloguing, so the pair has to be written ' +
      'together — a schema copied from another endpoint will not admit this one\'s info.'
  );

  if (hasInfo) {
    report.check(
      'V2_BAZAAR_INPUT',
      isObject(bazaar.info.input),
      'bazaar.info.input is missing — there is no sample call.',
      'Add "input": { "type": "http", "method": "<verb>", "bodyType": "text", "body": ' +
        '"<a request body that really works>" }. It is a worked example, not a description ' +
        'of one: an agent will send exactly this, so an example that 400s is worse than none.'
    );
    const output = isObject(bazaar.info.output) ? bazaar.info.output : null;
    report.check(
      'V2_BAZAAR_OUTPUT_EXAMPLE',
      output !== null && nonEmptyString(output.example),
      output ? 'bazaar.info.output.example is missing.' : 'bazaar.info.output is missing.',
      'Add "output": { "type": "text", "format": "<mime>", "example": "<the sample input ' +
        'above, actually run through your endpoint>" }. CDP\'s validator asks for a computed ' +
        'output example — compute it at build time from the real code path rather than typing ' +
        'one by hand, or it drifts the first time you change the endpoint and nothing tells you.'
    );
  }

  if (hasInfo && hasSchema) {
    const problems = validateAgainstSchema(bazaar.info, bazaar.schema);
    report.check(
      'V2_BAZAAR_INFO_VALIDATES',
      problems.length === 0,
      `bazaar.info does not validate against bazaar.schema: ${clip(problems.slice(0, 4).join('; '), 400)}` +
        (problems.length > 4 ? ` (+${problems.length - 4} more)` : ''),
      'Fix whichever half is wrong so the pair agrees. This exact mismatch is what CDP\'s ' +
        'facilitator rejects, and it rejects it SILENTLY — the endpoint keeps taking payments ' +
        'and simply never appears in the directory. The usual causes: a `const` in the schema ' +
        'that no longer matches the info after a rename, a `required` field the info dropped, ' +
        'and "additionalProperties": false with a field the info added.'
    );
  }
}

// ------------------------------------------------------------------ v1

/**
 * Is this body TRYING to be a v1 envelope?
 *
 * THIS PREDICATE IS THE DIFFERENCE BETWEEN AN A AND AN F FOR EVERY V2-ONLY
 * SELLER, so it is a named function rather than an inline condition. Before it
 * existed, the v1 core checks were skipped only when the body was literally
 * empty — so a perfect v2-only endpoint answering `{"error":"payment required"}`
 * in the body, which is what most frameworks emit on a 402, ran the entire v1
 * cascade and graded F. The report told a seller with a flawless envelope that
 * their endpoint did not work.
 *
 * A v1 attempt is a JSON OBJECT carrying at least one field that only a v1
 * envelope has a reason to carry. Anything else — an error blob, an HTML page,
 * plain text, an empty body — is not a broken v1 envelope. It is the absence of
 * one, which is a different finding at a different severity.
 */
function isV1Attempt(parsed) {
  return (
    isObject(parsed) &&
    (parsed.x402Version !== undefined || parsed.accepts !== undefined || parsed.maxAmountRequired !== undefined)
  );
}

/**
 * Lint the v1 half — the 402's JSON body. Returns the facts, or null.
 *
 * `v2Published` decides what the ABSENCE of a v1 envelope means. With a v2
 * envelope in the header it is a deliberate, modern choice and costs only the
 * legacy clients (V1_ABSENT, info). Without one, nothing at all was published,
 * and ENVELOPE_PRESENT upstream says so as a core error.
 */
function lintV1(report, body, contentType, v2Published) {
  const text = typeof body === 'string' ? body : '';

  let parsed;
  let parseError = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      parseError = err;
    }
  }

  // --- v2-only: no v1 attempt, and a v2 envelope to fall back on -------
  if (!isV1Attempt(parsed) && v2Published) {
    report.check(
      'V1_ABSENT',
      false,
      'the 402 body carries no x402 v1 envelope — this endpoint publishes v2 only.',
      'Optional, and only you can price it: a v1 client (x402-fetch v1, and anything written ' +
        'against the pre-header protocol) reads the 402 BODY and never looks at the ' +
        'PAYMENT-REQUIRED header, so it cannot pay this endpoint at all. Serving both from one ' +
        '402 costs one JSON body: { "x402Version": 1, "accepts": [ … ] }, with the v1 spellings ' +
        '(maxAmountRequired, a plain network name, a flat resource string). Everything else ' +
        'here is already right.'
    );
    report.check(
      'V1_BODY_NOT_ENVELOPE',
      !text.trim(),
      `the 402 body is ${clip(text.trim(), 120)} — ${
        parseError ? 'not JSON' : 'JSON, but not an x402 envelope'
      }.`,
      'Either serve a v1 envelope here or serve nothing. A v1 client parses this body as the ' +
        'envelope, finds no accepts[], and reports a payment failure that names your error ' +
        'string rather than the real cause. An empty body is a cleaner signal than a body ' +
        'that looks like it might have been one.'
    );
    return null;
  }

  // --- nothing published anywhere --------------------------------------
  if (!text.trim()) {
    report.check(
      'V1_BODY_PRESENT',
      false,
      'the 402 body is empty — this endpoint publishes no x402 v1 envelope.',
      'Put the v1 envelope in the 402 response body: { "x402Version": 1, "accepts": [ … ] }. ' +
        'A v1 client reads the body and never looks at the PAYMENT-REQUIRED header, so a ' +
        'v2-only endpoint is unpayable by every v1 client — and one of those may already be ' +
        'your only paying customer. Serving both from one 402 costs nothing.'
    );
    return null;
  }
  report.check('V1_BODY_PRESENT', true);

  // --- a v1 attempt, or a body that is nothing with no v2 to fall back on
  if (parseError) {
    report.check(
      'V1_BODY_JSON',
      false,
      `the 402 body is not valid JSON: ${clip(String(parseError.message), 120)}`,
      'The v1 envelope is a JSON object in the response body. If you are returning an HTML ' +
        'error page or a plain-text message on 402, replace it — a v1 client parses this body ' +
        'as the envelope and gets nothing.'
    );
    return null;
  }
  const env = parsed;
  if (!report.check('V1_BODY_JSON', isObject(env), 'the 402 body is JSON but not an object.',
    'The v1 envelope is a JSON object: { "x402Version": 1, "accepts": [ … ] }.')) {
    return null;
  }

  report.check(
    'HTTP_CONTENT_TYPE_JSON',
    /application\/json|\+json/i.test(String(contentType || '')),
    `the 402 carries content-type ${contentType ? `"${clip(contentType)}"` : '(none)'} while its body is a JSON envelope.`,
    'Send "content-type: application/json; charset=utf-8" on the 402. Some clients and most ' +
      'proxies decide whether to parse a body from its content-type, and a JSON envelope ' +
      'labelled text/html is a body they will not read.'
  );

  report.check(
    'VERSION_BODY_SAYS_V2',
    env.x402Version !== 2,
    'the 402 BODY carries a payload declaring x402Version 2.',
    'The body is the v1 transport. Put the v1 envelope (x402Version: 1) here and move the ' +
      'v2 envelope (x402Version: 2) into the base64 PAYMENT-REQUIRED response header. A v1 ' +
      'client reads this body with v1 rules regardless of what the payload claims.'
  );

  report.check(
    'V1_VERSION',
    env.x402Version === 1,
    `the 402 body declares x402Version ${clip(JSON.stringify(env.x402Version))}, not 1.`,
    'Set "x402Version": 1 in the 402 body. Clients dispatch on this field, and one that is ' +
      'missing or wrong sends the client down the wrong parser.'
  );

  const accepts = Array.isArray(env.accepts) ? env.accepts : [];
  if (
    !report.check(
      'V1_ACCEPTS_NONEMPTY',
      accepts.length > 0,
      Array.isArray(env.accepts)
        ? 'the v1 envelope\'s accepts[] is empty — there is no way to pay.'
        : 'the v1 envelope has no accepts[] array.',
      'accepts[] lists the terms you will take. At least one entry: { scheme, network, ' +
        'maxAmountRequired, resource, description, mimeType, payTo, maxTimeoutSeconds, asset, extra }.'
    )
  ) {
    return { env, accept: null };
  }

  const accept = accepts[0];
  lintV1Accept(report, accept, accepts);
  return { env, accept };
}

function lintV1Accept(report, accept, accepts) {
  report.beginAccepts(accepts.length, 'v1 accepts');
  for (const [i, entry] of lintedAccepts(accepts).entries()) {
    report.atIndex(i);
    const where = accepts.length > 1 ? `v1 accepts[${i}]` : 'the v1 accept';

    // Reported wherever it is — see the note on the v2 side.
    if (!isObject(entry)) {
      report.add(
        'V1_SCHEME',
        `${where} is ${clip(JSON.stringify(entry), 60)}, not an object.`,
        'Each accepts[] entry is an object of payment terms: { scheme, network, ' +
          'maxAmountRequired, resource, description, mimeType, payTo, maxTimeoutSeconds, asset, ' +
          'extra }. A null or a string in the array is iterated by a client like any other entry.'
      );
      continue;
    }

    report.check('V1_SCHEME', nonEmptyString(entry.scheme), `${where} names no scheme.`,
      'Set "scheme": "exact" — the EIP-3009 scheme every current client and facilitator supports.');

    // PRICE — the mirror image of the v2 case.
    if (entry.maxAmountRequired === undefined && entry.amount !== undefined) {
      report.check(
        'V1_MAX_AMOUNT_REQUIRED',
        false,
        `${where} carries the v2 field "amount" instead of v1's "maxAmountRequired".`,
        `Rename it: "maxAmountRequired": ${clip(JSON.stringify(entry.amount))}. v1 reads ` +
          'accepts[].maxAmountRequired; `amount` is the v2 spelling and belongs in the ' +
          'PAYMENT-REQUIRED header envelope, not here.'
      );
    } else {
      report.check('V1_MAX_AMOUNT_REQUIRED', entry.maxAmountRequired !== undefined,
        `${where} has no maxAmountRequired.`,
        'Set "maxAmountRequired" to the price in atomic units, as a string — "10000" is ' +
          '$0.01 of a 6-decimal USDC.');
    }
    if (entry.maxAmountRequired !== undefined) {
      report.check(
        'V1_AMOUNT_ATOMIC',
        typeof entry.maxAmountRequired === 'string' && /^\d+$/.test(entry.maxAmountRequired),
        `${where} maxAmountRequired ${clip(JSON.stringify(entry.maxAmountRequired))} is not a decimal string of atomic units.`,
        'Amounts are STRINGS of integer atomic units — "10000", never 0.01 and never "0.01".'
      );
    }

    // NETWORK — CAIP-2 here is the v2 form in a v1 envelope.
    if (typeof entry.network !== 'string' || !entry.network) {
      report.check('V1_NETWORK_NAME', false, `${where} names no network.`,
        'Set "network" to the v1 plain name of the chain, e.g. "base".');
    } else if (entry.network.includes(':')) {
      const plain = Object.entries(V1_NETWORK_CHAIN).find(([, caip]) => caip === entry.network);
      report.check(
        'V1_NETWORK_NAME',
        false,
        `${where} uses the CAIP-2 network "${clip(entry.network)}" in a v1 envelope.`,
        `v1 networks are plain names: replace "${clip(entry.network)}" with ` +
          `"${plain ? plain[0] : '<the v1 name for this chain>'}". The CAIP-2 form belongs in ` +
          'the v2 header envelope. Same chain, two spellings, and the version decides which is legal.'
      );
    } else {
      report.check('V1_NETWORK_NAME', true);
    }

    // RESOURCE — v1 is a flat string; the v2 object here is the mirror bug.
    if (isObject(entry.resource)) {
      report.check(
        'V1_RESOURCE_STRING',
        false,
        `${where} resource is an object — that is the v2 form.`,
        `In v1 resource is the flat URL STRING: "resource": ` +
          `"${clip(entry.resource.url || 'https://example.com/your/endpoint')}". The object form, ` +
          'with url/method/description/mimeType, belongs at the TOP LEVEL of the v2 header ' +
          'envelope — not inside a v1 accepts entry.'
      );
    } else {
      report.check(
        'V1_RESOURCE_STRING',
        nonEmptyString(entry.resource),
        `${where} has no resource.`,
        'Set "resource" to the absolute URL of the paid endpoint, as a plain string. It is ' +
          'what the client signs against and what a settlement is attributed to.'
      );
    }

    report.check(
      'V1_PAYTO',
      ADDRESS_RE.test(String(entry.payTo || '')),
      entry.payTo ? `${where} payTo "${clip(entry.payTo)}" is not a 0x EVM address.`
        : `${where} has no payTo — there is nowhere to send the money.`,
      'payTo is the 0x-prefixed, 40-hex-character receiving address.'
    );
    report.check(
      'V1_ASSET',
      nonEmptyString(entry.asset),
      `${where} names no asset.`,
      'Set "asset" to the token contract on that chain — USDC on Base is ' +
        '"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".'
    );
    report.check(
      'V1_MIMETYPE',
      nonEmptyString(entry.mimeType),
      `${where} has no mimeType.`,
      'Add "mimeType" naming what a successful response returns, e.g. "application/json". ' +
        'v1 carries it on the accepts entry; v2 moved it onto the resource object.'
    );
    report.check(
      'V1_DESCRIPTION',
      nonEmptyString(entry.description),
      `${where} has no description.`,
      'Add one sentence saying what the call does, under 500 characters. It is what an agent ' +
        'reads before deciding to pay.'
    );
    report.check(
      'V1_MAX_TIMEOUT',
      Number.isFinite(Number(entry.maxTimeoutSeconds)) && Number(entry.maxTimeoutSeconds) > 0,
      `${where} has no usable maxTimeoutSeconds.`,
      'Set "maxTimeoutSeconds" — 60 is the common value. The client uses it for validBefore ' +
        'on the authorization it signs.'
    );
    report.check(
      'V1_EXTRA_EIP712',
      isObject(entry.extra) && nonEmptyString(entry.extra.name) && entry.extra.version !== undefined,
      `${where} has no extra.{name,version} — the EIP-712 domain is missing.`,
      'Add "extra": { "name": "USD Coin", "version": "2" } for USDC on Base — the token\'s ' +
        'on-chain name(), not its ticker. The client builds the typed-data domain from these ' +
        'with no fallback; omit them and every genuine payment fails as ' +
        'invalid_exact_evm_payload_signature with nothing in your logs to explain it.'
    );

    const outputSchema = entry.outputSchema;
    const hasOutputSchema = report.check(
      'V1_OUTPUT_SCHEMA',
      isObject(outputSchema),
      `${where} has no outputSchema.`,
      'Add "outputSchema": { "input": { "type": "http", "method": "POST", "discoverable": ' +
        'true, "bodyType": "text", "description": "…" }, "output": { "type": "string", ' +
        '"description": "…" } }. It is what makes a v1 resource indexable rather than merely ' +
        'payable; v2 replaced it with extensions.bazaar.'
    );
    if (hasOutputSchema) {
      report.check(
        'V1_DISCOVERABLE',
        isObject(outputSchema.input) && outputSchema.input.discoverable === true,
        `${where} outputSchema does not set input.discoverable = true.`,
        'Set "discoverable": true INSIDE outputSchema.input — not at the top level of ' +
          'outputSchema, and not on the accepts entry. It is the v1 opt-in to being indexed, ' +
          'and putting it one level up is the commonest way to be quietly left out.'
      );
    }
  }
  report.endAccepts();
  acceptsTruncated(report, accepts, 'v1');
}

// ------------------------------------------------------------------ dual-stack

/**
 * When both versions are published they are two views of ONE offer. A divergence
 * is not a style question: your two generations of buyers are being quoted
 * different terms, and only one of them can be the one you meant.
 */
function lintDualStack(report, v1, v2) {
  const a = v1?.accept;
  const b = v2?.accept;
  if (!isObject(a) || !isObject(b)) return;

  report.check(
    'DUAL_PAYTO',
    String(a.payTo || '').toLowerCase() === String(b.payTo || '').toLowerCase(),
    `the v1 envelope pays ${clip(a.payTo || '(nothing)')} and the v2 envelope pays ${clip(b.payTo || '(nothing)')}.`,
    'Build both envelopes from ONE requirements object rather than assembling each ' +
      'separately — derive the v2 accepts entry from the v1 one. Divergent payTo means half ' +
      'your revenue lands in an address you may no longer control.'
  );

  const price1 = a.maxAmountRequired ?? a.amount;
  const price2 = b.amount ?? b.maxAmountRequired;
  report.check(
    'DUAL_PRICE',
    String(price1 ?? '') === String(price2 ?? ''),
    `the v1 envelope asks ${clip(price1 ?? '(nothing)')} and the v2 envelope asks ${clip(price2 ?? '(nothing)')} atomic units.`,
    'Quote one price and project it into both envelopes. Your two generations of buyers ' +
      'currently see different terms for the same call, and the cheaper one is the one you ' +
      'will be held to.'
  );

  // NETWORK. Both sides have to RESOLVE to a chain before a mismatch between
  // them means anything, and V1_NETWORK_CHAIN is a nine-entry table of the
  // chains x402 clients ship with — not a list of the chains that exist. A v1
  // name outside it (`arbitrum`, `optimism`, `solana`) resolved to null, null
  // compared unequal to the v2 side, and a correctly paired dual-stack envelope
  // on any chain the table had not heard of graded F for a fault that was in
  // this file rather than in the envelope.
  //
  // Unknown is now INFO and says so plainly. It is the same leniency
  // V1_NETWORK_NAME already extends — it accepts any plain name, because a name
  // it does not recognise is a chain it does not know, not a wrong chain.
  const chain1 = chainOf(a.network);
  const chain2 = chainOf(b.network);
  const bothResolve = chain1 !== null && chain2 !== null;
  const pair = `the v1 envelope is on ${clip(a.network || '(nothing)')} and the v2 envelope on ${clip(b.network || '(nothing)')}`;
  if (bothResolve) {
    report.check(
      'DUAL_NETWORK',
      chain1 === chain2,
      `${pair} — chains ${clip(chain1)} and ${clip(chain2)}.`,
      'The two envelopes must name the SAME chain in each version\'s spelling — "base" in v1, ' +
        '"eip155:8453" in v2. A genuine chain difference means a payment signed on one chain ' +
        'is worthless on the other.'
    );
  } else {
    report.check(
      'DUAL_NETWORK',
      false,
      `${pair} — this linter does not recognise ${
        chain1 === null ? 'the v1 name' : 'the v2 identifier'
      }, so it could not verify that the two name the same chain.`,
      'Check by hand that the two spellings are the same chain — the v1 plain name and the v2 ' +
        'CAIP-2 id, e.g. "arbitrum" and "eip155:42161". This linter only knows the nine chains ' +
        'x402 clients ship a mapping for, so an unrecognised pair is reported as unverified ' +
        'rather than as wrong. If they DO disagree, a payment signed on one chain is worthless ' +
        'on the other.',
      'info'
    );
  }

  report.check(
    'DUAL_ASSET',
    String(a.asset || '').toLowerCase() === String(b.asset || '').toLowerCase(),
    `the v1 envelope wants ${clip(a.asset || '(nothing)')} and the v2 envelope wants ${clip(b.asset || '(nothing)')}.`,
    'Name one token contract in both envelopes. Different assets means the two versions are ' +
      'selling for different money.'
  );

  const url1 = typeof a.resource === 'string' ? a.resource : a.resource?.url;
  const url2 = typeof v2.resource === 'string' ? v2.resource : v2.resource?.url;
  if (url1 || url2) {
    report.check(
      'DUAL_RESOURCE',
      String(url1 || '').replace(/\/$/, '') === String(url2 || '').replace(/\/$/, ''),
      `the v1 envelope names ${clip(url1 || '(nothing)')} and the v2 envelope names ${clip(url2 || '(nothing)')}.`,
      'Point both at the same absolute URL. Discovery indexes key settlements on the ' +
        'resource, so two URLs split one endpoint\'s track record across two listings.'
    );
  }
}

// ------------------------------------------------------------------ entry point

/**
 * Lint one HTTP response.
 *
 * @param {object} response
 * @param {number} response.status
 * @param {object} response.headers     plain object; lookup is case-insensitive
 * @param {string} response.body        the response body as text
 * @param {string} [response.url]       the URL that was called, when known
 * @param {string} [response.method]    the method used, when known
 * @param {string} [response.redirectedTo] Location, when the answer was a 3xx
 * @returns {{grade: string, summary: object, findings: object[], checks_run: number}}
 */
export function lint(response) {
  const report = new Report();
  const { status, headers = {}, body = '', url = null, redirectedTo = null } = response || {};

  // --- HTTP layer -------------------------------------------------------
  const is3xx = status >= 300 && status < 400;
  report.check(
    'HTTP_REDIRECT',
    !is3xx && !redirectedTo,
    is3xx
      ? `the endpoint answered ${status}${redirectedTo ? ` to ${clip(redirectedTo)}` : ''} instead of a 402.`
      : `the 402 was reached through a redirect to ${clip(redirectedTo)}.`,
    'Serve the 402 directly at the advertised URL. x402 clients do not follow redirects ' +
      'before reading the envelope — the paid request is a POST with a payment header, and ' +
      'redirecting it drops the header — so a 402 behind a redirect is a 402 the buyer never ' +
      'sees. Advertise the final URL in resource.url instead.' +
      (redirectedTo
        ? ` This report is about the redirect itself: to lint the envelope, run this again ` +
          `against ${clip(redirectedTo)} directly.`
        : ' To lint the envelope, run this again against the final URL directly.')
  );

  report.check(
    'HTTP_SERVER_ERROR',
    !(status >= 500),
    `the endpoint answered ${status} — a server error, not a payment challenge.`,
    'Fix the 5xx first; nothing else in this report can be trusted while the endpoint is ' +
      'failing. Check that the payment middleware is not throwing on a request with no ' +
      'payment header — that path is the one every unauthenticated caller takes.'
  );

  if (status === 200) {
    report.check(
      'HTTP_FREE_TIER_200',
      false,
      'an unauthenticated request was served a 200 — this endpoint has a free tier.',
      'Answer 402 to unauthenticated requests. CDP Bazaar\'s prober calls your endpoint with ' +
        'no payment on an interval and expects a 402; a free tier hands the prober a 200, ' +
        'which fails the check and DELISTS an endpoint that was already indexed. If you want ' +
        'a trial allowance, gate it behind an API key or a header the prober does not send, ' +
        'so the anonymous path stays 402.'
    );
  }
  // A 404 or a 405 is very often not a missing endpoint at all — it is a GET-only
  // resource answering a POST, which is the method this linter sends by default.
  // Saying "your route is not wired up" to someone whose route is fine, and
  // grading them F for it, is a report that sends the seller looking in the
  // wrong place. The retry is one field.
  const methodMayBeWrong = status === 405 || status === 404;
  report.check(
    'HTTP_STATUS_402',
    status === 402 || status === 200 || is3xx,
    `the endpoint answered ${status}, not 402.`,
    'An unauthenticated request to a paid x402 endpoint must answer HTTP 402 with the ' +
      'envelope. A 401 or 403 tells a client to find credentials, which is the opposite of ' +
      'what x402 offers; a 404 means your route is not wired up at all.' +
      (methodMayBeWrong
        ? ` A ${status} to the POST this linter sends is just as often a GET-only endpoint: ` +
          'try again with {"method": "GET"} before changing anything. If GET answers 402, the ' +
          'endpoint is fine and the finding is this linter using the wrong verb — but say so ' +
          'in the envelope too, as resource.method and bazaar.info.input.method, or every ' +
          'agent that finds your listing will call it wrong on the first try.'
        : '')
  );

  // --- the two envelopes ------------------------------------------------
  //
  // THE ENVELOPE CHECKS ARE GATED ON THE STATUS, and the reason is that a 402 is
  // the only response an envelope was ever promised in. A 307 to the real
  // endpoint carries no envelope because there is nothing to carry one for; so
  // does a 200 from a free tier, and so does a 405 to the wrong verb. Running
  // the cascade on those produced "no x402 envelope was found — neither a JSON
  // body nor a PAYMENT-REQUIRED header" for a redirect, which is true, useless,
  // and an F for an endpoint whose envelope nobody has looked at yet.
  //
  // The status-level finding above already says what happened. What follows
  // runs only when there is something to read: a 402, or a non-402 that
  // published an envelope anyway (which IS worth linting — some sellers do).
  const headerPresent = nonEmptyString(headerOf(headers, PAYMENT_REQUIRED_HEADER));
  const bodyLooksLikeEnvelope = isV1Attempt(parseJson(body));
  const readEnvelopes = status === 402 || headerPresent || bodyLooksLikeEnvelope;

  const v2 = readEnvelopes ? lintV2(report, headers, url) : null;
  const v1 = readEnvelopes ? lintV1(report, body, headerOf(headers, 'content-type'), v2 !== null) : null;

  const versions = [];
  if (v1?.env) versions.push(1);
  if (v2?.env) versions.push(2);

  if (readEnvelopes) {
    report.check(
      'ENVELOPE_PRESENT',
      versions.length > 0,
      'no x402 envelope was found — neither a JSON body nor a PAYMENT-REQUIRED header.',
      'Publish at least one envelope. The dual-stack answer is one 402 carrying BOTH: the v1 ' +
        'envelope as the JSON body, and the v2 envelope as standard base64 in a ' +
        'PAYMENT-REQUIRED response header. Neither client version looks at the other\'s ' +
        'transport, so serving both costs one extra header and reaches every buyer.'
    );
  }

  if (v1 && v2) lintDualStack(report, v1, v2);

  // --- summary ----------------------------------------------------------
  const accept2 = v2?.accept;
  const accept1 = v1?.accept;
  const atomic = accept2?.amount ?? accept1?.maxAmountRequired ?? accept2?.maxAmountRequired ?? accept1?.amount;
  const price = formatPrice(atomic);

  // THE SUMMARY QUOTES THE ENVELOPE TOO, and it was the last unbounded echo:
  // four fields copied verbatim out of attacker-controlled JSON, which made a
  // 20 KB `network` string a 20 KB summary however short the findings were.
  //
  // `price` is the one that is easy to miss, because it looks derived rather
  // than copied: formatPrice() takes any run of digits and returns a dollar
  // figure the same length, so a 60,000-digit `amount` produced a 60,000-
  // character price while the atomic value beside it was dutifully clipped to
  // 40. Everything that leaves here goes through clip(), including the things
  // this file computed itself.
  const payTo = accept2?.payTo ?? accept1?.payTo ?? null;
  const network = accept2?.network ?? accept1?.network ?? null;
  const summary = {
    versions_detected: versions,
    payTo: payTo == null ? null : clip(payTo, 80),
    network: network == null ? null : clip(network, 80),
    price: price
      ? `${clip(price, 40)} (${clip(atomic, 40)} atomic)`
      : atomic != null
        ? clip(atomic, 40)
        : null,
  };

  // A PARTIAL REPORT SAYS SO. Half a report read as a whole one is the failure
  // mode this whole file exists to prevent in other people's envelopes.
  if (!readEnvelopes) {
    summary.partial = `the endpoint answered ${status}, not 402, and published no envelope, so none of the ${
      CHECKS.filter((c) => c.area === 'v1' || c.area === 'v2' || c.area === 'dual' || c.area === 'version').length
    } envelope checks could run. ${
      is3xx ? 'Lint the redirect target directly.' : 'Lint the URL and method that answer the 402.'
    }`;
  }

  const findings = report.findings;
  if (report.suppressed) {
    report.ran_('FINDINGS_TRUNCATED', false);
    findings.push({
      severity: 'info',
      code: 'FINDINGS_TRUNCATED',
      message: `this report was capped at ${MAX_FINDINGS} findings; ${report.suppressed} further findings were suppressed.`,
      fix:
        'Fix what is listed and lint again — the suppressed findings are almost certainly more ' +
        'of the same. A report this long usually means one fault repeated across a long ' +
        'accepts[] array rather than that many distinct problems.',
    });
  }

  return { grade: grade(findings), summary, findings, checks_run: report.ran.size };
}

/** JSON.parse that answers `undefined` instead of throwing. */
function parseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Normalise a real `Response` into what lint() takes.
 *
 * Kept here rather than in the Worker so the shape lint() consumes has exactly
 * one definition, and a test can hand it a constructed Response.
 */
export async function responseToInput(res, { url = null, method = null, maxBytes = 256 * 1024 } = {}) {
  const headers = {};
  for (const [key, value] of res.headers) headers[key.toLowerCase()] = value;

  const buf = await res.arrayBuffer();
  const clipped = buf.byteLength > maxBytes;
  const body = new TextDecoder('utf-8').decode(clipped ? buf.slice(0, maxBytes) : buf);

  return {
    status: res.status,
    headers,
    body,
    url,
    method,
    redirectedTo: res.status >= 300 && res.status < 400 ? res.headers.get('location') : null,
    truncated: clipped,
  };
}
