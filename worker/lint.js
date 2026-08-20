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
//
// ------------------------------------------------------------------ the three regimes
//
// A CHECK IS ONLY TRUE RELATIVE TO AN AUTHORITY, and this catalogue answers to
// three of them. Collapsing them into one grade was the single largest source
// of wrong verdicts in the accuracy audit that produced this file: the same
// envelope was simultaneously perfectly payable and un-indexable, and one
// number could not say both.
//
//   regime: 'payment'  the specs' MUSTs and what shipping clients (@x402/core,
//                      @x402/evm, x402-fetch, x402@1.2.0) actually parse, throw
//                      on, or refuse to sign. THESE DRIVE THE GRADE.
//   regime: 'bazaar'   CDP's validator, prober and seller docs — what it takes
//                      to be INDEXED. These drive `summary.bazaar_ready` and
//                      never the grade, because an endpoint that takes money
//                      correctly and is not listed is not broken, it is unlisted.
//   regime: 'hygiene'  house opinions and client-quirk defenses that break no
//                      payment and block no indexing. Info only, always.
//
// Two dimensions, and a seller can read either one without the other lying to
// them: `grade` answers "can I be paid", `bazaar_ready` answers "can I be found".
//
// ------------------------------------------------------------------ sources
//
// EVERY CHECK CARRIES ITS PROVENANCE, as `sources: [{ kind, ref }]`, and it is
// published at GET /check alongside the rule. The kinds are
//
//   spec | client-code | cdp-docs | cdp-validator | live | field-report |
//   house-opinion
//
// and `house-opinion` is a first-class entry rather than an embarrassment: the
// point is that an opinion is LABELLED as one, so a reader can tell the
// difference between "the specification says so" and "we think so". A claim
// with no source is the thing this array exists to make impossible.
//
// The refs are exact — a file and a section, or a file and a line — and they
// are the reason a source moving is a greppable event rather than a slow rot.
// When @x402/core changes its network schema, `grep -l 'schemas/index.js'`
// names every check that has to be re-argued.
//
// Client refs are package-relative (`@x402/core@2.23.0 dist/cjs/…`) rather than
// absolute paths: the version is part of the claim, and a path on one machine
// is not.

import { validateAgainstSchema } from './json-schema.js';

// ------------------------------------------------------------------ constants

/**
 * A 0x-prefixed 20-byte EVM address.
 *
 * Byte-identical to x402@1.2.0's own `EvmAddressRegex`
 * (dist/esm/chunk-V3RMM5AE.mjs:383). IT IS APPLIED ONLY TO eip155 ENTRIES —
 * applying it to every network is what graded a spec-conformant Solana
 * envelope F, and the `payTo` row of the v2 spec's PaymentRequirements table
 * (x402-specification-v2.md:128) reads "Recipient wallet address **or role
 * constant** (e.g., \"merchant\")".
 */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * A base58 Solana address, from x402@1.2.0's `SvmAddressRegex`
 * (dist/esm/chunk-V3RMM5AE.mjs:361). Base58 excludes 0, O, I and l.
 */
const SVM_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Standard base64 with optional padding, and NOTHING ELSE.
 *
 * This is @x402/core's own Base64EncodedRegex. A url-safe envelope (`-`/`_`
 * instead of `+`/`/`) is thrown out by the client BEFORE it is decoded, which
 * from the buyer's side is indistinguishable from a seller that published no
 * envelope at all — the most expensive one-character bug in this space.
 */
const STANDARD_B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * WHAT THE CLIENT ACTUALLY REQUIRES OF A v2 NETWORK STRING.
 *
 * @x402/core@2.23.0 dist/cjs/schemas/index.js:63-65 is the whole of it:
 *
 *     NetworkSchemaV2 = z.string().min(3).refine(val => val.includes(":"))
 *
 * Three characters and a colon. Nothing about namespace length, nothing about
 * the charset. This is the PASS/FAIL line, because it is the line a buyer's
 * parser draws — and the older, tighter CAIP-2 regex below drew it in a
 * different place, which rejected `cloudflare:402`: a network the x402
 * specification pack defines a scheme for
 * (schemes/batch-settlement/scheme_batch_settlement_cloudflare.md:7) and calls
 * CAIP-2 format at :107. A ten-character namespace graded F.
 */
const networkParses = (network) => typeof network === 'string' && network.length >= 3 && network.includes(':');

/**
 * CAIP-2 proper: a 3–8 character namespace and a reference of up to 32.
 *
 * KEPT, BUT DEMOTED TO A STYLE NOTE. CAIP-2 bounds the namespace and x402's own
 * §11.1 says networks "use CAIP-2 format", so a string outside this shape is
 * worth mentioning — but no client enforces it, so mentioning it is all it may
 * do. The distinction between "the client rejects this" and "the registry
 * would not have minted this" is exactly the distinction between an error and
 * an info.
 */
const CAIP2_RE = /^[a-z0-9][a-z0-9-]{2,7}:[a-zA-Z0-9._-]{1,32}$/;

/** The namespace half of a CAIP-2 identifier, lowercased. `null` when there is none. */
const namespaceOf = (network) =>
  typeof network === 'string' && network.includes(':') ? network.slice(0, network.indexOf(':')).toLowerCase() : null;

/**
 * The namespaces this linter validates the INSIDE of an accepts entry against.
 *
 * Anything else — `cloudflare:402`, `ach:us`, a namespace invented next week —
 * is checked structurally and then left alone, with an info saying so. A linter
 * that treats "I have not heard of this" as "this is wrong" is a linter that
 * gets worse every time the ecosystem grows.
 */
const DEEP_NAMESPACES = new Set(['eip155', 'solana']);

/** USDC on Base has 6 decimals; atomic → dollars for the summary line. */
const USDC_DECIMALS = 6;

/**
 * The v1 network vocabulary, verbatim from the client that enforces it.
 *
 * x402@1.2.0 dist/esm/chunk-V3RMM5AE.mjs:16-34 is a `z.enum` of exactly these
 * seventeen names, and x402-fetch@1.2.0 dist/esm/index.mjs:23 runs EVERY
 * accepts entry through the schema that uses it. A name outside the list is a
 * ZodError before any payment is attempted — so the enum is closed, and it
 * admits no CAIP-2 identifier, which settles the question the audit left open.
 *
 * (@x402/core@2.23.0's v1-compatibility schema is looser — `NetworkSchemaV1 =
 * NonEmptyString`, schemas/index.js:62 — so this is a claim about the dominant
 * v1 client rather than about every parser that exists. Hence error, not core.)
 */
const V1_NETWORK_ENUM = [
  'abstract', 'abstract-testnet', 'base-sepolia', 'base', 'avalanche-fuji', 'avalanche',
  'iotex', 'solana-devnet', 'solana', 'sei', 'sei-testnet', 'polygon', 'polygon-amoy',
  'peaq', 'story', 'educhain', 'skale-base-sepolia',
];

/** The v1 names that denote a Solana chain — where payTo and asset are base58. */
const V1_SVM_NETWORKS = new Set(['solana', 'solana-devnet']);

/**
 * The only scheme any v1 client will parse.
 *
 * x402@1.2.0 dist/esm/chunk-V3RMM5AE.mjs:387 `var schemes = ["exact"]` and :438
 * `scheme: z3.enum(schemes)`. v2 left the scheme field open on purpose; v1
 * never did, and the difference is why V1_SCHEME_KNOWN is an error where
 * V2_SCHEME_KNOWN is an info.
 */
const V1_SCHEMES = ['exact'];

/**
 * The v2 schemes with a published specification in `specs/schemes/`.
 *
 * `exact` and `upto` are the two CDP's validator names (preflight[8], expected
 * "exact or upto"); `batch-settlement` and `auth-capture` have scheme documents
 * and shipped clients. v2's scheme field is extensible by design, so this is an
 * info — but calling `upto` "not the scheme most clients implement" was simply
 * false.
 */
const KNOWN_V2_SCHEMES = ['exact', 'upto', 'batch-settlement', 'auth-capture'];

/**
 * The eip155 chains CDP's facilitator settles on, from the validator's own
 * expectation string: "a facilitator-supported network (Base, Solana, Polygon,
 * Arbitrum, World)" (cdp-validator-toolshed.json preflight[9]).
 *
 * A chain outside this set is perfectly legal x402 and perfectly payable by a
 * self-hosted facilitator. It is only un-indexable BY CDP, which is what the
 * bazaar regime is for.
 */
const CDP_FACILITATOR_CHAINS = new Set([
  'eip155:8453', 'eip155:84532',     // Base, Base Sepolia
  'eip155:137', 'eip155:80002',      // Polygon, Amoy
  'eip155:42161', 'eip155:421614',   // Arbitrum One, Sepolia
  'eip155:480', 'eip155:4801',       // World Chain, Sepolia
]);

/**
 * CDP's price floor: 1000 atomic units of a 6-decimal stablecoin, i.e. $0.001.
 *
 * cdp-validator-toolshed.json preflight[11] — {"check":"accepts[0].amount",
 * "severity":"required","expected":">= 1000"}. Nothing in the protocol says a
 * seller may not charge less; CDP will not index them if they do.
 */
const CDP_MIN_AMOUNT_ATOMIC = 1000n;

/**
 * The description length CDP's facilitator rejects past.
 *
 * https://docs.cdp.coinbase.com/x402/seller/get-discovered — "Keep it to 500
 * characters or fewer, because the CDP Facilitator rejects verify and settle
 * requests whose description exceeds that limit". This number used to appear in
 * the fix text with no source behind it and nothing enforcing it; now it has one
 * and does both.
 */
const CDP_MAX_DESCRIPTION = 500;

/** bazaar.md:389-390 — serviceName ≤ 32 printable ASCII; tags ≤ 5 of the same. */
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;
const MAX_SERVICE_NAME = 32;
const MAX_TAGS = 5;
const MAX_TAG_LENGTH = 32;

/** bazaar.md:251-269 — the two HTTP method families, and the body-carrying one. */
const BAZAAR_QUERY_METHODS = ['GET', 'HEAD', 'DELETE'];
const BAZAAR_BODY_METHODS = ['POST', 'PUT', 'PATCH'];
const BAZAAR_BODY_TYPES = ['json', 'form-data', 'text'];

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
// out-of-memory for the price of one call.
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
export const MAX_ACCEPTS_LINTED = 8;

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
// merely impoverished. A single core PAYMENT-regime error is an F: the endpoint
// does not work. `regime` and `sources` are documented at the top of this file.
//
// A few checks report the same concern at two weights depending on what else is
// present — V2_RESOURCE_DESCRIPTION is an info when absent and an error when
// past CDP's 500-character limit. The entry carries the LOUDEST severity it can
// emit, and the summary says both, because a catalogue that advertised the
// quiet one would understate what the check can cost.

/** The three authorities a check can answer to. See the note at the top of the file. */
export const REGIMES = ['payment', 'bazaar', 'hygiene'];

/** The kinds of provenance a check may cite. `house-opinion` is legitimate; unlabelled is not. */
export const SOURCE_KINDS = ['spec', 'client-code', 'cdp-docs', 'cdp-validator', 'live', 'field-report', 'house-opinion'];

/** Provenance constructors. The kinds are fixed; see the note at the top of the file. */
const spec = (ref) => ({ kind: 'spec', ref });
const client = (ref) => ({ kind: 'client-code', ref });
const cdpDocs = (ref) => ({ kind: 'cdp-docs', ref });
const validator = (ref) => ({ kind: 'cdp-validator', ref });
const live = (ref) => ({ kind: 'live', ref });
const field = (ref) => ({ kind: 'field-report', ref });
const house = (ref) => ({ kind: 'house-opinion', ref });

// The refs quoted often enough that writing them once is the only way they stay
// identical — and identical is the whole point of a greppable citation.
const V2_ACCEPTS_TABLE = 'specs/x402-specification-v2.md:120-131 § 5.1.2 (PaymentRequirements table)';
const V2_RESOURCE_TABLE = 'specs/x402-specification-v2.md:132-141 § 5.1.2 (ResourceInfo table)';
const V2_EXTENSIONS_TABLE = 'specs/x402-specification-v2.md:143-149 § 5.1.2 (Extensions table)';
const V1_ACCEPTS_TABLE = 'specs/x402-specification-v1.md:110-124 § 5.1.2 (PaymentRequirements table)';
const CORE_SCHEMAS = '@x402/core@2.23.0 dist/cjs/schemas/index.js';
const V1_CLIENT_SCHEMAS = 'x402@1.2.0 dist/esm/chunk-V3RMM5AE.mjs';
const V1_FETCH = 'x402-fetch@1.2.0 dist/esm/index.mjs:22-23 (response.json(), then PaymentRequirementsSchema.parse per entry)';
const V2_TRANSPORT = 'specs/transports-v2/http.md:7-25 § Payment Required Signaling';
const V1_TRANSPORT = 'specs/transports-v1/http.md § Payment Required Signaling';
const BODY_IS_SERVER_CONCERN = 'specs/transports-v2/http.md:172-174 § Response Body ("Response bodies are a server implementation concern")';

export const CHECKS = [
  // --- HTTP layer -------------------------------------------------------
  //
  // HTTP_STATUS_402 IS CORE EXCEPT ON 404 AND 405, and the exception is not a
  // softening. This linter sends POST by default; a GET-only endpoint answering
  // 405 to it is a conformant endpoint and a wrong guess about the verb. Grading
  // that F, and then telling the seller in the fix text to retry with GET, was a
  // report contradicting itself in two adjacent sentences.
  { id: 'HTTP_STATUS_402', area: 'http', severity: 'error', core: true, regime: 'payment',
    summary:
      'an unauthenticated request answers 402 — not core on a 404/405, which is as often the wrong ' +
      'verb as a missing route, and a 200 or a redirect is delegated to HTTP_FREE_TIER_200 and ' +
      'HTTP_REDIRECT rather than counted here twice',
    sources: [
      spec(V2_TRANSPORT), spec(V1_TRANSPORT),
      client('x402-fetch@1.2.0 dist/esm/index.mjs:19 (`if (response.status !== 402) return response`)'),
      validator('cdp-validator-toolshed.json preflight[3] returns_402 (required)'),
    ] },
  // PAYMENT REGIME, NOT BAZAAR, EVEN THOUGH THE EVIDENCE IS CDP'S. A 200 to an
  // unauthenticated caller means an x402 client never enters the payment flow
  // at all — `if (response.status !== 402) return response` — so the anonymous
  // path earns nothing from an x402 buyer. The indexing consequence is real too
  // and the fix text says so, but the check belongs where its worst outcome is.
  { id: 'HTTP_FREE_TIER_200', area: 'http', severity: 'warn', regime: 'payment',
    summary: 'no free tier serving 200s to unauthenticated callers',
    sources: [
      client('x402-fetch@1.2.0 dist/esm/index.mjs:19 — a non-402 is returned unpaid; the client never attempts payment'),
      validator('cdp-validator-toolshed.json preflight[3] returns_402 (required)'),
      cdpDocs('https://docs.cdp.coinbase.com/x402/seller/get-discovered — endpoints are health-probed on an interval'),
    ] },
  { id: 'HTTP_SERVER_ERROR', area: 'http', severity: 'error', core: true, regime: 'payment',
    summary: 'the endpoint is not 5xx',
    sources: [
      spec('specs/transports-v2/http.md:176-186 § Error Handling'),
      client('x402-fetch@1.2.0 dist/esm/index.mjs:19 — a 5xx is returned unpaid'),
      validator('cdp-validator-toolshed.json preflight[2] endpoint_reachable (required)'),
    ] },
  { id: 'HTTP_REDIRECT', area: 'http', severity: 'warn', regime: 'payment',
    summary: 'the 402 is not behind a redirect',
    sources: [
      client('@x402/fetch@2.23.0 dist/esm/index.mjs:10 — `await fetch(request)`, i.e. the default redirect mode, so redirects ARE followed'),
      spec('RFC 9110 § 15.4.3 — 301/302 rewrite POST to GET; 307/308 do not'),
      validator('cdp-validator-toolshed.json preflight[0] url_valid — the ADVERTISED url is what is probed'),
    ] },
  { id: 'HTTP_CONTENT_TYPE_JSON', area: 'http', severity: 'warn', regime: 'payment',
    summary: 'the v1 envelope body is served as JSON',
    sources: [
      spec('specs/transports-v1/http.md § Payment Required Signaling (Content-Type: application/json)'),
      client('@x402/core@2.23.0 dist/esm/chunk-BA2VL4DT.mjs:2163 — processResponse parses the body only when content-type includes application/json'),
      house('x402-fetch@1.2.0 dist/esm/index.mjs:22 does NOT branch on content-type, so this costs some client paths and not the main v1 one — hence warn'),
    ] },
  { id: 'ENVELOPE_PRESENT', area: 'http', severity: 'error', core: true, regime: 'payment',
    summary: 'at least one x402 envelope is published',
    sources: [
      spec(V2_TRANSPORT), spec(V1_TRANSPORT),
      client('@x402/core@2.23.0 dist/cjs/http/index.js:1620-1628 — no header and no v1 body throws "Invalid payment required response"'),
    ] },

  // --- v2 envelope ------------------------------------------------------
  //
  // A v1-ONLY ENDPOINT IS NOT BROKEN, IT IS UNLISTED. @x402/core's
  // getPaymentRequiredResponse falls back to a v1 body when there is no header
  // (dist/cjs/http/index.js:1620-1628), so the current client generation pays a
  // v1-only seller perfectly well. What that seller loses is CDP indexing,
  // where the header is a REQUIRED preflight — which is the bazaar regime
  // exactly, and why this is an error there rather than a warn against a grade.
  { id: 'V2_HEADER_PRESENT', area: 'v2', severity: 'error', regime: 'bazaar',
    summary: 'a PAYMENT-REQUIRED response header is present (CDP will not index a v1-only 402)',
    sources: [
      spec(V2_TRANSPORT),
      validator('cdp-validator-toolshed.json preflight[6] payment_required_header (required)'),
      client('@x402/core@2.23.0 dist/cjs/http/index.js:1620-1628 — the v2 client DOES fall back to a v1 body'),
      field('x402-foundation/x402#3091 — x402-fetch@1.x is still a live buyer population'),
    ] },
  { id: 'V2_B64_URLSAFE', area: 'v2', severity: 'error', core: true, regime: 'payment',
    summary: 'the header is standard base64, not base64url',
    sources: [
      client('@x402/core@2.23.0 dist/cjs/utils/index.js:133 — Base64EncodedRegex = /^[A-Za-z0-9+/]*={0,2}$/'),
      client('@x402/core@2.23.0 dist/cjs/http/index.js:1778-1781 — the regex is tested on the RAW header, then it throws, before any decode'),
      spec(V2_TRANSPORT),
    ] },
  { id: 'V2_B64_DECODE', area: 'v2', severity: 'error', core: true, regime: 'payment',
    summary: 'the header decodes as base64',
    sources: [
      client('@x402/core@2.23.0 dist/cjs/http/index.js:1781 — JSON.parse(safeBase64Decode(header)), uncaught'),
      spec(V2_TRANSPORT),
    ] },
  { id: 'V2_JSON', area: 'v2', severity: 'error', core: true, regime: 'payment',
    summary: 'the decoded header is JSON',
    sources: [
      client('@x402/core@2.23.0 dist/cjs/http/index.js:1781 — a SyntaxError escapes decodePaymentRequiredHeader'),
      spec('specs/x402-specification-v2.md:72-107 § 5.1.1 JSON Payload'),
    ] },
  { id: 'V2_VERSION', area: 'v2', severity: 'error', core: true, regime: 'payment',
    summary: 'the v2 payload declares x402Version 2',
    sources: [
      spec('specs/x402-specification-v2.md:114 § 5.1.2 — x402Version Required, "must be 2"'),
      client(`${CORE_SCHEMAS}:111 — x402Version: z.literal(2), inside a discriminatedUnion`),
      field('x402-foundation/x402#3045 wire-format bug 1 — a v1-shaped challenge on a v2 resource'),
    ] },
  { id: 'V2_ACCEPTS_NONEMPTY', area: 'v2', severity: 'error', core: true, regime: 'payment',
    summary: 'accepts[] is a non-empty array',
    sources: [
      spec('specs/x402-specification-v2.md:117 § 5.1.2 — accepts Required'),
      client(`${CORE_SCHEMAS}:114 — accepts: z.array(PaymentRequirementsV2Schema).min(1)`),
      validator('cdp-validator-toolshed.json preflight[7] has_accepts (required)'),
    ] },
  { id: 'V2_SCHEME', area: 'v2', severity: 'error', core: true, regime: 'payment',
    summary: 'each accept names a scheme',
    sources: [
      spec(V2_ACCEPTS_TABLE),
      client(`${CORE_SCHEMAS}:102 — scheme: NonEmptyString`),
    ] },
  { id: 'V2_SCHEME_KNOWN', area: 'v2', severity: 'info', regime: 'payment',
    summary: 'the scheme has a published specification (v2 leaves the field open, so this is an info)',
    sources: [
      spec('specs/schemes/ — exact, upto, batch-settlement, auth-capture each have a scheme document'),
      validator('cdp-validator-toolshed.json preflight[8] accepts[0].scheme, expected "exact or upto"'),
      client(`${CORE_SCHEMAS}:102 — the v2 schema accepts any non-empty string, by design`),
    ] },
  { id: 'V2_NETWORK_CAIP2', area: 'v2', severity: 'error', core: true, regime: 'payment',
    summary: 'network contains a colon (the client’s rule), and is not a v1 plain name',
    sources: [
      spec('specs/x402-specification-v2.md:125 § 5.1.2 — network Required, CAIP-2 format'),
      spec('specs/x402-specification-v2.md:616-621 § 11.1 Network Identifiers'),
      client(`${CORE_SCHEMAS}:63-65 — NetworkSchemaV2 = z.string().min(3).refine(v => v.includes(":"))`),
    ] },
  { id: 'V2_NETWORK_CAIP2_STYLE', area: 'v2', severity: 'info', regime: 'hygiene',
    summary: 'the network string is CAIP-2 shaped (3–8 character namespace) — a style note, not a client rule',
    sources: [
      spec('specs/x402-specification-v2.md:616-621 § 11.1 — "Networks in x402 v2 use CAIP-2 format"'),
      house('no shipping client bounds the namespace; @x402/core requires only min(3) and a colon, so this may only be an info'),
    ] },
  { id: 'V2_NAMESPACE_KNOWN', area: 'v2', severity: 'info', regime: 'hygiene',
    summary: 'the report says so when a network namespace was checked structurally rather than deeply',
    sources: [
      spec('specs/x402-specification-v2.md:616-621 § 11.1 — namespaces are open-ended; "ach:us" and "sepa:eu" are given as examples'),
      spec('specs/schemes/batch-settlement/scheme_batch_settlement_cloudflare.md:7 — cloudflare:402 is a real network with its own scheme document'),
      house('worker/lint.js addressFamily() — eip155 and solana are the namespaces whose address formats this linter knows; everything else is checked structurally, and the report says which'),
    ] },
  { id: 'V2_NETWORK_SUPPORTED', area: 'v2', severity: 'warn', regime: 'bazaar',
    summary: 'the eip155 chain is one CDP’s facilitator settles on',
    sources: [
      validator('cdp-validator-toolshed.json preflight[9] accepts[0].network, expected "a facilitator-supported network (Base, Solana, Polygon, Arbitrum, World)"'),
      house('a chain outside that set is legal x402 and payable through a self-hosted facilitator — it is CDP indexing that is lost, not payment'),
    ] },
  { id: 'V2_AMOUNT', area: 'v2', severity: 'error', core: true, regime: 'payment',
    summary: 'the price is in `amount`, not the v1 `maxAmountRequired`',
    sources: [
      spec(V2_ACCEPTS_TABLE),
      client(`${CORE_SCHEMAS}:104 — amount: NonEmptyString; maxAmountRequired is not a v2 key`),
    ] },
  { id: 'V2_AMOUNT_ATOMIC', area: 'v2', severity: 'error', core: true, regime: 'payment',
    summary: 'the amount is a string of atomic units',
    sources: [
      spec(V2_ACCEPTS_TABLE),
      client('@x402/evm@2.23.0 dist/cjs/index.js:570 — BigInt(authorization.value); BigInt("0.01") throws'),
      client(`${V1_CLIENT_SCHEMAS}:433,440 — the reference facilitator schema refines on isInteger`),
    ] },
  { id: 'V2_AMOUNT_MINIMUM', area: 'v2', severity: 'error', regime: 'bazaar',
    summary: 'the amount clears CDP’s 1000-atomic-unit ($0.001) indexing floor',
    sources: [
      validator('cdp-validator-toolshed.json preflight[11] accepts[0].amount (required), expected ">= 1000"'),
      client(`${CORE_SCHEMAS}:104 — the client itself applies no numeric bound, so the facilitator is the only enforcer`),
    ] },
  { id: 'V2_PAYTO', area: 'v2', severity: 'error', core: true, regime: 'payment',
    summary: 'payTo has the address shape its network’s namespace requires',
    sources: [
      spec('specs/x402-specification-v2.md:128 § 5.1.2 — "Recipient wallet address or role constant (e.g., \\"merchant\\")"'),
      spec('specs/schemes/exact/scheme_exact_svm.md:53-68 — a base58 payTo on solana:*'),
      client('@x402/evm@2.23.0 dist/cjs/index.js:537 — `to: getAddress(paymentRequirements.payTo)`; viem throws on a non-address'),
      client(`${CORE_SCHEMAS}:106 — payTo: NonEmptyString, i.e. the shape rule is the scheme’s, not the envelope’s`),
    ] },
  { id: 'V2_ASSET', area: 'v2', severity: 'error', core: true, regime: 'payment',
    summary: 'asset names the token in the form its network’s namespace requires',
    sources: [
      spec('specs/x402-specification-v2.md:127 § 5.1.2 — "Token contract address or ISO 4217 currency code for fiat"'),
      client('@x402/evm@2.23.0 dist/cjs/index.js:565 — verifyingContract: getAddress(requirements.asset)'),
      spec('specs/schemes/exact/scheme_exact_svm.md:71 — asset is the token mint public key'),
    ] },
  { id: 'V2_MAX_TIMEOUT', area: 'v2', severity: 'error', core: true, regime: 'payment',
    summary: 'maxTimeoutSeconds is a positive JSON number (a string "60" is not one)',
    sources: [
      spec('specs/x402-specification-v2.md:129 § 5.1.2 — maxTimeoutSeconds, type number, Required'),
      client(`${CORE_SCHEMAS}:107 — maxTimeoutSeconds: z.number().positive(), required, no coercion`),
      client('@x402/evm@2.23.0 dist/cjs/index.js:539 — validBefore is computed from it; undefined yields BigInt("NaN"), which throws'),
      validator('cdp-validator-toolshed.json preflight[13] accepts[0].maxTimeoutSeconds (required)'),
    ] },
  { id: 'V2_EXTRA_EIP712', area: 'v2', severity: 'error', regime: 'payment',
    summary: 'extra.{name,version} is present on an eip3009 exact entry, where the client signs from it',
    sources: [
      spec('specs/schemes/exact/scheme_exact_evm.md:72-73 — extra.name and extra.version, both "(required)"'),
      spec('specs/schemes/exact/scheme_exact_evm.md:171-172,285-286 — conditional under permit2, optional under erc7710'),
      client('@x402/evm@2.23.0 dist/cjs/index.js:555-558 — signEIP3009Authorization throws when either is absent'),
      client('@x402/evm@2.23.0 dist/cjs/index.js:1261 — assetTransferMethod defaults to "eip3009"'),
    ] },
  // A WARN, NOT A CORE ERROR, and the rationale changed even though the weight
  // did not. The old one — "the client echoes the entry back and the server
  // deep-equals the two" — is real code and cannot bite: both sides carry the
  // same stray, so they compare equal. What a stray field actually costs is a
  // consumer that DOES run the entry through zod (a plain z.object, so unknown
  // keys are stripped, not rejected) and then compares the stripped copy with
  // the raw one — plus the version-confusion signal of a v1 field in a v2 body.
  { id: 'V2_ACCEPTS_V1_FIELDS', area: 'v2', severity: 'warn', regime: 'payment',
    summary: 'the accept carries no v1-only fields',
    sources: [
      spec(V2_ACCEPTS_TABLE),
      client(`${CORE_SCHEMAS}:101-109 — a plain z.object, so unknown keys are STRIPPED on any re-parse`),
      client('@x402/core@2.23.0 dist/esm/client/index.mjs:262 — the raw entry is echoed as `accepted`, unstripped'),
    ] },
  { id: 'V2_RESOURCE_OBJECT', area: 'v2', severity: 'error', core: true, regime: 'payment',
    summary: 'resource is the v2 object, not a v1 flat string',
    sources: [
      spec('specs/x402-specification-v2.md:116 § 5.1.2 — resource Required, ResourceInfo object'),
      client(`${CORE_SCHEMAS}:113 — resource: ResourceInfoSchema`),
      validator('cdp-validator-toolshed.json preflight[14] has_resource (required)'),
    ] },
  { id: 'V2_RESOURCE_URL_PARSES', area: 'v2', severity: 'warn', regime: 'payment',
    summary: 'resource.url parses as a URL at all — it is echoed into the payment payload',
    sources: [
      client(`${CORE_SCHEMAS}:69 — url: NonEmptyString, so the client will happily carry a bare path`),
      client('@x402/core@2.23.0 dist/cjs/client/index.js:413 — resource is copied verbatim into the outgoing PaymentPayload, which is what a settlement is attributed to'),
      field('x402-foundation/x402#3045 wire-format bug 3 — "resource.url must be absolute, not a bare path"'),
    ] },
  { id: 'V2_RESOURCE_URL', area: 'v2', severity: 'error', regime: 'bazaar',
    summary: 'resource.url is an absolute https URL',
    sources: [
      validator('cdp-validator-toolshed.json preflight[0] url_valid and preflight[1] url_https, both required'),
      spec(V2_RESOURCE_TABLE),
      field('x402-foundation/x402#3045 wire-format bug 3'),
    ] },
  // NOT "resource.method is missing", which is what this used to say. There is
  // no `method` member in the v2 ResourceInfo table and none in @x402/core's
  // ResourceInfoSchema, so the spec's own canonical 402 was being charged for
  // omitting a field the spec does not define. The method declaration CDP
  // actually reads is bazaar.info.input.method, which has its own check; what
  // survives here is the narrower and true concern: if you publish both and
  // they disagree, an agent reads one and the facilitator reads the other.
  { id: 'V2_RESOURCE_METHOD', area: 'v2', severity: 'warn', regime: 'bazaar',
    summary: 'resource.method, when published, agrees with bazaar.info.input.method',
    sources: [
      spec(`${V2_RESOURCE_TABLE} — there is no \`method\` member, so its absence is conformant`),
      spec('specs/extensions/bazaar.md:251-269 — info.input.method is the declared verb'),
      live('cdp-validator-toolshed.json paymentRequirements.resource.method — indexed sellers do publish it'),
    ] },
  { id: 'V2_RESOURCE_DESCRIPTION', area: 'v2', severity: 'error', regime: 'bazaar',
    summary: 'resource.description is under 500 characters (absent is an info; over the limit is an error)',
    sources: [
      spec(`${V2_RESOURCE_TABLE} — description Optional`),
      cdpDocs('https://docs.cdp.coinbase.com/x402/seller/get-discovered — "the CDP Facilitator rejects verify and settle requests whose description exceeds that limit" (500 characters)'),
    ] },
  { id: 'V2_RESOURCE_MIMETYPE', area: 'v2', severity: 'info', regime: 'hygiene',
    summary: 'resource.mimeType, when published, looks like a media type',
    sources: [
      spec(`${V2_RESOURCE_TABLE} — mimeType Optional`),
      client(`${CORE_SCHEMAS}:71 — mimeType: z.string().nullish()`),
    ] },
  { id: 'V2_RESOURCE_URL_MATCHES', area: 'v2', severity: 'info', regime: 'hygiene',
    summary: 'resource.url is the URL that was called',
    sources: [
      client('@x402/core@2.23.0 dist/cjs/client/index.js:413 — settlement is attributed to the echoed resource'),
      house('a proxy, a route template or a canonicalised host makes a mismatch legitimate, so this may only ever be an info'),
    ] },
  { id: 'V2_SERVICE_NAME', area: 'v2', severity: 'warn', regime: 'bazaar',
    summary: 'resource.serviceName, when published, is ≤32 printable-ASCII characters (absence is silent)',
    sources: [
      spec('specs/extensions/bazaar.md:389 — "length ≤ 32 characters"; on violation, "Drop the field."'),
      client(`${CORE_SCHEMAS}:72 — z.string().min(1).max(32).regex(/^[\\x20-\\x7e]+$/)`),
    ] },
  { id: 'V2_TAGS', area: 'v2', severity: 'warn', regime: 'bazaar',
    summary: 'resource.tags, when published, are ≤5 entries of ≤32 printable-ASCII characters (absence is silent)',
    sources: [
      spec('specs/extensions/bazaar.md:390 — "at most 5 entries; each entry non-empty, printable ASCII … length ≤ 32"'),
      client(`${CORE_SCHEMAS}:73 — z.array(z.string().min(1).max(32).regex(PRINTABLE_ASCII)).max(5)`),
    ] },
  // AN ERROR IN THE BAZAAR REGIME, WHICH IS NOT A GRADE. In this regime `error`
  // means "blocks indexing" and `warn` means "costs you inside the listing".
  // CDP marks has_bazaar_extension required, so its absence blocks — but the
  // endpoint is perfectly payable without it, and the grade says so.
  { id: 'V2_BAZAAR_PRESENT', area: 'v2', severity: 'error', regime: 'bazaar',
    summary: 'extensions.bazaar is present — in v2 its presence IS the discovery opt-in',
    sources: [
      validator('cdp-validator-toolshed.json preflight[15] has_bazaar_extension (required)'),
      spec('specs/extensions/bazaar.md:512-517 § Client Behavior — omitting the extension means no cataloging'),
      field('x402-foundation/x402#3045 — a CDP engineer: `extensions.bazaar.discoverable` is "not a valid field"'),
    ] },
  { id: 'V2_BAZAAR_INFO', area: 'v2', severity: 'error', regime: 'bazaar',
    summary: 'extensions.bazaar.info is present',
    sources: [
      spec(`${V2_EXTENSIONS_TABLE} — info Required`),
      validator('cdp-validator-toolshed.json preflight[16] bazaar.info (required)'),
    ] },
  { id: 'V2_BAZAAR_SCHEMA', area: 'v2', severity: 'error', regime: 'bazaar',
    summary: 'extensions.bazaar.schema is present',
    sources: [
      spec(`${V2_EXTENSIONS_TABLE} — schema Required`),
      spec('specs/extensions/bazaar.md:322 — "Facilitators must validate info against schema before cataloging"'),
      validator('cdp-validator-toolshed.json preflight[23] bazaar.schema (required)'),
    ] },
  { id: 'V2_BAZAAR_SCHEMA_CONTENT', area: 'v2', severity: 'error', regime: 'bazaar',
    summary: 'the bazaar schema meets its own content MUSTs: requires `input`, and every $ref/$id is same-document',
    sources: [
      spec('specs/extensions/bazaar.md:313-322 § Schema Validation — Draft 2020-12, "Must define an input property (required)", and "$ref and $id values must be same-document JSON Pointer fragments (starting with #); external references … are not allowed"'),
      field('x402-foundation/x402#3045 wire-format bug 5 — an external $ref broke CDP’s validator outright'),
    ] },
  { id: 'V2_BAZAAR_INFO_VALIDATES', area: 'v2', severity: 'error', regime: 'bazaar',
    summary: 'info validates against its own schema',
    sources: [
      spec('specs/extensions/bazaar.md:322 — facilitators MUST validate info against schema before cataloging'),
      validator('cdp-validator-toolshed.json preflight[24] parse (required)'),
      field('x402-foundation/x402#3045 — an info/schema mismatch is declined silently; nothing reaches the seller’s logs'),
    ] },
  { id: 'V2_BAZAAR_INPUT', area: 'v2', severity: 'error', regime: 'bazaar',
    summary: 'bazaar.info.input carries a worked sample call',
    sources: [
      spec('specs/extensions/bazaar.md:245-282 § Discovery Info Structure — input is Required in every discriminant'),
      validator('cdp-validator-toolshed.json preflight[17] bazaar.info.input (required)'),
    ] },
  { id: 'V2_BAZAAR_INPUT_TYPE', area: 'v2', severity: 'error', regime: 'bazaar',
    summary: 'bazaar.info.input.type is the "http" or "mcp" discriminator, with that branch’s required fields',
    sources: [
      spec('specs/extensions/bazaar.md:251-282 — type Required ("http"/"mcp"); bodyType and body Required for POST/PUT/PATCH; toolName and inputSchema Required for mcp'),
      validator('cdp-validator-toolshed.json preflight[18] bazaar.info.input.type (required)'),
      field('x402-foundation/x402#3045 wire-format bug 4 — the missing `type` discriminator'),
    ] },
  { id: 'V2_BAZAAR_INPUT_METHOD', area: 'v2', severity: 'error', regime: 'bazaar',
    summary: 'bazaar.info.input.method is an HTTP verb from the spec’s enums, and matches the verb that was probed',
    sources: [
      spec('specs/extensions/bazaar.md:251-269 — method Required, one of GET/HEAD/DELETE or POST/PUT/PATCH'),
      validator('cdp-validator-toolshed.json preflight[19] bazaar.info.input.method and preflight[20] bazaar.info.input.method.matches_request, both required'),
    ] },
  { id: 'V2_BAZAAR_OUTPUT_TYPE', area: 'v2', severity: 'warn', regime: 'bazaar',
    summary: 'bazaar.info.output, when published, carries its Required `type`',
    sources: [
      spec('specs/extensions/bazaar.md:284-294 § Output Types — output optional; within it, type Required'),
      validator('cdp-validator-toolshed.json preflight[21] bazaar.info.output (advisory)'),
    ] },
  { id: 'V2_BAZAAR_OUTPUT_EXAMPLE', area: 'v2', severity: 'info', regime: 'bazaar',
    summary: 'bazaar.info.output.example is a computed response — any JSON value, and CDP grades it advisory',
    sources: [
      spec('specs/extensions/bazaar.md:284-294 — the example row is `example | any | No`'),
      spec('specs/extensions/bazaar.md:46-53 — the spec’s own GET example gives output.example as an OBJECT'),
      validator('cdp-validator-toolshed.json preflight[22] bazaar.info.output.example (advisory)'),
    ] },

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
  //   V1_BODY_NOT_ENVELOPE info. The same, except the body is serving something
  //                       — `{"error":"payment required"}`, an HTML page — that
  //                       a v1 client will parse as an envelope and get nothing
  //                       usable from. AN INFO, because transports-v2 puts the
  //                       response body outside the protocol and the spec's own
  //                       402 example serves `{}`: a check that fires on the
  //                       specification's own example may not move a grade.
  //   V1_BODY_PRESENT     warn. NOTHING was published, in either transport.
  //   V1_BODY_JSON        core error. The body IS a v1 attempt and it is broken.
  { id: 'V1_ABSENT', area: 'v1', severity: 'info', regime: 'payment',
    summary: 'a v1 body envelope is published alongside the v2 header',
    sources: [
      client('x402-fetch@1.2.0 dist/esm/index.mjs:22 — the v1 client reads the body and never looks at PAYMENT-REQUIRED'),
      field('x402-foundation/x402#3091 — the pre-header buyer population is real and shrinking'),
      validator('cdp-validator-toolshed.json preflight[4] valid_json (required) — an EMPTY 402 body fails it, so serve at least `{}`'),
    ] },
  { id: 'V1_BODY_NOT_ENVELOPE', area: 'v1', severity: 'info', regime: 'payment',
    summary: 'the 402 body is a v1 envelope or is empty, not something a v1 client will misread',
    sources: [
      spec(BODY_IS_SERVER_CONCERN),
      spec('specs/transports-v2/http.md:19-25 — the spec’s own 402 example serves a body of `{}`'),
      client('x402-fetch@1.2.0 dist/esm/index.mjs:22-23 — an error blob makes accepts undefined and .map throws'),
      validator('cdp-validator-toolshed.json preflight[4] valid_json (required) — the body is parsed as JSON during indexing'),
    ] },
  { id: 'V1_BODY_PRESENT', area: 'v1', severity: 'warn', regime: 'payment',
    summary: 'a v1 envelope is published in the 402 body',
    sources: [
      spec(V1_TRANSPORT),
      house('only fires when nothing was published in either transport; ENVELOPE_PRESENT carries the core error for that case'),
    ] },
  { id: 'V1_BODY_JSON', area: 'v1', severity: 'error', core: true, regime: 'payment',
    summary: 'the 402 body parses as JSON',
    sources: [
      spec('specs/x402-specification-v1.md § 5.1.1 JSON Payload'),
      client('x402-fetch@1.2.0 dist/esm/index.mjs:22 — response.json() with no try/catch'),
    ] },
  { id: 'V1_VERSION', area: 'v1', severity: 'error', core: true, regime: 'payment',
    summary: 'the body declares x402Version 1',
    sources: [
      spec('specs/x402-specification-v1.md:99-108 § 5.1.2'),
      client('@x402/core@2.23.0 dist/cjs/http/index.js:1625 — the body fallback requires x402Version === 1 exactly'),
      client(`${V1_CLIENT_SCHEMAS}:388 — x402Versions = [1]`),
    ] },
  { id: 'V1_ACCEPTS_NONEMPTY', area: 'v1', severity: 'error', core: true, regime: 'payment',
    summary: 'accepts[] is a non-empty array',
    sources: [
      spec('specs/x402-specification-v1.md:99-108 § 5.1.2 — accepts Required'),
      client(`${CORE_SCHEMAS}:93 — accepts: z.array(PaymentRequirementsV1Schema).min(1)`),
      client('x402-fetch@1.2.0 dist/esm/index.mjs:23 — accepts.map throws when accepts is absent'),
    ] },
  { id: 'V1_SCHEME', area: 'v1', severity: 'error', core: true, regime: 'payment',
    summary: 'each accept names a scheme',
    sources: [spec(V1_ACCEPTS_TABLE), client(`${V1_CLIENT_SCHEMAS}:438 — scheme: z.enum(schemes)`)] },
  { id: 'V1_SCHEME_KNOWN', area: 'v1', severity: 'error', regime: 'payment',
    summary: 'the v1 scheme is `exact` — v1’s enum is closed where v2’s is open',
    sources: [
      client(`${V1_CLIENT_SCHEMAS}:387 — var schemes = ["exact"]`),
      client(`${V1_CLIENT_SCHEMAS}:438 — scheme: z3.enum(schemes), applied per accepts entry`),
      client(V1_FETCH),
    ] },
  { id: 'V1_MAX_AMOUNT_REQUIRED', area: 'v1', severity: 'error', core: true, regime: 'payment',
    summary: 'the price is in `maxAmountRequired`, not the v2 `amount`',
    sources: [spec(V1_ACCEPTS_TABLE), client(`${V1_CLIENT_SCHEMAS}:440 — maxAmountRequired is required; \`amount\` is not a v1 key`)] },
  { id: 'V1_AMOUNT_ATOMIC', area: 'v1', severity: 'error', core: true, regime: 'payment',
    summary: 'maxAmountRequired is a string of atomic units',
    sources: [
      spec(V1_ACCEPTS_TABLE),
      client(`${V1_CLIENT_SCHEMAS}:433,440 — z3.string().refine(isInteger)`),
      client('x402-fetch@1.2.0 dist/esm/index.mjs:30 — BigInt(maxAmountRequired) throws on a non-digit string'),
    ] },
  { id: 'V1_NETWORK_NAME', area: 'v1', severity: 'error', core: true, regime: 'payment',
    summary: 'network is a v1 plain name, not CAIP-2',
    sources: [
      spec(V1_ACCEPTS_TABLE),
      client(`${V1_CLIENT_SCHEMAS}:16-34 — NetworkSchema is a z.enum of plain names; no member contains a colon`),
    ] },
  { id: 'V1_NETWORK_KNOWN', area: 'v1', severity: 'error', regime: 'payment',
    summary: 'the v1 network name is one of the seventeen the dominant v1 client’s enum admits',
    sources: [
      client(`${V1_CLIENT_SCHEMAS}:16-34 — the closed z.enum: ${V1_NETWORK_ENUM.join(', ')}`),
      client(V1_FETCH),
      house(`@x402/core@2.23.0's v1-compatibility schema is looser (${CORE_SCHEMAS}:62, NonEmptyString), so this is a claim about the dominant v1 client rather than about every parser — hence error, not core`),
    ] },
  { id: 'V1_RESOURCE_STRING', area: 'v1', severity: 'error', core: true, regime: 'payment',
    summary: 'resource is a flat, absolute URL string, not the v2 object',
    sources: [
      spec(V1_ACCEPTS_TABLE),
      client(`${V1_CLIENT_SCHEMAS}:441 — resource: z3.string().url(), so a bare path is a hard ZodError`),
      field('x402-foundation/x402#3045 wire-format bug 3, in its v1 spelling'),
    ] },
  { id: 'V1_PAYTO', area: 'v1', severity: 'error', core: true, regime: 'payment',
    summary: 'payTo has the address shape its v1 network requires (EVM 0x, or base58 on solana)',
    sources: [
      spec(V1_ACCEPTS_TABLE),
      client(`${V1_CLIENT_SCHEMAS}:435 — EvmOrSvmAddress = EvmAddressRegex.or(SvmAddressRegex)`),
      client(`${V1_CLIENT_SCHEMAS}:16-34 — the enum includes solana and solana-devnet`),
    ] },
  { id: 'V1_ASSET', area: 'v1', severity: 'error', core: true, regime: 'payment',
    summary: 'asset names the token in the form its v1 network requires',
    sources: [
      spec(V1_ACCEPTS_TABLE),
      client(`${V1_CLIENT_SCHEMAS}:436,447 — asset: mixedAddressOrSvmAddress`),
      client('x402@1.2.0 dist/esm/chunk-EJI6X7BV.mjs:75 — verifyingContract: getAddress(asset), which throws on a ticker'),
    ] },
  // SPEC AND CLIENT DISAGREE, AND BOTH ARE CITED. The v1 spec table marks
  // mimeType Optional; x402@1.2.0's zod schema requires it, and x402-fetch runs
  // every accepts entry through that schema — so for the exact buyer population
  // the v1 body exists to serve, an envelope without it does not parse at all.
  // Client behaviour wins on severity; the spec's label is kept in `sources` so
  // the disagreement is visible rather than laundered.
  { id: 'V1_MIMETYPE', area: 'v1', severity: 'error', regime: 'payment',
    summary: 'mimeType is present (spec: Optional — but the dominant v1 client’s schema requires it)',
    sources: [
      spec(`${V1_ACCEPTS_TABLE} — mimeType Optional`),
      client(`${V1_CLIENT_SCHEMAS}:443 — mimeType: z3.string(), NOT .optional()`),
      client(V1_FETCH),
      house(`@x402/core@2.23.0's v1 schema does make it optional (${CORE_SCHEMAS}:83) — the two v1 parsers disagree`),
    ] },
  { id: 'V1_DESCRIPTION', area: 'v1', severity: 'error', regime: 'payment',
    summary: 'description is present (missing is an error; present-but-empty is a warn)',
    sources: [
      spec(`${V1_ACCEPTS_TABLE} — description Required`),
      client(`${V1_CLIENT_SCHEMAS}:442 — description: z3.string(), required`),
      client(`${CORE_SCHEMAS}:82 — required in the modern v1-compatibility schema too`),
    ] },
  { id: 'V1_MAX_TIMEOUT', area: 'v1', severity: 'error', core: true, regime: 'payment',
    summary: 'maxTimeoutSeconds is a positive integer JSON number',
    sources: [
      spec(`${V1_ACCEPTS_TABLE} — maxTimeoutSeconds, type number, Required`),
      client(`${V1_CLIENT_SCHEMAS}:446 — z3.number().int(), so the string "60" is a ZodError`),
      client(`${CORE_SCHEMAS}:86 — z.number().positive(), required`),
    ] },
  { id: 'V1_EXTRA_EIP712', area: 'v1', severity: 'error', regime: 'payment',
    summary: 'extra carries the EIP-712 domain the v1 client signs over (EVM networks only)',
    sources: [
      spec('specs/schemes/exact/scheme_exact_evm.md:72-73 — extra.name and extra.version required for eip3009'),
      client('x402@1.2.0 dist/esm/chunk-EJI6X7BV.mjs:65-76 — signAuthorization reads extra?.name and extra?.version straight into the typed-data domain, with no fallback'),
      house('the reference facilitator recomputes the domain from its own table, so the mismatch surfaces only as invalid_exact_evm_payload_signature'),
      spec('specs/x402-specification-v1.md:261 — v1 Solana exact uses TransferChecked, which has no EIP-712 domain'),
    ] },
  { id: 'V1_OUTPUT_SCHEMA', area: 'v1', severity: 'warn', regime: 'bazaar',
    summary: 'outputSchema is present for v1 discovery',
    sources: [
      spec(`${V1_ACCEPTS_TABLE} — outputSchema Optional`),
      spec('specs/extensions/bazaar.md:577+ § Backwards Compatibility — v1 discovery rode on outputSchema'),
      field('x402-foundation/x402#2844 — indexing began after the metadata moved there'),
    ] },
  // AN OPT-OUT, NOT AN OPT-IN, and the inversion is the whole correction. The
  // reference v1→v2 discovery extractor defaults `discoverable` to TRUE when it
  // is absent, so demanding the explicit flag fired on envelopes the reference
  // facilitator indexes. What is left worth saying is the opposite: if you set
  // it to false, you have opted out, and it is worth being told you did.
  { id: 'V1_DISCOVERABLE', area: 'v1', severity: 'info', regime: 'bazaar',
    summary: 'outputSchema.input.discoverable is an opt-OUT — absence means indexed',
    sources: [
      // Quoted from the file rather than cited by line: this repository holds a
      // sparse clone of specs/ only, so the line numbers were not verifiable
      // here and the comment was. `discoverable := true` before the lookup is
      // the whole of the rule.
      client('x402-foundation/x402 go/extensions/v1/facilitator.go (main, read 2026-08-19) — "// Check if discoverable (default to true if not specified)" followed by `discoverable := true`, then an override only when the key is present'),
      live('worker/positive-control.js — a live indexed seller nests the flag under outputSchema.input'),
      cdpDocs('https://docs.cdp.coinbase.com/x402/bazaar — v1 discovery data reads input.discoverable'),
    ] },

  // --- dual-stack consistency -------------------------------------------
  //
  // NO SPEC GOVERNS DUAL PUBLISHING, because no spec contemplates it. These
  // five are house positions, labelled as such — and they are held at core
  // severity because a divergence between two views of one offer is, in
  // practice, always a stale config rather than an intention.
  //
  // What changed after the audit is HOW the two sides are paired. Comparing
  // accepts[0] with accepts[0] graded a seller F for listing the same two
  // offers in a different order in each envelope, which is not a fault at all.
  // Entries are matched on (chain, asset) first; an unmatched offer is reported
  // as unverifiable, at info, rather than as a disagreement.
  { id: 'DUAL_PAYTO', area: 'dual', severity: 'error', core: true, regime: 'payment',
    summary: 'matched offers pay the same address',
    sources: [
      house('worker/lint.js — two views of one offer; divergence means half the revenue lands elsewhere'),
      client('@x402/evm@2.23.0 dist/cjs/index.js:568 — getAddress is case-insensitive, so the comparison is too'),
    ] },
  { id: 'DUAL_PRICE', area: 'dual', severity: 'error', core: true, regime: 'payment',
    summary: 'matched offers quote the same price',
    sources: [house('worker/lint.js — one offer must not carry two prices; matched on (chain, asset) so different-decimal assets are not compared')] },
  { id: 'DUAL_NETWORK', area: 'dual', severity: 'error', core: true, regime: 'payment',
    summary: 'the two envelopes offer overlapping chains',
    sources: [
      house('worker/lint.js — a payment signed on one chain is worthless on the other'),
      client(`${V1_CLIENT_SCHEMAS}:52-70 — the client’s own EvmNetworkToChainId map, which is the two spellings of one chain`),
    ] },
  { id: 'DUAL_ASSET', area: 'dual', severity: 'error', core: true, regime: 'payment',
    summary: 'matched offers name the same asset',
    sources: [house('worker/lint.js — different assets means the two versions are selling for different money')] },
  { id: 'DUAL_RESOURCE', area: 'dual', severity: 'warn', regime: 'payment',
    summary: 'both versions name the same resource URL',
    sources: [
      house('worker/lint.js — two URLs split one endpoint’s settlement record across two listings'),
      field('x402-foundation/x402#3045 — discovery keys on the resource URL'),
    ] },

  // --- version-detection hygiene ----------------------------------------
  { id: 'VERSION_HEADER_SAYS_V1', area: 'version', severity: 'error', regime: 'payment',
    summary: 'the PAYMENT-REQUIRED header does not carry a v1 payload',
    sources: [
      spec(V2_TRANSPORT),
      client(`${CORE_SCHEMAS}:128-131 — PaymentRequired is a discriminatedUnion on x402Version, so a v1 payload in the header is legally parsed AS v1`),
      client('@x402/core@2.23.0 dist/esm/client/index.mjs:219 — registeredClientSchemes.get(paymentRequired.x402Version): dispatch is on the PAYLOAD’s version, and a v1 client answers with X-PAYMENT while a v2 server reads PAYMENT-SIGNATURE'),
    ] },
  // NOT CORE, AND CONDITIONAL. A v2 client reads the header first and consults
  // the body only when there is none, so a seller who mirrors their v2 envelope
  // into the body is doing something harmless that every current client
  // ignores. Without a header it is a different matter: the body fallback
  // demands x402Version === 1, so a v2-only-in-the-body endpoint is unpayable.
  { id: 'VERSION_BODY_SAYS_V2', area: 'version', severity: 'warn', regime: 'payment',
    summary: 'the 402 body does not carry a v2 payload (a core error when no valid v2 header is published)',
    sources: [
      spec(BODY_IS_SERVER_CONCERN),
      client('@x402/core@2.23.0 dist/cjs/http/index.js:1620-1628 — the header wins whenever present; the body fallback accepts only x402Version === 1'),
      client('x402-fetch@1.2.0 dist/esm/index.mjs:22-23 — a v1 client reads the body with v1 rules whatever it declares'),
    ] },

  // --- the report's own bounds ------------------------------------------
  //
  // Not conformance checks: these say what the LINTER did, and they exist
  // because the alternative to a bound that reports itself is a bound that
  // lies. A truncated report read as a clean one is worse than no report.
  { id: 'ACCEPTS_TRUNCATED', area: 'report', severity: 'info', regime: 'hygiene',
    summary: `at most ${MAX_ACCEPTS_LINTED} accepts[] entries are linted per envelope`,
    sources: [house(`worker/lint.js MAX_ACCEPTS_LINTED = ${MAX_ACCEPTS_LINTED}`)] },
  { id: 'FINDINGS_TRUNCATED', area: 'report', severity: 'info', regime: 'hygiene',
    summary: 'this report is complete — no bound clipped it',
    sources: [house(`worker/lint.js — MAX_FINDINGS = ${MAX_FINDINGS}, MAX_ACCEPTS_LINTED = ${MAX_ACCEPTS_LINTED}, and the caller's body byte cap`)] },
];

export const CHECKS_BY_ID = new Map(CHECKS.map((c) => [c.id, c]));

// EVERY CHECK CARRIES A REGIME AND AT LEAST ONE SOURCE, asserted at module load
// rather than in a test. A check with no provenance is the exact thing this
// catalogue was audited to remove, and a test can be skipped; an import cannot.
for (const check of CHECKS) {
  if (!REGIMES.includes(check.regime)) {
    throw new Error(`check ${check.id} has regime ${JSON.stringify(check.regime)}, not one of ${REGIMES.join('/')}`);
  }
  if (!Array.isArray(check.sources) || check.sources.length === 0) {
    throw new Error(`check ${check.id} has no sources — every rule cites where it comes from`);
  }
  for (const source of check.sources) {
    if (!SOURCE_KINDS.includes(source.kind)) {
      throw new Error(`check ${check.id} cites source kind ${JSON.stringify(source.kind)}, which is not one of ${SOURCE_KINDS.join('/')}`);
    }
    // Spelled out rather than calling nonEmptyString(): this loop runs at module
    // load, and the helpers below are still in their temporal dead zone here.
    if (typeof source.ref !== 'string' || !source.ref.trim()) {
      throw new Error(`check ${check.id} has a source with no ref`);
    }
  }
  // A hygiene finding that could reach `warn` would be a grade-affecting house
  // opinion wearing the label of a nit. The regime and the severity have to agree.
  if (check.regime === 'hygiene' && check.severity !== 'info') {
    throw new Error(`check ${check.id} is hygiene but severity ${check.severity} — hygiene is info only`);
  }
  if (check.core && check.regime !== 'payment') {
    throw new Error(`check ${check.id} is core but regime ${check.regime} — only a payment-regime failure can be an F`);
  }
}

/**
 * The grade ladder, published verbatim at GET /check so nobody has to guess.
 *
 * IT COUNTS PAYMENT-REGIME FINDINGS ONLY. The ladder itself is unchanged; what
 * changed is the population it runs over. A missing bazaar extension is not a
 * defect in a 402, it is an absent listing, and letting it drag an otherwise
 * flawless envelope from A to B made the grade answer two questions at once and
 * neither one clearly. `summary.bazaar_ready` answers the other one.
 */
export const GRADE_RULES = [
  { grade: 'A', when: 'zero payment-regime errors and zero payment-regime warnings' },
  { grade: 'B', when: 'zero payment-regime errors, one or two warnings' },
  { grade: 'C', when: 'zero payment-regime errors, three or more warnings' },
  { grade: 'D', when: 'one or more payment-regime errors, none of them core' },
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
    /** accepts[] entries past MAX_ACCEPTS_LINTED that were never read. Same reason. */
    this.acceptsSkipped = 0;
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
   *
   * `severity` may be overridden per call — a few checks report the same
   * concern at different weights depending on what else is present — and so may
   * `core`, for the checks whose consequence depends on the circumstance rather
   * than on the rule. Both overrides are deliberate escape hatches with a
   * handful of users each; a check that needed a third would be two checks.
   */
  check(id, ok, message, fix, severity, core) {
    this.ran_(id, ok);
    if (ok) return true;
    const def = CHECKS_BY_ID.get(id);
    this.emit({ severity: severity || def.severity, code: id, message, fix, core: core ?? def.core === true });
    return false;
  }

  /** A finding for a check that has already been counted (loops over accepts). */
  add(id, message, fix, severity, core) {
    const def = CHECKS_BY_ID.get(id);
    if (!def) throw new Error(`unknown check id ${id} — add it to CHECKS`);
    this.ran.add(id);
    this.emit({ severity: severity || def.severity, code: id, message, fix, core: core ?? def.core === true });
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

/**
 * Is this FINDING core?
 *
 * The catalogue's `core` is the default; a finding may carry its own, because
 * one check can be core in one circumstance and not in another. HTTP_STATUS_402
 * is the case that forced it: a 401 to an unauthenticated call is an endpoint
 * that does not do x402, while a 405 is very often a GET-only endpoint and this
 * linter's POST. Same code, same rule, different consequence.
 */
const findingIsCore = (finding) =>
  finding.core !== undefined ? finding.core === true : CHECKS_BY_ID.get(finding.code)?.core === true;

/** Which authority a finding answers to. Unknown codes are treated as payment — the strict side. */
const regimeOf = (code) => CHECKS_BY_ID.get(code)?.regime ?? 'payment';

/**
 * The grade. Core errors are a separate tier from ordinary ones because they
 * mean different things to the seller: an F is "this does not work", a D is
 * "this works and something about it is wrong".
 *
 * PAYMENT-REGIME FINDINGS ONLY — see GRADE_RULES. Bazaar findings are reported
 * with the same weight and detail, and answered by `summary.bazaar_ready`.
 */
export function grade(findings) {
  const payment = findings.filter((f) => regimeOf(f.code) === 'payment');
  const errors = payment.filter((f) => f.severity === 'error');
  const warns = payment.filter((f) => f.severity === 'warn');
  if (errors.some(findingIsCore)) return 'F';
  if (errors.length) return 'D';
  if (warns.length >= 3) return 'C';
  if (warns.length) return 'B';
  return 'A';
}

/**
 * Can this resource be INDEXED — the second verdict, and the one a grade cannot
 * carry.
 *
 * `true`, `false`, or `'n/a'` for a v1-only endpoint, where the CDP Bazaar
 * requirements are a v2 shape that does not apply. The blockers are named,
 * because "false" on its own is the same silence the whole product exists to
 * break: CDP declines to catalogue without telling the seller, and a linter
 * that also said only "no" would be repeating the failure rather than fixing it.
 *
 * Computed from bazaar-regime ERRORS. A bazaar warn — a chain outside the
 * facilitator set, an over-long serviceName that will be soft-dropped — costs
 * the seller something without stopping the listing, so it is reported and does
 * not flip the answer.
 */
export function bazaarReady(findings, { v2Published }) {
  const blockers = findings.filter((f) => regimeOf(f.code) === 'bazaar' && f.severity === 'error');
  // 'n/a' RATHER THAN false FOR A v1-ONLY ENDPOINT, because CDP's requirements
  // are a v2 shape and answering `false` would read as a list of things that
  // are wrong with a v2 envelope this seller never published. The blockers are
  // still named, and V2_HEADER_PRESENT is the first of them — which is the
  // honest form of the answer: not applicable, and here is what would make it
  // applicable.
  if (!v2Published) return { bazaar_ready: 'n/a', blockers: [...new Set(blockers.map((f) => f.code))] };
  return {
    bazaar_ready: blockers.length === 0,
    // De-duplicated: one code can be reported for several accepts entries, and
    // a blocker list that named the same one three times would read as three.
    blockers: [...new Set(blockers.map((f) => f.code))],
  };
}

// ------------------------------------------------------------------ helpers

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/** Does this string parse as an absolute URL? `z.string().url()`, in one line. */
function parsesAsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

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

// ------------------------------------------------------------------ address families
//
// ONE FUNCTION, BECAUSE THE BUG WAS ONE ASSUMPTION IN FOUR PLACES. V2_PAYTO,
// V1_PAYTO, V2_ASSET and V1_ASSET each hardcoded a 20-byte EVM address, so a
// spec-conformant Solana envelope — base58 payTo, an SPL mint as asset — graded
// F four times over for being on a chain x402, its clients and CDP's own
// facilitator all support. The address family is a property of the NETWORK, and
// it is now read off the network in exactly one place.
//
// The third case is the one worth naming: a namespace this linter has not heard
// of. `cloudflare:402` is a real network with a real scheme document, and its
// payTo is the literal string "merchant" — a role constant the v2 spec's own
// PaymentRequirements table allows. There is no address shape to check there,
// and inventing one would be the same mistake in a new costume. The entry is
// checked structurally, and the report says plainly that it was.

/**
 * Which address family an accepts entry's network implies.
 *
 * @returns {'evm'|'svm'|'unknown'}
 */
function addressFamily(network, version) {
  if (typeof network !== 'string') return 'unknown';
  if (version === 1) {
    if (V1_SVM_NETWORKS.has(network)) return 'svm';
    // Every other name in the v1 enum is an EVM chain (x402@1.2.0
    // chunk-V3RMM5AE.mjs:35-51, SupportedEVMNetworks), and so is every v1 name
    // in this file's chain table.
    return V1_NETWORK_ENUM.includes(network) || V1_NETWORK_CHAIN[network] ? 'evm' : 'unknown';
  }
  const namespace = namespaceOf(network);
  if (namespace === 'eip155') return 'evm';
  if (namespace === 'solana') return 'svm';
  return 'unknown';
}

/** Does this string have the address shape that family requires? */
function addressOk(family, value) {
  if (typeof value !== 'string') return false;
  if (family === 'evm') return ADDRESS_RE.test(value);
  if (family === 'svm') return SVM_ADDRESS_RE.test(value);
  // An unknown namespace: structure only. Non-empty is the whole of the claim
  // @x402/core makes about payTo and asset (schemas/index.js:105-106).
  return value.trim().length > 0;
}

/** How to say what was wanted, when it was not what arrived. */
const ADDRESS_SHAPE = {
  evm: 'a 0x-prefixed, 40-hex-character EVM address',
  svm: 'a base58 Solana address of 32–44 characters',
  unknown: 'a non-empty string',
};

/**
 * Does this exact-scheme entry sign an EIP-712 domain out of `extra`?
 *
 * scheme_exact_evm.md:15 and :71 make `eip3009` the default assetTransferMethod
 * and :72-73 make extra.name/version required under it; :171-172 make them
 * conditional under permit2 and :285-286 optional under erc7710. On Solana
 * there is no EIP-712 domain at all — scheme_exact_svm.md:61-67 fills `extra`
 * with feePayer/memo/recentBlockhash instead. @x402/evm reads the same default
 * at dist/cjs/index.js:1261.
 */
function signsEip712Domain(entry, family) {
  if (family !== 'evm') return false;
  if (entry.scheme !== 'exact') return false;
  const method = isObject(entry.extra) ? entry.extra.assetTransferMethod : undefined;
  return method === undefined || method === 'eip3009';
}

// ------------------------------------------------------------------ v2

/**
 * Lint the v2 half. Returns the facts dual-stack consistency needs, or null when
 * there is no v2 envelope to read.
 */
function lintV2(report, headers, requestUrl, probedMethod) {
  const raw = headerOf(headers, PAYMENT_REQUIRED_HEADER);

  if (!nonEmptyString(raw)) {
    report.check(
      'V2_HEADER_PRESENT',
      false,
      'no PAYMENT-REQUIRED response header — this endpoint publishes no x402 v2 envelope.',
      'Add a PAYMENT-REQUIRED response header to the 402 carrying the standard-base64 JSON v2 ' +
        'envelope. This costs you DISCOVERY rather than payment, and the distinction is worth ' +
        'being precise about: @x402/core reads the header first but DOES fall back to a v1 body ' +
        'when there is none, so the current client generation can still pay you. What it cannot ' +
        'do is find you — CDP marks the PAYMENT-REQUIRED header a required indexing check, so a ' +
        'v1-only 402 is not catalogued at all, and a strictly-v2 client cannot pay it either. ' +
        'Keep the v1 body exactly as it is; the two versions share a 402 without either noticing ' +
        'the other.'
    );
    return null;
  }
  report.check('V2_HEADER_PRESENT', true);

  // THE RAW VALUE, NOT A TRIMMED ONE. @x402/core tests Base64EncodedRegex
  // against the header exactly as it arrived (dist/cjs/http/index.js:1778) and
  // throws before decoding, so a value with leading or trailing whitespace is
  // discarded by the client while a trimmed copy of it passed here. The trim
  // stays for the DECODE below, which is what atob would do anyway.
  const value = String(raw);
  if (
    !report.check(
      'V2_B64_URLSAFE',
      STANDARD_B64_RE.test(value),
      'the PAYMENT-REQUIRED header is not standard base64 — it contains characters outside ' +
        '[A-Za-z0-9+/=]' +
        (/[-_]/.test(value) ? ', including the base64url characters "-" and/or "_".' : '.'),
      'Encode the header with STANDARD base64, not base64url. Clients validate the header ' +
        'against /^[A-Za-z0-9+/]*={0,2}$/ BEFORE decoding it — on the RAW header value, so ' +
        'stray leading or trailing whitespace fails it too — and a url-safe envelope is ' +
        'discarded unread, leaving your endpoint looking like it published nothing at all. In ' +
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
    return { env, accept: null, accepts: [], resource: env.resource };
  }

  const accept = accepts[0];
  lintV2Accept(report, accept, accepts);
  // Read once, used twice: V2_RESOURCE_METHOD compares resource.method against
  // it, and lintBazaar checks it against the verb that was actually probed.
  const bazaar = isObject(env.extensions) ? env.extensions.bazaar : undefined;
  const bazaarMethod = isObject(bazaar) && isObject(bazaar.info) && isObject(bazaar.info.input)
    ? bazaar.info.input.method
    : undefined;
  lintV2Resource(report, env.resource, requestUrl, typeof bazaarMethod === 'string' ? bazaarMethod : null);
  lintBazaar(report, env.extensions, probedMethod);

  return { env, accept, accepts, resource: env.resource };
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
      'Set "scheme": "exact" unless you have implemented another one. `exact` is the scheme ' +
        'every current client and facilitator supports; it is not one mechanism but a family — ' +
        'EIP-3009 transferWithAuthorization on EVM by default, Permit2 or ERC-7710 when ' +
        'extra.assetTransferMethod says so, and SPL TransferChecked on Solana.'
    );
    report.check(
      'V2_SCHEME_KNOWN',
      !nonEmptyString(entry.scheme) || KNOWN_V2_SCHEMES.includes(entry.scheme),
      `${where} uses the scheme "${clip(entry.scheme)}", which has no specification in specs/schemes/.`,
      `The schemes with published specifications are ${KNOWN_V2_SCHEMES.join(', ')}; CDP's ` +
        'validator names "exact or upto" as the pair its facilitator settles. v2 leaves the ' +
        'scheme field open on purpose, so a scheme of your own is legal — but only a client that ' +
        'already knows it can pay you, so publish an `exact` entry alongside it if you want the ' +
        'ordinary ones too.'
    );

    // NETWORK. Three separate questions that used to be one, and collapsing them
    // was what rejected `cloudflare:402`:
    //
    //   V2_NETWORK_CAIP2        does the CLIENT accept it? (min 3, has a colon)
    //   V2_NETWORK_CAIP2_STYLE  is it CAIP-2 shaped? (a style note)
    //   V2_NETWORK_SUPPORTED    will CDP's facilitator settle it? (indexing)
    //
    // The first is core, because a v2 client's schema refuses the envelope. The
    // v1 plain name in a v2 envelope is its flagship case: "base" has no colon,
    // so it is not a lenient variant, it is an invalid envelope.
    if (typeof entry.network !== 'string' || !entry.network) {
      report.check('V2_NETWORK_CAIP2', false,
        `${where} names no network${entry.network === undefined ? '' : ` — it carries ${clip(JSON.stringify(entry.network), 60)}, which is not a string`}.`,
        'Set "network" to the CAIP-2 id of the chain, as a STRING, e.g. "eip155:8453" for Base mainnet.');
    } else if (V1_NETWORK_CHAIN[entry.network]) {
      report.check(
        'V2_NETWORK_CAIP2',
        false,
        `${where} uses the v1 network name "${clip(entry.network)}" in a v2 envelope.`,
        `v2 networks are CAIP-2 and the client's schema requires the colon: replace ` +
          `"${clip(entry.network)}" with "${V1_NETWORK_CHAIN[entry.network]}". Keep ` +
          `"${clip(entry.network)}" in the v1 body — the same chain has two spellings and the ` +
          'version decides which one is legal.'
      );
    } else {
      report.check(
        'V2_NETWORK_CAIP2',
        networkParses(entry.network),
        `${where} network "${clip(entry.network)}" is not a network identifier — it needs at ` +
          'least three characters and a colon.',
        'Use `namespace:reference`, e.g. "eip155:8453" (Base mainnet) or "eip155:84532" ' +
          '(Base Sepolia). @x402/core validates the string with min(3) plus "contains a colon", ' +
          'so the colon is the part that is not optional.'
      );
      // A STYLE NOTE, AND ONLY THAT. CAIP-2 bounds the namespace at 8
      // characters; no client does. `cloudflare:402` violates the registry's
      // shape and is a network with its own scheme document, so this may cost
      // nothing.
      report.check(
        'V2_NETWORK_CAIP2_STYLE',
        !networkParses(entry.network) || CAIP2_RE.test(entry.network),
        `${where} network "${clip(entry.network)}" parses, but is not CAIP-2 shaped — CAIP-2 ` +
          'bounds the namespace at 3–8 lowercase characters.',
        'Nothing rejects this: @x402/core asks only for a colon, and networks like ' +
          '"cloudflare:402" are defined by their own scheme specifications. Mentioned in case ' +
          'the string is a typo rather than a deliberate non-registry namespace.'
      );
    }

    const family = addressFamily(entry.network, 2);
    const namespace = namespaceOf(entry.network);

    // AN UNKNOWN NAMESPACE IS REPORTED, NOT GUESSED AT. Everything below this
    // point that inspects the SHAPE of a value dispatches on `family`, and for
    // an unrecognised namespace that means structure only. Saying so is the
    // difference between a lenient check and a check that quietly did nothing.
    report.check(
      'V2_NAMESPACE_KNOWN',
      family !== 'unknown' || !networkParses(entry.network),
      `${where} is on "${clip(entry.network)}"; this linter validates the inside of an accepts ` +
        `entry deeply for eip155:* and solana:* only, so payTo, asset and the EIP-712 domain ` +
        'were checked structurally rather than against a known address format.',
      'Nothing to fix — this is the report telling you what it did not check. If the namespace ' +
        'has a scheme specification in specs/schemes/, its own document is the authority on what ' +
        'these fields should look like.'
    );

    // The eip155 chains CDP settles. Legal x402 either way; a chain outside the
    // set is payable through your own facilitator and not listed by theirs.
    if (namespace === 'eip155') {
      report.check(
        'V2_NETWORK_SUPPORTED',
        CDP_FACILITATOR_CHAINS.has(entry.network),
        `${where} is on "${clip(entry.network)}", which is not one of the chains CDP's ` +
          'facilitator settles.',
        "CDP's validator expects Base, Solana, Polygon, Arbitrum or World. This is an INDEXING " +
          'constraint, not a protocol one: the envelope is valid and a self-hosted or third-party ' +
          'facilitator can settle it. If you want the CDP listing, publish an additional accepts ' +
          'entry on one of those chains.'
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
      const atomic = typeof entry.amount === 'string' && /^\d+$/.test(entry.amount);
      report.check(
        'V2_AMOUNT_ATOMIC',
        atomic,
        `${where} amount ${clip(JSON.stringify(entry.amount))} is not a decimal string of atomic units.`,
        'Amounts are STRINGS of integer atomic units, never numbers and never decimals — ' +
          '"10000", not 0.01 and not "0.01". @x402/evm converts the value with BigInt(), which ' +
          'throws on either form, and a JSON number loses precision on large amounts.'
      );
      // CDP'S FLOOR, NOT THE PROTOCOL'S. Nothing stops a seller charging a
      // hundredth of a cent; CDP will not index them if they do.
      if (atomic) {
        report.check(
          'V2_AMOUNT_MINIMUM',
          BigInt(entry.amount) >= CDP_MIN_AMOUNT_ATOMIC,
          `${where} asks ${clip(entry.amount)} atomic units, below CDP's ${CDP_MIN_AMOUNT_ATOMIC} ` +
            `minimum${entry.amount === '0' ? ' — and an amount of 0 is not a price at all' : ''}.`,
          `CDP's validator marks the amount check required with an expectation of >= ` +
            `${CDP_MIN_AMOUNT_ATOMIC} — $0.001 of a 6-decimal stablecoin. Below it the endpoint ` +
            'is payable but will not be catalogued. Raise the price, or accept that this listing ' +
            'lives outside the Bazaar.'
        );
      }
    }

    // PAYTO AND ASSET DISPATCH ON THE NETWORK'S NAMESPACE. See addressFamily().
    // Note `typeof` rather than the old String(entry.payTo || '') — an array
    // holding a valid address coerced to the address and graded A, while both
    // the client's zod schema and viem reject a non-string outright.
    report.check(
      'V2_PAYTO',
      addressOk(family, entry.payTo),
      entry.payTo === undefined
        ? `${where} has no payTo — there is nowhere to send the money.`
        : typeof entry.payTo !== 'string'
          ? `${where} payTo is ${clip(JSON.stringify(entry.payTo), 60)}, not a string.`
          : `${where} payTo "${clip(entry.payTo)}" is not ${ADDRESS_SHAPE[family]}.`,
      family === 'evm'
        ? 'payTo is the 20-byte receiving address, 0x-prefixed and 40 hex characters. Paste the ' +
          'address from your wallet rather than a name or an ENS entry; clients do not resolve names.'
        : family === 'svm'
          ? 'payTo is the merchant\'s Solana public key, base58 — 32 to 44 characters from the ' +
            'base58 alphabet (no 0, O, I or l).'
          : 'payTo must be a non-empty string. The v2 specification allows a wallet address OR a ' +
            'role constant (its own example is "merchant"), and this linter does not know this ' +
            'namespace\'s address format — check the scheme specification for the exact shape.'
    );

    report.check(
      'V2_ASSET',
      addressOk(family, entry.asset),
      entry.asset === undefined
        ? `${where} names no asset.`
        : typeof entry.asset !== 'string'
          ? `${where} asset is ${clip(JSON.stringify(entry.asset), 60)}, not a string.`
          : `${where} asset "${clip(entry.asset)}" is not ${ADDRESS_SHAPE[family]}.`,
      family === 'evm'
        ? 'Set "asset" to the token CONTRACT ADDRESS on that chain — for USDC on Base, ' +
          '"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913". A ticker like "USDC" is not an ' +
          'address: @x402/evm feeds this field straight into viem\'s getAddress() to build the ' +
          'EIP-712 verifyingContract, and it throws before anything is signed.'
        : family === 'svm'
          ? 'Set "asset" to the token MINT public key, base58 — USDC on Solana mainnet is ' +
            '"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".'
          : 'Set "asset" to whatever this network identifies the money by. The v2 specification ' +
            'allows a token contract address OR an ISO 4217 currency code for fiat (the ' +
            'cloudflare:402 scheme uses "USD"), so this is checked for presence only.'
    );

    // maxTimeoutSeconds IS REQUIRED AND IT IS A NUMBER, and the old check was
    // wrong on both counts. Number()-coercion blessed the string "60", which
    // @x402/core's z.number().positive() rejects outright; and grading its
    // absence a warn described "the client throws before signing" as something
    // that merely costs the seller a little.
    //
    // The exception is a namespace whose own scheme specification makes the
    // field optional — cloudflare:402 does, at :110, to stay under a 2 KB header.
    // There the absence is reported as an info and never as a break.
    const timeoutOptional = family === 'unknown';
    if (entry.maxTimeoutSeconds === undefined) {
      report.check(
        'V2_MAX_TIMEOUT',
        false,
        `${where} has no maxTimeoutSeconds.`,
        timeoutOptional
          ? 'The core v2 specification marks maxTimeoutSeconds Required, but some networks\' ' +
            'scheme specifications make it optional (cloudflare:402 does, to keep the header ' +
            'under 2 KB). Check yours; if it is required there too, set it.'
          : 'Set "maxTimeoutSeconds" to how long a signed authorization stays valid — 60 is the ' +
            'common value, as a JSON NUMBER. @x402/core\'s schema requires it, and @x402/evm ' +
            'computes validBefore from it: with nothing there the arithmetic yields NaN and ' +
            'BigInt("NaN") throws before the payment is ever signed.',
        timeoutOptional ? 'info' : undefined,
        timeoutOptional ? false : undefined
      );
    } else {
      report.check(
        'V2_MAX_TIMEOUT',
        typeof entry.maxTimeoutSeconds === 'number' &&
          Number.isFinite(entry.maxTimeoutSeconds) &&
          entry.maxTimeoutSeconds > 0,
        `${where} maxTimeoutSeconds is ${clip(JSON.stringify(entry.maxTimeoutSeconds), 60)}, not a positive JSON number.`,
        'It must be a NUMBER, not a string: 60, never "60". @x402/core validates it with ' +
          'z.number().positive() and applies no coercion, so a quoted value fails the schema — ' +
          'and where it does get through, @x402/evm adds it to a timestamp, which concatenates ' +
          'instead of adding and produces an absurd validBefore.'
      );
    }

    // `extra` is the EIP-712 domain, and it is only the EIP-712 domain for the
    // mechanism that signs one. Asking a Solana entry, a Permit2 entry or a
    // batch-settlement entry for a typed-data domain they do not have was three
    // false findings on legal envelopes; asking an eip3009 entry for it at warn
    // understated a client that throws before it signs anything.
    if (signsEip712Domain(entry, family)) {
      report.check(
        'V2_EXTRA_EIP712',
        isObject(entry.extra) && nonEmptyString(entry.extra.name) && nonEmptyString(String(entry.extra.version ?? '')),
        `${where} has no extra.{name,version} — the EIP-712 domain is missing.`,
        'Add "extra": { "name": "<the token\'s on-chain name()>", "version": "<its EIP-712 ' +
          'version>" }. For USDC on Base that is { "name": "USD Coin", "version": "2" } — note ' +
          'the NAME, not the ticker. @x402/evm throws at payment CREATION when either is absent ' +
          '("EIP-712 domain parameters (name, version) are required in payment requirements for ' +
          'asset …"), so no payment is attempted at all; older clients signed a truncated domain ' +
          'instead and every settlement came back invalid_exact_evm_payload_signature with ' +
          'nothing in your logs to explain it. Not needed for permit2 without EIP-2612, for ' +
          'erc7710, or on Solana.'
      );
    }

    // A v2 accept is exactly seven fields. A stray v1 field is not rejected by
    // anything — @x402/core's PaymentRequirementsV2Schema is a plain z.object,
    // so unknown keys are STRIPPED rather than refused — which is precisely
    // what makes it worth a warn rather than an error, and also what the old
    // fix text got wrong in the other direction.
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
        '`maxAmountRequired` became `amount`. Nothing rejects a stray — the v2 schema is a ' +
        'plain object, so a zod-validating consumer silently DROPS the field while a consumer ' +
        'that echoes the raw entry keeps it, and any comparison between the two then differs. ' +
        'The likelier cost is simpler: a v1 field in a v2 entry usually means the two envelopes ' +
        'are being built from one code path that has not finished being split.'
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
  // Counted on the report as well as reported here, so the terminal
  // FINDINGS_TRUNCATED notice can say the report is incomplete for this reason
  // too. One bound reporting itself is good; the reader needing to notice which
  // of three bounds fired is not.
  if (skipped > 0) report.acceptsSkipped += skipped;
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

function lintV2Resource(report, resource, requestUrl, bazaarMethod) {
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
  if (typeof resource.url === 'string') {
    try {
      parsed = new URL(resource.url);
    } catch {
      /* reported below */
    }
  }

  // TWO CHECKS, TWO REGIMES, ONE FIELD, and separating them is what stops a
  // relative resource.url being an F. A client does not read resource.url to
  // decide what to sign — it copies it into the payment payload, which is what
  // the settlement is attributed to — so a bad one costs bookkeeping, at warn.
  // CDP's url_valid and url_https preflights are both REQUIRED, so the same bad
  // value costs the listing outright, and that is an error in the bazaar regime.
  report.check(
    'V2_RESOURCE_URL_PARSES',
    parsed !== null,
    resource.url === undefined
      ? 'resource.url is missing.'
      : `resource.url ${clip(JSON.stringify(resource.url))} does not parse as a URL.`,
    'resource.url must be the absolute URL of the paid endpoint, e.g. ' +
      '"https://example.com/api/thing". @x402/core copies this field verbatim into the ' +
      'PaymentPayload the buyer sends, so a bare path or a non-URL is what your settlement ' +
      'records get attributed to.'
  );
  report.check(
    'V2_RESOURCE_URL',
    parsed !== null && parsed.protocol === 'https:',
    parsed === null
      ? 'resource.url is not an absolute https URL.'
      : `resource.url is "${clip(parsed.href)}", which is ${clip(parsed.protocol)} rather than https.`,
    'CDP marks url_valid and url_https as REQUIRED preflight checks, so an http:// or ' +
      'relative resource.url is not indexed at all. Publish the absolute https URL of the ' +
      'endpoint that answers the 402 — an indexer holding only the envelope has nothing to ' +
      'resolve a relative path against.'
  );

  // NOT "resource.method is missing" — see the catalogue note. There is no
  // `method` member in the v2 ResourceInfo table, so its absence is silence.
  // The disagreement case is what survives, and it is worth a warn: an agent
  // reads resource.method, CDP's matches_request preflight reads
  // bazaar.info.input.method, and if they differ one of them is calling you wrong.
  if (nonEmptyString(resource.method) && nonEmptyString(bazaarMethod)) {
    report.check(
      'V2_RESOURCE_METHOD',
      resource.method.toUpperCase() === bazaarMethod.toUpperCase(),
      `resource.method is "${clip(resource.method)}" but bazaar.info.input.method is "${clip(bazaarMethod)}".`,
      'Make the two agree. An agent reading your listing takes the verb from one of them and ' +
        "CDP's matches_request check takes it from extensions.bazaar.info.input.method, so a " +
        'disagreement means one population of callers uses the wrong method on the first try.'
    );
  }

  // ABSENT IS AN INFO — the ResourceInfo table marks description Optional, and
  // the batch-settlement profile omits it deliberately to keep the header
  // small. OVER THE LIMIT IS AN ERROR, and the 500 is now sourced: CDP's seller
  // docs say the facilitator rejects verify and settle past it. The old fix
  // text asserted that number while checking nothing.
  const description = resource.description;
  if (!nonEmptyString(description)) {
    report.check(
      'V2_RESOURCE_DESCRIPTION',
      false,
      'resource.description is not set.',
      'Write one sentence saying what the call does. Optional in the specification, and some ' +
        'header-size-constrained networks drop it on purpose — but it is the line an agent ' +
        'reads when deciding whether to pay you, so an empty listing competes badly. Keep it ' +
        `under ${CDP_MAX_DESCRIPTION} characters.`,
      'info'
    );
  } else {
    report.check(
      'V2_RESOURCE_DESCRIPTION',
      description.length <= CDP_MAX_DESCRIPTION,
      `resource.description is ${description.length} characters, past CDP's ${CDP_MAX_DESCRIPTION}-character limit.`,
      `Cut it to ${CDP_MAX_DESCRIPTION} characters or fewer. CDP's seller documentation is ` +
        'explicit that the facilitator REJECTS verify and settle requests whose description ' +
        'exceeds that length — so this is not a listing-quality nit, it is every payment on ' +
        'this resource failing at the facilitator.'
    );
  }

  // Present-but-nonsense only. mimeType is Optional in the spec and nullish in
  // the client schema, so its absence is a choice rather than a defect.
  if (resource.mimeType !== undefined) {
    report.check(
      'V2_RESOURCE_MIMETYPE',
      typeof resource.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+/.test(resource.mimeType.trim()),
      `resource.mimeType is ${clip(JSON.stringify(resource.mimeType), 60)}, which is not a type/subtype media type.`,
      'Use a media type, e.g. "application/json" or "text/html". A value that is not one is ' +
        'ignored by anything reading the listing, which makes it worse than leaving the ' +
        'optional field out.'
    );
  }

  if (requestUrl && parsed) {
    report.check(
      'V2_RESOURCE_URL_MATCHES',
      parsed.href.replace(/\/$/, '') === String(requestUrl).replace(/\/$/, ''),
      `resource.url is "${clip(parsed.href)}" but this envelope was served from "${clip(requestUrl)}".`,
      'Point resource.url at the URL that actually answers the 402. A mismatch sends the ' +
        'discovery index — and the settlement record attached to it — at a different URL ' +
        'from the one buyers call. Legitimate when a proxy, a route template or a canonical ' +
        'host is in play, which is why this is an info.'
    );
  }

  // ABSENT IS SILENT. Both fields are marked "Required: No" and "purely
  // additive" by bazaar.md; charging a conformant envelope for omitting them
  // was a house preference wearing a spec's clothes. PRESENT-BUT-INVALID is the
  // real finding, and the spec's own remediation is what makes it one: the
  // facilitator DROPS a field that fails its rule, so an over-long serviceName
  // produces exactly the bare-URL listing the seller was trying to avoid.
  if (resource.serviceName !== undefined) {
    const name = resource.serviceName;
    const ok =
      typeof name === 'string' && name.length > 0 && name.length <= MAX_SERVICE_NAME && PRINTABLE_ASCII_RE.test(name);
    report.check(
      'V2_SERVICE_NAME',
      ok,
      `resource.serviceName ${clip(JSON.stringify(name), 80)} is not a non-empty string of at most ` +
        `${MAX_SERVICE_NAME} printable-ASCII characters.`,
      `Trim it to ${MAX_SERVICE_NAME} printable ASCII characters (U+0020–U+007E: no emoji, no ` +
        'accents, no control characters). The facilitator SOFT-DROPS a serviceName that fails ' +
        'this rule rather than rejecting the envelope, so the cost is silent — your listing ' +
        'shows a bare URL and nothing tells you why.'
    );
  }
  if (resource.tags !== undefined) {
    const tags = resource.tags;
    const bad = !Array.isArray(tags)
      ? 'is not an array'
      : tags.length > MAX_TAGS
        ? `has ${tags.length} entries, past the ${MAX_TAGS}-entry limit`
        : tags.find(
              (t) => typeof t !== 'string' || t.length === 0 || t.length > MAX_TAG_LENGTH || !PRINTABLE_ASCII_RE.test(t)
            ) !== undefined
          ? `contains an entry that is not a non-empty printable-ASCII string of at most ${MAX_TAG_LENGTH} characters`
          : null;
    report.check(
      'V2_TAGS',
      bad === null,
      `resource.tags ${bad}.`,
      `Publish at most ${MAX_TAGS} tags, each a non-empty printable-ASCII string of at most ` +
        `${MAX_TAG_LENGTH} characters. The facilitator truncates to the first ${MAX_TAGS} valid ` +
        'entries and drops individual invalid ones, so the tags you lose are lost silently — ' +
        'and tags are how an agent filters a directory down to the tools it is looking for.'
    );
  }
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
function lintBazaar(report, extensions, probedMethod) {
  const bazaar = isObject(extensions) ? extensions.bazaar : undefined;

  if (!isObject(bazaar)) {
    report.check(
      'V2_BAZAAR_PRESENT',
      false,
      bazaar === undefined
        ? 'extensions.bazaar is absent — this resource is payable but not discoverable.'
        : `extensions.bazaar is ${clip(JSON.stringify(bazaar), 60)}, not an object — this resource is payable but not discoverable.`,
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
    lintBazaarInput(report, bazaar.info.input, probedMethod);
    lintBazaarOutput(report, bazaar.info.output);
  }

  if (hasSchema) lintBazaarSchema(report, bazaar.schema);

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

/**
 * `bazaar.info.input` — a DISCRIMINATED UNION, and checking only that it is an
 * object was the hole that let x402#3045's fourth production bug through.
 *
 * bazaar.md:251-282 gives three shapes keyed on `type`: query methods
 * (GET/HEAD/DELETE), body methods (POST/PUT/PATCH, which additionally require
 * bodyType and body), and MCP tools (which require toolName and inputSchema).
 * CDP marks input.type and input.method required, and marks a fourth check —
 * `matches_request` — required too: the declared verb must be the verb the
 * prober used, or the resource is not catalogued.
 */
function lintBazaarInput(report, input, probedMethod) {
  if (
    !report.check(
      'V2_BAZAAR_INPUT',
      isObject(input),
      input === undefined
        ? 'bazaar.info.input is missing — there is no sample call.'
        : `bazaar.info.input is ${clip(JSON.stringify(input), 60)}, not an object.`,
      'Add "input": { "type": "http", "method": "<verb>", "bodyType": "text", "body": ' +
        '"<a request body that really works>" }. It is a worked example, not a description ' +
        'of one: an agent will send exactly this, so an example that 400s is worse than none.'
    )
  ) {
    return;
  }

  const type = input.type;
  if (
    !report.check(
      'V2_BAZAAR_INPUT_TYPE',
      type === 'http' || type === 'mcp',
      type === undefined
        ? 'bazaar.info.input has no `type` discriminator.'
        : `bazaar.info.input.type is ${clip(JSON.stringify(type), 40)}, not "http" or "mcp".`,
      'Set "type": "http" for an HTTP endpoint or "mcp" for an MCP tool. It is the field a ' +
        'facilitator reads FIRST, to decide which set of validation rules applies — without it ' +
        'the whole block is uninterpretable, and this is the exact omission behind the ' +
        'longest-running Bazaar indexing failure report (x402#3045).'
    )
  ) {
    return;
  }

  if (type === 'mcp') {
    // bazaar.md:271-282 — toolName and inputSchema are Required; method is not
    // part of the MCP shape at all, so the HTTP method checks below are skipped.
    const missing = ['toolName', 'inputSchema'].filter((f) => input[f] === undefined);
    report.check(
      'V2_BAZAAR_INPUT_TYPE',
      missing.length === 0,
      `bazaar.info.input declares type "mcp" but has no ${missing.join(' and no ')}.`,
      'An MCP input requires "toolName" (what is passed to tools/call) and "inputSchema" (the ' +
        'JSON Schema for the tool\'s arguments — reuse the one your MCP tool already declares). ' +
        'Note that for MCP the catalogue key is the pair (resource.url, input.toolName), because ' +
        'one server endpoint multiplexes many tools.'
    );
    return;
  }

  const method = input.method;
  const isQuery = BAZAAR_QUERY_METHODS.includes(method);
  const isBody = BAZAAR_BODY_METHODS.includes(method);
  if (
    !report.check(
      'V2_BAZAAR_INPUT_METHOD',
      isQuery || isBody,
      method === undefined
        ? 'bazaar.info.input has no `method`.'
        : `bazaar.info.input.method is ${clip(JSON.stringify(method), 40)}, which is not one of ${[...BAZAAR_QUERY_METHODS, ...BAZAAR_BODY_METHODS].join(', ')}.`,
      `Set "method" to one of ${BAZAAR_QUERY_METHODS.join(', ')} (query-parameter methods) or ` +
        `${BAZAAR_BODY_METHODS.join(', ')} (body methods). CDP marks this a required check, and ` +
        'it is the verb an agent will actually send.'
    )
  ) {
    return;
  }

  // THE VERB MUST BE THE VERB. CDP probes the endpoint and compares. When this
  // linter was handed no method — /lint/envelope, where nothing was fetched —
  // there is nothing to compare against and the check does not run.
  if (nonEmptyString(probedMethod)) {
    report.check(
      'V2_BAZAAR_INPUT_METHOD',
      method.toUpperCase() === String(probedMethod).toUpperCase(),
      `bazaar.info.input.method declares "${clip(method)}" but this 402 was fetched with ${clip(String(probedMethod).toUpperCase())}.`,
      'Declare the verb the endpoint actually answers on. CDP\'s matches_request check is ' +
        'REQUIRED: the facilitator probes your URL and compares the method it used with the one ' +
        'you declared, and a mismatch means the resource is not catalogued. If this linter used ' +
        'the wrong verb, lint again with {"method": "' + clip(method, 12) + '"}.'
    );
  }

  if (isBody) {
    const missing = ['bodyType', 'body'].filter((f) => input[f] === undefined);
    report.check(
      'V2_BAZAAR_INPUT_TYPE',
      missing.length === 0,
      `bazaar.info.input.method is "${clip(method)}", a body method, but there is no ${missing.join(' and no ')}.`,
      `A ${BAZAAR_BODY_METHODS.join('/')} input requires "bodyType" (one of ` +
        `${BAZAAR_BODY_TYPES.join(', ')}) and "body" (a request body that really works). An ` +
        'agent sends exactly what is published here.'
    );
    if (input.bodyType !== undefined) {
      report.check(
        'V2_BAZAAR_INPUT_TYPE',
        BAZAAR_BODY_TYPES.includes(input.bodyType),
        `bazaar.info.input.bodyType is ${clip(JSON.stringify(input.bodyType), 40)}, not one of ${BAZAAR_BODY_TYPES.join(', ')}.`,
        `bodyType is one of ${BAZAAR_BODY_TYPES.join(', ')}. "text" is the safe choice for a ` +
          'body that is JSON on the wire but sent as a string.'
      );
    }
  }
}

/**
 * `bazaar.info.output` — optional as a whole, and CDP grades both of its checks
 * ADVISORY, which is the ceiling on how loudly either may be reported.
 *
 * The example is typed `any` (bazaar.md:284-294) and every one of the spec's
 * own examples gives it as an OBJECT. Demanding a non-empty string here
 * reported the specification's own worked example as "missing", which is the
 * worst kind of wrong: confidently, about a document that is right there.
 */
function lintBazaarOutput(report, output) {
  if (output === undefined) {
    report.check(
      'V2_BAZAAR_OUTPUT_EXAMPLE',
      false,
      'bazaar.info.output is not published.',
      'Optional, and CDP treats it as advisory — but add "output": { "type": "json", ' +
        '"example": <what the sample input above really returns> } if you want agents to know ' +
        'the response shape before they pay. Compute the example at build time from the real ' +
        'code path rather than typing one by hand, or it drifts the first time you change the ' +
        'endpoint and nothing tells you.'
    );
    return;
  }
  if (
    !report.check(
      'V2_BAZAAR_OUTPUT_TYPE',
      isObject(output) && output.type !== undefined,
      isObject(output)
        ? 'bazaar.info.output has no `type`.'
        : `bazaar.info.output is ${clip(JSON.stringify(output), 60)}, not an object.`,
      'Within the optional output object, "type" is Required — the response content type, e.g. ' +
        '"json" or "text". An output block without it describes nothing a facilitator can index.'
    )
  ) {
    return;
  }
  report.check(
    'V2_BAZAAR_OUTPUT_EXAMPLE',
    output.example !== undefined,
    'bazaar.info.output.example is not published.',
    'Add "example": <the sample input above, actually run through your endpoint>. ANY JSON ' +
      'value is legal — an object, an array, a string, a number — and the specification\'s own ' +
      'examples use objects. Compute it at build time from the real code path; a hand-written ' +
      'one drifts the first time the endpoint changes and nothing tells you.'
  );
}

/**
 * The bazaar schema's OWN content MUSTs — bazaar.md:313-322.
 *
 * Checking that `schema` is an object said nothing: `{}` passed, and so did a
 * schema whose entire content was `{"$ref": "https://internal.corp/x.json"}`.
 * That last one is x402#3045's fifth production bug verbatim — an external $ref
 * broke CDP's validator outright, and the spec now forbids it in terms:
 * facilitators MUST NOT resolve external references when validating an
 * untrusted schema, so a schema that needs one cannot be validated at all.
 */
function lintBazaarSchema(report, schema) {
  const problems = [];
  if (!isObject(schema.properties) || schema.properties.input === undefined) {
    problems.push('it defines no `input` property');
  }
  if (!(Array.isArray(schema.required) && schema.required.includes('input'))) {
    problems.push('it does not list "input" in `required`');
  }
  const external = externalRefs(schema);
  if (external.length) {
    problems.push(
      `it carries ${external.length} external reference${external.length > 1 ? 's' : ''} (${clip(external.slice(0, 3).join(', '), 160)})`
    );
  }

  report.check(
    'V2_BAZAAR_SCHEMA_CONTENT',
    problems.length === 0,
    `bazaar.schema does not meet the extension's own requirements: ${clip(problems.join('; '), 300)}.`,
    'The schema must be JSON Schema Draft 2020-12, must define an `input` property and list it ' +
      'in `required`, and every $ref and $id must be a SAME-DOCUMENT pointer starting with "#". ' +
      'External references (http(s)://, file://, or any other absolute URI) are not allowed, and ' +
      'this is not a style rule: the specification says facilitators MUST NOT resolve them when ' +
      'validating an untrusted schema, so a schema that depends on one is a schema no ' +
      'facilitator can validate. Inline the definitions, or move them into $defs and point at ' +
      '"#/$defs/…".'
  );
}

/** Every $ref/$id in a schema that is not a same-document "#…" fragment. */
function externalRefs(node, found = [], depth = 0) {
  if (depth > 24 || !isObject(node)) return found;
  for (const key of ['$ref', '$id']) {
    const value = node[key];
    if (typeof value === 'string' && !value.startsWith('#')) found.push(value);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) externalRefs(item, found, depth + 1);
    } else if (isObject(value)) {
      externalRefs(value, found, depth + 1);
    }
    if (found.length > 8) break;
  }
  return found;
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
 *
 * AND A BODY THAT DECLARES ITSELF v2 IS NEVER A v1 ATTEMPT. That clause is the
 * second half of the same lesson. A v2-only seller who mirrors their v2
 * envelope into the 402 body — a common and entirely harmless defensive habit,
 * since a v2 client reads the header first and consults the body only when
 * there is none — was being run through the whole v1 cascade and graded F with
 * five core errors, every one of them saying "this v1 envelope is missing a v1
 * field" about an object that had never claimed to be one. The body says
 * x402Version 2. Believe it, say so once, and move on.
 */
function isV1Attempt(parsed) {
  if (!isObject(parsed)) return false;
  if (parsed.x402Version === 2) return false;
  return (
    parsed.x402Version !== undefined || parsed.accepts !== undefined || parsed.maxAmountRequired !== undefined
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

  // A BODY DECLARING x402Version 2 IS REPORTED ONCE, HERE, and then the v1
  // cascade does not run over it — see isV1Attempt(). It is a warn rather than
  // a core error because a v2 client reads the PAYMENT-REQUIRED header first
  // and consults the body only when there is none, so with a valid header this
  // is a harmless echo; without one, ENVELOPE_PRESENT carries the F, and it
  // carries it as one finding about one fault instead of five.
  const saysV2 = isObject(parsed) && parsed.x402Version === 2;
  report.check(
    'VERSION_BODY_SAYS_V2',
    !saysV2,
    v2Published
      ? 'the 402 BODY carries a payload declaring x402Version 2, mirroring the header envelope.'
      : 'the 402 BODY carries a payload declaring x402Version 2, and there is no PAYMENT-REQUIRED header.',
    v2Published
      ? 'Harmless to a v2 client, which reads the PAYMENT-REQUIRED header and only falls back ' +
        'to the body when there is none — but a v1 client parses this body with v1 rules ' +
        'whatever it declares, finds none of maxAmountRequired, a plain network name or a flat ' +
        'resource string, and fails. Serve the v1 envelope here instead, or serve nothing.'
      : 'The body is the v1 transport and the v1 rules are the ones a reader will apply to it. ' +
        'Move this envelope into a standard-base64 PAYMENT-REQUIRED response header, where a v2 ' +
        'client will find it — @x402/core\'s body fallback accepts x402Version 1 and nothing ' +
        'else, so as published this envelope is invisible to both generations.'
  );

  // --- no v1 attempt ----------------------------------------------------
  if (!isV1Attempt(parsed)) {
    if (v2Published) {
      report.check(
        'V1_ABSENT',
        false,
        'the 402 body carries no x402 v1 envelope — this endpoint publishes v2 only.',
        'Optional, and only you can price it: a v1 client (x402-fetch v1, and anything written ' +
          'against the pre-header protocol) reads the 402 BODY and never looks at the ' +
          'PAYMENT-REQUIRED header, so it cannot pay this endpoint at all. Serving both from one ' +
          '402 costs one JSON body: { "x402Version": 1, "accepts": [ … ] }, with the v1 spellings ' +
          '(maxAmountRequired, a plain network name, a flat resource string). Everything else ' +
          'here is already right. If you publish no v1 envelope at all, serve at least `{}`: ' +
          "CDP's validator lists valid_json as a REQUIRED preflight, so a completely empty 402 " +
          'body may cost you the listing on its own.'
      );
      // AN INFO, AND THE DOWNGRADE IS THE SPECIFICATION'S. transports-v2 puts
      // the response body outside the protocol entirely — "Response bodies are
      // a server implementation concern" — and the spec's own canonical 402
      // serves a body of `{}`. A check that costs the specification's own
      // example a grade is a check that is wrong, however good its intention.
      report.check(
        'V1_BODY_NOT_ENVELOPE',
        !text.trim() || saysV2,
        `the 402 body is ${clip(text.trim(), 120)} — ${
          parseError ? 'not JSON' : 'JSON, but not an x402 envelope'
        }.`,
        'Only matters for the pre-header clients: x402-fetch@1.x parses whatever JSON is here as ' +
          'the envelope, finds no accepts[], and reports a payment failure naming your error ' +
          'string rather than the real cause. Note that an EMPTY body is not obviously better — ' +
          'the same client throws a SyntaxError on it, and CDP\'s validator lists valid_json as ' +
          'a required preflight, so `{}` is the safest thing to serve if you serve no v1 envelope.'
      );
      return null;
    }

    // No v2 header either, so this body is all there is — and it is not an
    // envelope. ENVELOPE_PRESENT upstream carries the core error; what is
    // useful here is naming what the body actually contains.
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
    report.check(
      'V1_BODY_NOT_ENVELOPE',
      saysV2,
      `the 402 body is ${clip(text.trim(), 120)} — JSON, but not an x402 envelope, and there is no PAYMENT-REQUIRED header either.`,
      'Nothing on this response is payable. Serve the v1 envelope in the body ' +
        '({ "x402Version": 1, "accepts": [ … ] }), the v2 envelope in a standard-base64 ' +
        'PAYMENT-REQUIRED header, or — better — both.'
    );
    return null;
  }

  // --- a v1 attempt -----------------------------------------------------
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
    'Send "content-type: application/json; charset=utf-8" on the 402. @x402/core\'s ' +
      'processResponse decides whether to parse a body at all from its content-type, so a v1 ' +
      'envelope labelled text/html reaches the version-fallback path as a bare string and the ' +
      'fallback fails. x402-fetch@1.x does NOT check the header — it calls response.json() ' +
      'regardless — so this costs some client paths and most proxies rather than every buyer.'
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
    return { env, accept: null, accepts: [] };
  }

  const accept = accepts[0];
  lintV1Accept(report, accept, accepts);
  return { env, accept, accepts };
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
      'Set "scheme": "exact". In v1 that is not merely the common choice — it is the only ' +
        'member of the client\'s enum. (`exact` is a family, not one mechanism: EIP-3009 on ' +
        'EVM, SPL TransferChecked on Solana.)');
    // V1'S ENUM IS CLOSED WHERE V2'S IS OPEN, which is why this is an error and
    // V2_SCHEME_KNOWN is an info. x402-fetch runs every accepts entry through
    // PaymentRequirementsSchema.parse, so a scheme outside the enum is a
    // ZodError thrown before any requirement is even selected.
    report.check(
      'V1_SCHEME_KNOWN',
      !nonEmptyString(entry.scheme) || V1_SCHEMES.includes(entry.scheme),
      `${where} uses the scheme "${clip(entry.scheme)}", which no v1 client will parse.`,
      `v1's schema is z.enum([${V1_SCHEMES.map((x) => `"${x}"`).join(', ')}]) and it is applied ` +
        'to every accepts entry, so a non-member is a hard parse failure for the whole envelope ' +
        '— not a skipped entry. If you offer another scheme, publish it in the v2 header ' +
        'envelope, where the scheme field is deliberately open, and keep "exact" here.'
    );

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

    // NETWORK — CAIP-2 here is the v2 form in a v1 envelope. Two checks, and the
    // split matters: the version-confusion case is core (a v1 client's enum has
    // no member containing a colon, and neither does any chain's plain name),
    // while an unrecognised plain name is an error the modern v1-compatibility
    // schema would nonetheless accept, so it is not an F.
    if (typeof entry.network !== 'string' || !entry.network) {
      report.check('V1_NETWORK_NAME', false,
        `${where} names no network${entry.network === undefined ? '' : ` — it carries ${clip(JSON.stringify(entry.network), 60)}, which is not a string`}.`,
        'Set "network" to the v1 plain name of the chain, as a STRING, e.g. "base".');
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
      report.check(
        'V1_NETWORK_KNOWN',
        V1_NETWORK_ENUM.includes(entry.network),
        `${where} network "${clip(entry.network)}" is not one of the names the v1 client's enum admits.`,
        `The v1 vocabulary is a closed list: ${V1_NETWORK_ENUM.join(', ')}. x402-fetch parses ` +
          'every accepts entry against it, so a name outside the list — including a correct ' +
          'chain spelled differently, like "Base" or "ethereum" — throws an invalid_enum_value ' +
          'error and the envelope cannot be paid at all. Newer chains have no v1 spelling; ' +
          'publish those in the v2 header envelope, where networks are CAIP-2 and open-ended.'
      );
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
      // NOT MERELY NON-EMPTY. x402@1.2.0 types this field z.string().url(), so
      // a bare path — the v1 spelling of x402#3045's third production bug —
      // is a ZodError, not a lenient pass.
      report.check(
        'V1_RESOURCE_STRING',
        nonEmptyString(entry.resource) && parsesAsUrl(entry.resource),
        entry.resource === undefined
          ? `${where} has no resource.`
          : `${where} resource ${clip(JSON.stringify(entry.resource))} is not an absolute URL.`,
        'Set "resource" to the ABSOLUTE URL of the paid endpoint, as a plain string — ' +
          '"https://example.com/api/thing", not "/api/thing". The v1 client validates it with ' +
          'z.string().url() before selecting any requirement, so a relative path fails the whole ' +
          'envelope; it is also what the client signs against and what a settlement is ' +
          'attributed to.'
      );
    }

    // ADDRESS SHAPES DISPATCH ON THE V1 NETWORK NAME. The v1 client's own
    // payTo type is `EvmOrSvmAddress` — a union — and its network enum includes
    // solana and solana-devnet, so a 0x-only rule graded a legal Solana v1
    // entry F. See addressFamily().
    const family = addressFamily(entry.network, 1);
    report.check(
      'V1_PAYTO',
      addressOk(family, entry.payTo),
      entry.payTo === undefined
        ? `${where} has no payTo — there is nowhere to send the money.`
        : typeof entry.payTo !== 'string'
          ? `${where} payTo is ${clip(JSON.stringify(entry.payTo), 60)}, not a string.`
          : `${where} payTo "${clip(entry.payTo)}" is not ${ADDRESS_SHAPE[family]}.`,
      family === 'svm'
        ? 'payTo is the merchant\'s Solana public key, base58 (32–44 characters).'
        : 'payTo is the 0x-prefixed, 40-hex-character receiving address. The v1 client accepts ' +
          'either an EVM address or a base58 Solana one, and picks which to expect from the ' +
          'network name on this entry.'
    );
    report.check(
      'V1_ASSET',
      addressOk(family, entry.asset),
      entry.asset === undefined
        ? `${where} names no asset.`
        : typeof entry.asset !== 'string'
          ? `${where} asset is ${clip(JSON.stringify(entry.asset), 60)}, not a string.`
          : `${where} asset "${clip(entry.asset)}" is not ${ADDRESS_SHAPE[family]}.`,
      family === 'svm'
        ? 'Set "asset" to the SPL token mint public key, base58.'
        : 'Set "asset" to the token CONTRACT ADDRESS on that chain — USDC on Base is ' +
          '"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913". A ticker is not an address: the signer ' +
          'passes this field to viem\'s getAddress() to build the EIP-712 verifyingContract, ' +
          'and it throws.'
    );
    // SPEC SAYS OPTIONAL, THE CLIENT SAYS REQUIRED, AND THE CLIENT IS THE ONE
    // PARSING. x402@1.2.0 types mimeType z.string() with no .optional(), and
    // x402-fetch runs every entry through it — so for the exact population a v1
    // body exists to serve, an envelope without mimeType does not parse at all.
    // A warn described that as "it works, but it costs you something".
    report.check(
      'V1_MIMETYPE',
      nonEmptyString(entry.mimeType),
      entry.mimeType === undefined
        ? `${where} has no mimeType.`
        : `${where} mimeType is ${clip(JSON.stringify(entry.mimeType), 60)}, not a non-empty string.`,
      'Add "mimeType" naming what a successful response returns, e.g. "application/json". The ' +
        'v1 specification marks it Optional and the modern v1-compatibility schema agrees — but ' +
        'the dominant v1 client (x402@1.2.0) requires it, and rejects the whole envelope without ' +
        'it. v1 carries it on the accepts entry; v2 moved it onto the resource object.'
    );
    report.check(
      'V1_DESCRIPTION',
      nonEmptyString(entry.description),
      entry.description === undefined
        ? `${where} has no description.`
        : `${where} description is empty.`,
      'Add one sentence saying what the call does. It is Required in the v1 specification and ' +
        'required by both v1 parsers\' schemas, so a missing one fails the envelope outright; ' +
        'an empty string parses and simply tells an agent nothing before it decides to pay.',
      // An empty string is what both schemas accept, so it is the milder case.
      entry.description === '' ? 'warn' : undefined
    );
    report.check(
      'V1_MAX_TIMEOUT',
      typeof entry.maxTimeoutSeconds === 'number' &&
        Number.isInteger(entry.maxTimeoutSeconds) &&
        entry.maxTimeoutSeconds > 0,
      entry.maxTimeoutSeconds === undefined
        ? `${where} has no maxTimeoutSeconds.`
        : `${where} maxTimeoutSeconds is ${clip(JSON.stringify(entry.maxTimeoutSeconds), 60)}, not a positive integer JSON number.`,
      'Set "maxTimeoutSeconds" to a whole NUMBER — 60 is the common value, and 60 is not "60". ' +
        'x402@1.2.0 types it z.number().int() and requires it, so a string, a float or an ' +
        'absence is a parse failure rather than a default. The client uses it for validBefore on ' +
        'the authorization it signs.'
    );
    // Only where an EIP-712 domain exists to publish. v1 Solana `exact` uses
    // TransferChecked and has no typed-data domain at all.
    if (family === 'evm') {
      report.check(
        'V1_EXTRA_EIP712',
        isObject(entry.extra) && nonEmptyString(entry.extra.name) && nonEmptyString(String(entry.extra.version ?? '')),
        `${where} has no extra.{name,version} — the EIP-712 domain is missing.`,
        'Add "extra": { "name": "USD Coin", "version": "2" } for USDC on Base — the token\'s ' +
          'on-chain name(), not its ticker. The v1 client reads extra?.name and extra?.version ' +
          'straight into the typed-data domain with NO fallback, and viem quietly drops undefined ' +
          'members, so the buyer signs a truncated domain while the facilitator recomputes a full ' +
          'one from its own table. Every settlement then fails as ' +
          'invalid_exact_evm_payload_signature, with nothing in your logs to explain it.'
      );
    }

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
    // AN OPT-OUT. The reference v1-to-v2 discovery extractor's own comment is
    // "Check if discoverable (default to true if not specified)", so an absent
    // flag means indexed and demanding the explicit `true` fired on envelopes
    // the reference facilitator catalogues. What is worth saying is the
    // opposite: you turned discovery OFF, in case you did not mean to.
    if (hasOutputSchema) {
      const input = isObject(outputSchema.input) ? outputSchema.input : null;
      const optedOut = input !== null && input.discoverable === false;
      const misplaced = input !== null && input.discoverable === undefined && outputSchema.discoverable !== undefined;
      report.check(
        'V1_DISCOVERABLE',
        !optedOut && !misplaced,
        optedOut
          ? `${where} sets outputSchema.input.discoverable = false — this resource has explicitly opted out of v1 discovery.`
          : `${where} sets \`discoverable\` at the top level of outputSchema rather than inside outputSchema.input.`,
        optedOut
          ? 'Nothing to fix if that was deliberate. Remove the flag, or set it to true, to be ' +
            'indexed — absence means indexed, because the reference extractor defaults it to true.'
          : 'The flag the v1 extractor reads is outputSchema.input.discoverable. One at the top ' +
            'level of outputSchema is ignored — harmlessly, since absence defaults to ' +
            'discoverable anyway, but it means the value you wrote is doing nothing. Move it ' +
            'inside `input`, or delete it.'
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
 *
 * ------------------------------------------------------------------ pairing
 *
 * THE ENTRIES ARE MATCHED BEFORE THEY ARE COMPARED, and the old code did not do
 * that. It compared v1 accepts[0] with v2 accepts[0], so a seller who offered
 * Base and Avalanche in both envelopes and happened to list them in a different
 * order in each — an ordering neither specification says anything about — was
 * graded F on payTo, price, chain AND asset simultaneously, four core errors
 * for a fault that did not exist.
 *
 * Offers are keyed on (resolved chain, lowercased asset), because that is what
 * makes two entries the same OFFER: the same money on the same chain. A price
 * difference between an 18-decimal asset and a 6-decimal one is not a
 * divergence, it is two different assets correctly priced, and the old
 * comparison called it a core error too.
 *
 * A v1 entry with no counterpart is reported ONCE, at info, as unverifiable —
 * not as a disagreement. This linter declining to assert something it cannot
 * check is the same discipline the DUAL_NETWORK unknown-chain case already had.
 */
function lintDualStack(report, v1, v2) {
  const v1Accepts = (v1?.accepts ?? []).filter(isObject);
  const v2Accepts = (v2?.accepts ?? []).filter(isObject);
  if (!v1Accepts.length || !v2Accepts.length) return;

  const { pairs, unmatched } = pairOffers(v1Accepts, v2Accepts);

  if (!pairs.length) {
    // ONE OFFER ON EACH SIDE THAT DO NOT MATCH IS NOT AN AMBIGUITY. There is
    // nothing to pair it WITH: the seller described one offer twice and the two
    // descriptions disagree, which is the original DUAL_NETWORK/DUAL_ASSET case
    // and stays a core error. The unverifiable answer below is for the case it
    // was invented for — several offers on each side that happen not to line
    // up, where this linter genuinely cannot tell which was meant to match which.
    if (v1Accepts.length === 1 && v2Accepts.length === 1) {
      const [a] = v1Accepts;
      const [b] = v2Accepts;
      const chain1 = chainOf(a.network);
      const chain2 = chainOf(b.network);
      const pair = `the v1 envelope is on ${clip(a.network ?? '(nothing)')} and the v2 envelope on ${clip(b.network ?? '(nothing)')}`;
      if (chain1 !== null && chain2 !== null && chain1 !== chain2) {
        report.check(
          'DUAL_NETWORK',
          false,
          `${pair} — chains ${clip(chain1)} and ${clip(chain2)}.`,
          'The two envelopes must name the SAME chain in each version\'s spelling — "base" in ' +
            'v1, "eip155:8453" in v2. A genuine chain difference means a payment signed on one ' +
            'chain is worthless on the other, and only one of your two buyer generations is ' +
            'being quoted the terms you meant.'
        );
      } else if (chain1 === null || chain2 === null) {
        // A chain this linter has no mapping for. It declines to assert a
        // mismatch it cannot verify, and says which half it could not resolve.
        report.check(
          'DUAL_NETWORK',
          false,
          `${pair} — this linter does not recognise ${chain1 === null ? 'the v1 name' : 'the v2 identifier'}, ` +
            'so it could not verify that the two name the same chain.',
          'Check by hand that the two spellings are the same chain — the v1 plain name and the ' +
            'v2 CAIP-2 id, e.g. "arbitrum" and "eip155:42161". This linter maps only the chains ' +
            'that have a spelling in both generations, so an unrecognised pair is reported as ' +
            'unverified rather than as wrong. If they DO disagree, a payment signed on one chain ' +
            'is worthless on the other.',
          'info',
          false
        );
      }
      report.check(
        'DUAL_ASSET',
        !(chain1 !== null && chain1 === chain2),
        `on ${clip(chain1 ?? a.network)} the v1 envelope wants ${clip(a.asset ?? '(nothing)')} and ` +
          `the v2 envelope wants ${clip(b.asset ?? '(nothing)')}.`,
        'Name one token contract in both envelopes. Different assets means the two versions are ' +
          'selling for different money, and a buyer who signs for the wrong one has paid you in ' +
          'something you did not quote.'
      );
      return;
    }

    // Several offers a side, and none of them line up. Saying "these disagree"
    // would be a claim about entries this linter never managed to put side by side.
    report.check(
      'DUAL_NETWORK',
      false,
      `the v1 envelope offers ${clip(v1Accepts.map((e) => e.network).join(', '), 120)} and the v2 ` +
        `envelope offers ${clip(v2Accepts.map((e) => e.network).join(', '), 120)} — no (chain, asset) ` +
        'pair appears in both, so the two could not be compared.',
      'Check by hand that the two envelopes describe the same offers. Entries are matched on ' +
        'the chain and the asset, in each version\'s spelling — "base" and "eip155:8453" are the ' +
        'same chain — so no overlap means either a chain this linter has no mapping for, or two ' +
        'envelopes genuinely selling different things to different buyer generations.',
      'info',
      false
    );
    return;
  }

  // The first matched pair carries the comparison. Reporting every pair would
  // repeat one configuration mistake once per chain a seller supports; a
  // divergence is a fact about how the envelopes are BUILT, not about a chain.
  const [a, b] = pairs[0];

  report.check(
    'DUAL_PAYTO',
    typeof a.payTo === 'string' &&
      typeof b.payTo === 'string' &&
      a.payTo.toLowerCase() === b.payTo.toLowerCase(),
    `on ${clip(chainOf(a.network) ?? a.network)} the v1 envelope pays ${clip(a.payTo ?? '(nothing)')} ` +
      `and the v2 envelope pays ${clip(b.payTo ?? '(nothing)')}.`,
    'Build both envelopes from ONE requirements object rather than assembling each ' +
      'separately — derive the v2 accepts entry from the v1 one. Divergent payTo means half ' +
      'your revenue lands in an address you may no longer control.'
  );

  const price1 = a.maxAmountRequired ?? a.amount;
  const price2 = b.amount ?? b.maxAmountRequired;
  report.check(
    'DUAL_PRICE',
    String(price1 ?? '') === String(price2 ?? ''),
    `for the same asset on ${clip(chainOf(a.network) ?? a.network)}, the v1 envelope asks ` +
      `${clip(price1 ?? '(nothing)')} and the v2 envelope asks ${clip(price2 ?? '(nothing)')} atomic units.`,
    'Quote one price and project it into both envelopes. Your two generations of buyers ' +
      'currently see different terms for the same call, and the cheaper one is the one you ' +
      'will be held to.'
  );

  // Matched pairs agree on chain and asset BY CONSTRUCTION, so these two report
  // on what could not be matched rather than on the pair.
  report.check(
    'DUAL_NETWORK',
    unmatched.length === 0,
    `${unmatched.length} v1 offer(s) — ${clip(unmatched.map((e) => `${e.network}/${e.asset}`).join(', '), 160)} — ` +
      'have no counterpart in the v2 envelope.',
    'Publish the same set of offers in both envelopes, in each version\'s spelling ("base" in ' +
      'v1, "eip155:8453" in v2). An offer that exists in only one generation is not wrong, but ' +
      'it means one class of buyer cannot reach terms the other can — and this linter cannot ' +
      'check the terms of an entry it has nothing to compare against.',
    'info',
    false
  );
  report.check('DUAL_ASSET', true);

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

/**
 * Match v1 offers to v2 offers on (chain, asset).
 *
 * Asset is compared case-insensitively because an EVM address is
 * case-insensitive on the wire — viem's getAddress accepts any casing — and a
 * checksummed spelling on one side is not a divergence.
 */
function pairOffers(v1Accepts, v2Accepts) {
  const key = (entry) => {
    const chain = chainOf(entry.network);
    const asset = typeof entry.asset === 'string' ? entry.asset.toLowerCase() : null;
    return chain === null || asset === null ? null : `${chain}\u0000${asset}`;
  };

  const remaining = new Map();
  for (const entry of v2Accepts) {
    const k = key(entry);
    if (k === null) continue;
    if (!remaining.has(k)) remaining.set(k, []);
    remaining.get(k).push(entry);
  }

  const pairs = [];
  const unmatched = [];
  for (const entry of v1Accepts) {
    const k = key(entry);
    const bucket = k === null ? undefined : remaining.get(k);
    if (bucket && bucket.length) pairs.push([entry, bucket.shift()]);
    else unmatched.push(entry);
  }
  return { pairs, unmatched };
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
  const { grade, summary, findings, checks_run } = runLint(response);
  return { grade, summary, findings, checks_run };
}

/**
 * The whole run, INCLUDING the set of checks that actually applied.
 *
 * `lint()` hands back the four public fields and nothing else, because that is
 * the report a buyer paid for. `lintOne()` needs one more thing — whether the
 * named check RAN — and it is not derivable from the findings: a check that
 * emitted nothing and a check that never executed look identical from outside,
 * and telling a seller "V2_B64_URLSAFE passed" about a response that publishes
 * no v2 header would be the single most expensive false negative this service
 * could sell. So the Report instance comes back too, internally, rather than
 * `ran` being bolted onto the served shape where nobody asked for it.
 */
function runLint(response) {
  const report = new Report();
  const { status, headers = {}, body = '', url = null, method = null, redirectedTo = null, truncated = false } = response || {};

  // --- HTTP layer -------------------------------------------------------
  const is3xx = status >= 300 && status < 400;
  report.check(
    'HTTP_REDIRECT',
    !is3xx && !redirectedTo,
    is3xx
      ? `the endpoint answered ${status}${redirectedTo ? ` to ${clip(redirectedTo)}` : ''} instead of a 402.`
      : `the 402 was reached through a redirect to ${clip(redirectedTo)}.`,
    'Serve the 402 directly at the advertised URL, and advertise that final URL in ' +
      'resource.url. Buyer clients DO follow redirects — @x402/fetch uses ordinary fetch, whose ' +
      'default is to follow one — so the cost is not usually a lost envelope but three narrower ' +
      'things: a 301 or 302 rewrites your POST into a GET (307 and 308 preserve it), CDP probes ' +
      'the URL you advertised rather than the one you end up at, and a cross-origin hop is where ' +
      'a payment header stops travelling. The common causes are apex-versus-www and a trailing ' +
      'slash.' +
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
  const probedVerb = String(method || 'POST').toUpperCase();
  const otherVerb = probedVerb === 'GET' ? 'POST' : 'GET';
  report.check(
    'HTTP_STATUS_402',
    status === 402 || status === 200 || is3xx,
    `the endpoint answered ${status}, not 402.`,
    'An unauthenticated request to a paid x402 endpoint must answer HTTP 402 with the ' +
      'envelope. A 401 or 403 tells a client to find credentials, which is the opposite of ' +
      'what x402 offers.' +
      (methodMayBeWrong
        ? ` A ${status} to the ${probedVerb} this lint sent is as often a ${otherVerb}-only ` +
          `endpoint as a missing route: run this again with {"method": "${otherVerb}"} before ` +
          `changing anything. If ${otherVerb} answers 402, the endpoint is fine and this finding ` +
          'is the wrong verb rather than a fault — but publish the verb in the envelope too, as ' +
          'extensions.bazaar.info.input.method, because CDP probes with the method you declare ' +
          'and agents call with it.'
        : ' A 404 means the route is not wired up at all.'),
    undefined,
    // NOT AN F ON A 404 OR A 405, and this is the whole of the correction. The
    // linter chose the verb; a conformant GET-only endpoint must not be graded
    // "does not work" because the guess was POST. Every other non-402 status is
    // a statement about the endpoint rather than about this request.
    methodMayBeWrong ? false : undefined
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

  const v2 = readEnvelopes ? lintV2(report, headers, url, method) : null;
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

  // CAN THIS BE INDEXED — the second verdict, and the one the grade cannot
  // carry. 'n/a' for a v1-only endpoint: CDP's requirements are a v2 shape, and
  // answering false would read as a failure rather than as a different question.
  Object.assign(summary, bazaarReady(report.findings, { v2Published: v2 !== null }));

  // --- what this report did not cover -----------------------------------
  //
  // ONE NOTICE FOR EVERY BOUND, because a report clipped by any of them is a
  // report that must not be read as complete. FINDINGS_TRUNCATED used to fire
  // on the findings cap alone — a cap the accepts limit and the fault-collapsing
  // made effectively unreachable, so the check was dead weight advertising a
  // guarantee nothing tested. It now fires whenever ANYTHING was clipped: the
  // findings cap, the accepts-per-envelope cap, or the caller's body byte cap.
  const findings = report.findings;
  const clipped = [];
  if (report.suppressed) {
    clipped.push(
      `the findings cap of ${MAX_FINDINGS} was reached and ${report.suppressed} further findings were suppressed`
    );
  }
  if (report.acceptsSkipped) {
    clipped.push(
      `${report.acceptsSkipped} accepts[] entries past the first ${MAX_ACCEPTS_LINTED} were not read`
    );
  }
  if (truncated) {
    clipped.push('the response body was longer than the byte cap and was read only up to it');
  }
  if (clipped.length) {
    report.ran_('FINDINGS_TRUNCATED', false);
    findings.push({
      severity: 'info',
      code: 'FINDINGS_TRUNCATED',
      core: false,
      message: `this report is not complete: ${clipped.join('; ')}.`,
      fix:
        'Fix what is listed and lint again. A report that hits these bounds almost always means ' +
        'one fault repeated across a long accepts[] array rather than that many distinct ' +
        'problems — but the part that was not read is the part this report cannot vouch for, ' +
        'and a short report is not the same thing as a clean one.',
    });
  } else {
    report.ran_('FINDINGS_TRUNCATED', true);
  }

  return { report, grade: grade(findings), summary, findings, checks_run: report.ran.size };
}

// ------------------------------------------------------------------ one named check

/**
 * Lint one response and report ONE named check.
 *
 * The engine is pure and cheap, so the whole catalogue is run and the answer is
 * filtered — there is no half-run of a lint, and a check that reads the same
 * envelope the others do would have to re-derive all of it anyway. What the
 * caller buys is the ANSWER, not the CPU.
 *
 * THREE OUTCOMES, AND THE THIRD IS THE ONE THAT MATTERS:
 *
 *   passed: true            the check ran and found nothing
 *   passed: false           the check ran and emitted; `finding` carries the fix
 *   passed: null            the check DID NOT APPLY to this response. Not a
 *                           pass, and never rendered as one — a v2 check against
 *                           a v1-only endpoint asserted nothing whatsoever, and
 *                           reporting that as a pass would sell a seller the
 *                           confidence that their v2 header is fine when they
 *                           do not have one.
 *
 * `checks_run` is 1 or 0 on the same rule the full report uses: how many checks
 * APPLIED, never how many were asked for.
 *
 * THE SECOND VERDICT IS NOT INCLUDED. `summary.bazaar_ready` is a verdict over
 * every bazaar-regime check, and this caller bought one check. Publishing it
 * here would hand over a whole-report answer at a single-check price and, worse,
 * would let one code's blockers list imply the rest of the report. The envelope
 * description — versions, payTo, network, price, and any `partial` caveat —
 * stays, because that is context for the answer rather than another answer.
 *
 * @param {object} response the same input shape lint() takes
 * @param {string} checkId  a check id from CHECKS. Unknown ids throw: the caller
 *                          validates first, so a stranger's typo is a 400 that
 *                          costs them nothing rather than an exception here.
 */
export function lintOne(response, checkId) {
  const def = CHECKS_BY_ID.get(checkId);
  if (!def) throw new Error(`unknown check id ${checkId} — validate against CHECKS_BY_ID first`);

  const { report, summary, findings } = runLint(response);
  const applied = report.ran.has(checkId);
  const hits = findings.filter((f) => f.code === checkId);

  // The envelope description WITHOUT the second verdict — see the note above.
  const context = {
    versions_detected: summary.versions_detected,
    payTo: summary.payTo,
    network: summary.network,
    price: summary.price,
    ...(summary.partial ? { partial: summary.partial } : {}),
  };

  return {
    check: checkId,
    applied,
    passed: applied ? hits.length === 0 : null,
    // ONE finding is the shape, because one check is what was bought. A code
    // can legitimately appear twice — several checks reach one code from
    // branches that diagnose different things — and when it does the rest are
    // published beside it rather than dropped, since each carries its own fix.
    finding: hits[0] ?? null,
    ...(hits.length > 1 ? { findings: hits } : {}),
    ...(applied ? {} : { note: notApplicable(def, summary) }),
    regime: def.regime,
    severity: def.severity,
    core: def.core === true,
    // The provenance ships with the answer, exactly as it does in GET /check. A
    // single-check verdict is a rule quoted at somebody, and a rule quoted with
    // no citation is one they have to take on faith.
    sources: def.sources,
    summary: context,
    checks_run: applied ? 1 : 0,
  };
}

/**
 * Why a named check did not run, said in the caller's terms.
 *
 * The engine knows the precondition failed but not, in general, which one — so
 * this reads the report's own summary for the answer that is nearly always the
 * real one (there was no envelope of that generation to inspect) and falls back
 * to naming the precondition rather than inventing a reason.
 */
function notApplicable(def, summary) {
  const versions = summary.versions_detected || [];
  const lead = `${def.id} did not apply to this response, so nothing about it was asserted — this is NOT a pass. `;

  if (summary.partial) return `${lead}${summary.partial}`;
  if (def.area === 'v2' && !versions.includes(2)) {
    return `${lead}No v2 envelope was found — there is no PAYMENT-REQUIRED response header to inspect, ` +
      'which is itself the finding V2_HEADER_PRESENT reports.';
  }
  if (def.area === 'v1' && !versions.includes(1)) {
    return `${lead}No v1 envelope was found — the 402 body carries no x402 v1 accepts[], which is ` +
      'itself the finding V1_BODY_PRESENT reports.';
  }
  if (def.area === 'dual' || def.area === 'version') {
    return `${lead}This check compares the two generations against each other and this response ` +
      `publishes ${versions.length ? `only v${versions.join(' and v')}` : 'neither'}.`;
  }
  return `${lead}Its precondition was not met: it inspects ${def.summary}`;
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
