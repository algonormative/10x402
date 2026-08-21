#!/usr/bin/env node
// Generates corpus/fixtures.json.
//
// EVERY FIXTURE'S SEMANTICS COME FROM SOMEWHERE THAT ALREADY EXISTED. The bulk
// are the broken-envelope fixtures in test/fixtures/envelopes.mjs, imported and
// invoked rather than retyped, so "the exported corpus is the same fixture the
// suite asserts on" is true by construction and cannot drift. Five calibration
// fixtures are documents this repository did not write — the v2 transport spec's
// own canonical 402, bazaar.md's worked example, the SVM exact scheme's own
// PaymentRequirements, the Cloudflare batch-settlement profile, and the frozen
// production capture in worker/positive-control.js. THREE are constructed here,
// for cases the thread named that the suite had no fixture for; each is the same
// one-thing-changed discipline and says so in `notes`.
//
// EXPECTATIONS ARE HAND-AUTHORED, NEVER READ BACK OUT OF THE ENGINE. That is
// the whole point: corpus/run-10x402.mjs then has to reproduce them, and a
// mismatch means the fixture is wrong or the engine is. Nothing in this file
// imports worker/lint.js.
//
// ─── DETERMINISM ──────────────────────────────────────────────────────────
//
// Running this file must produce the SAME BYTES it produced last time, or the
// "the fixtures were exported unchanged" claim is unfalsifiable. Two fields
// would otherwise move on their own — the generation date and the repository
// HEAD — so both are carried forward from the existing corpus/fixtures.json
// unless `--stamp` is passed. Everything else, including the content-addressed
// blob pins, is a pure function of the tree. `test/corpus.test.mjs` rebuilds the
// document in memory and compares it to the committed file byte for byte.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  FIXTURES,
  v1Envelope,
  v2Envelope,
  response,
  RESOURCE_URL,
} from '../test/fixtures/envelopes.mjs';
import { base64Encode } from '../worker/envelope.js';
import { POSITIVE_CONTROL } from '../worker/positive-control.js';
import { TAGS, REASON_TAGS, DIMENSIONS, CLIENT_INTEROP_LEVELS, judgeableFrom } from './vocabulary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT = join(here, 'fixtures.json');
const b64 = (value) => base64Encode(new TextEncoder().encode(JSON.stringify(value)));

// ------------------------------------------------------------------ pins

const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/**
 * THE FILES WHOSE BYTES CAN CHANGE AN ANSWER, pinned by CONTENT.
 *
 * A commit is the wrong handle for "what code ran": the repository HEAD moves,
 * and the HEAD a corpus was cut at is not in general the HEAD that carries the
 * adapter reading it — the previously published pin predated both the adapter
 * and the corpus, so checking it out did not reproduce the reported command.
 * Git blob hashes are content-addressed and stable, and `assertPinnedBlobs()` in
 * corpus/run-10x402.mjs recomputes and checks them BEFORE the engine runs.
 */
const PINNED_BLOBS = [
  'worker/lint.js',
  // IMPORTED BY lint.js AND THEREFORE ABLE TO CHANGE A VERDICT. It was missing
  // from this list, which made the claim "every file whose bytes can change an
  // answer" false: the bazaar schema-validation checks run through it, so an
  // edit here moves discovery verdicts while the pin block reported no change.
  'worker/json-schema.js',
  'worker/envelope.js',
  'worker/positive-control.js',
  'test/fixtures/envelopes.mjs',
  'corpus/vocabulary.mjs',
  'corpus/run-10x402.mjs',
  // The observed-client record and the lockfile that makes it reproducible.
  // Fixture evidence cites the record by name, so its bytes are part of what a
  // reader is being asked to check.
  'corpus/client-probe.json',
  'corpus/client-probe.lock.json',
];

const blobs = Object.fromEntries(PINNED_BLOBS.map((path) => [path, git(['hash-object', path])]));

/**
 * Every package a verdict in this corpus depends on, at a version, with the
 * registry integrity hash npm itself publishes.
 *
 * A `client-code` citation is meaningless without a version and weak without an
 * integrity hash: "@x402/core 2.23.0" names a version, `sha512-EFeV0…` names the
 * bytes. Anything an evidence ref or an adapter execution names is here —
 * including `x402-fetch`, which is a SEPARATE package from `x402` and was
 * previously covered by neither pin, and `@x402/extensions`, which the
 * x402-doctor adapter installs and which can change that tool's answers.
 */
const PACKAGES = {
  '@x402/core': {
    version: '2.23.0',
    integrity: 'sha512-EFeV0nXbTPPe5FXaD6y9vMgqc+k/ujLXCrUPrQXkmHjHyjC3Ir5tTL1e2FPSkx2+GUGzfpt1wVZb36639ygkWw==',
    note: 'the v2 client schemas and the HTTP decode path every v2 client-code citation resolves against',
  },
  '@x402/evm': {
    version: '2.23.0',
    integrity: 'sha512-Ikaya5c0/qV/pdFRGfGSdlUX3ELZaUgrddsmmXZHPANtIAQ5uFH15+O+9Bt4PqdAXqCuS43WskJ7HgiLn/uW2g==',
    note: 'the EVM signer. Every EXECUTE-level client_interop claim in this corpus cites this package, because it is where selection and signing happen',
  },
  '@x402/fetch': {
    version: '2.23.0',
    integrity: 'sha512-iyUfmnX6eAQa+GxyhC2M/vDP49EuoB/KHCXeOAFJgfL9lhtsyomLfYAMZlF+0xYHgpk/G96QZSp8iyhVlems/A==',
    note: 'the v2 fetch wrapper, cited for redirect-following behaviour',
  },
  '@x402/extensions': {
    version: '2.23.0',
    integrity: 'sha512-K0hDWGNrQ5iU8CdDzM8RpYrMusfqs2rgZJbCfUnFXG61TjgFIYYyLExaP8jJ4y2ac0SGXYZC1MI+uJA6YP3TTw==',
    note: 'NOT cited by any fixture — installed by corpus/run-x402-doctor.mjs as the prototype’s one third-party dependency, and therefore able to change that tool’s results',
  },
  x402: {
    version: '1.2.0',
    integrity: 'sha512-cqcB9LNw1e1Kv6wkKyyKvn7wcYBnJ9vd8336M9jZRgLKDcIDt2n3liiSXyzx4HJTv07f9M2OAk5uKhh/LcbKQQ==',
    note: 'the v1 client package, cited for the v1 PaymentRequirements schema and its closed network enum',
  },
  'x402-fetch': {
    version: '1.2.0',
    integrity: 'sha512-CxCgPO4H4/ADZC31gSUCS/CipkUyppzMJRU3jGrEuhO+2k0optszH+kwO0XJ6pVyDprIT6PvGbmNJ4TGKSCAcQ==',
    note: 'a SEPARATE package from `x402`, cited for v1 response handling. Pinned in its own right because the `x402` pin does not cover it',
  },
};

function buildPins(headCommit) {
  return {
    '10x402': {
      repo: 'https://github.com/chronick/10x402',
      commit: headCommit,
      commit_is:
        'INFORMATIONAL, AND ALWAYS BEHIND. Where the tree was when this corpus was last stamped. ' +
        'It cannot be the commit that carries this file, because writing this file is itself a ' +
        'change to be committed, and it falls further behind with every commit made after a stamp — ' +
        'so no fixed lag is claimed here, and an earlier version of this note claiming "one commit" ' +
        'was wrong by the time it was read. It is not, and cannot be, a handle on "what code ran". ' +
        'The AUTHORITY is `blobs` below: content-addressed, recomputed by assertPinnedBlobs() in ' +
        'corpus/run-10x402.mjs, and checked before the engine executes.',
      blobs,
      note: 'the engine under test — worker/lint.js, 82 checks (two of them live-only — see LIVE_ONLY_CHECKS in corpus/run-10x402.mjs; they cannot fire on a recorded fixture)',
    },
    packages: PACKAGES,
    'x402-foundation/x402': {
      repo: 'https://github.com/x402-foundation/x402',
      commit: '75b519d0a3a7fd609a00b6d5bf684a6a9131fe25',
      resolved: '2026-08-20',
      note: 'main at the time this corpus was cut; every `spec` ref is a path in this tree',
    },
    'x402-doctor-prototype': {
      repo: 'https://github.com/Maha-Strategies/maha-corp-web',
      commit: '37233104653b3ff6ea211169b0201026b12758ed',
      paths: ['scripts/x402-doctor.ts', 'lib/x402/doctor.ts', 'test/x402-doctor.test.ts'],
      license: 'NONE — the repository publishes no licence file and package.json declares none',
      dependency: '@x402/extensions@2.23.0 — see `packages`',
      note:
        'run from a temporary clone only. No file from this repository is vendored into 10x402, ' +
        'and no code from it is copied into the adapter: corpus/run-x402-doctor.mjs imports ' +
        'diagnoseX402Endpoint() from the clone at this commit and maps its output.',
    },
    // Kept as aliases so an existing consumer that read `pins['@x402/core']`
    // still resolves. The authoritative table is `packages`.
    '@x402/core': PACKAGES['@x402/core'],
    x402: PACKAGES.x402,
  };
}

// ------------------------------------------------------------------ evidence refs

const V2_TRANSPORT = 'specs/transports-v2/http.md § Payment Required Signaling';
const V1_TRANSPORT = 'specs/transports-v1/http.md § Payment Required Signaling';
const V2_ACCEPTS = 'specs/x402-specification-v2.md § 5.1.2 (PaymentRequirements table)';
const V2_RESOURCE = 'specs/x402-specification-v2.md § 5.1.2 (ResourceInfo table)';
const V1_ACCEPTS = 'specs/x402-specification-v1.md § 5.1.2 (PaymentRequirements table)';
const BAZAAR_SPEC = 'specs/extensions/bazaar.md';
const CORE_SCHEMAS = '@x402/core@2.23.0 dist/esm/chunk-N4QXZG2Z.mjs (PaymentRequirements/ResourceInfo zod schemas)';
// CORRECTED. The pre-publication review found both base64 fixtures locating
// `Base64EncodedRegex` in dist/cjs/schemas/index.js. The provenance pack puts the
// regex in the utility chunk and its USE in the HTTP/client chunk
// (audit/2026-08-19/fable-spec-truth.jsonl:8), which is what these now cite.
const CORE_B64_REGEX = '@x402/core@2.23.0 dist/esm/chunk-UQQR4X3S.mjs:95 — `var Base64EncodedRegex = /^[A-Za-z0-9+/]*={0,2}$/`';
const CORE_B64_USE = '@x402/core@2.23.0 dist/esm/chunk-BA2VL4DT.mjs:2199-2204 — decodePaymentRequiredHeader tests the regex against the RAW header value and throws BEFORE atob()';
const EVM_SIGNER = '@x402/evm@2.23.0 dist/esm/chunk-REWHAFTU.mjs';
const V1_SCHEMAS = 'x402@1.2.0 dist/esm/chunk-V3RMM5AE.mjs (PaymentRequirementsSchema)';
const V1_FETCH = 'x402-fetch@1.2.0 dist/esm/index.mjs:19-23';
const CDP_VALIDATOR = 'audit/2026-08-19/cdp-validator-toolshed.json';
/**
 * THE PINNED CLIENTS, OBSERVED RATHER THAN READ.
 *
 * corpus/probe-clients.mjs installs the pinned client packages from a committed
 * lockfile and runs every reachable decode and validate entry point over every
 * fixture, recording what each one did. It exists because a pre-publication
 * re-review found this corpus asserting that a schema accepts an envelope which
 * that schema in fact rejects — a claim nobody had run. Seven citations turned
 * out to be worded as "rejected at decode" when the real decode path accepts the
 * envelope and only the exported zod schema rejects it. Reading source is how
 * those sentences got written; running it is how they got fixed.
 */
const PROBE = 'corpus/client-probe.json (corpus/probe-clients.mjs, run against the committed corpus/client-probe.lock.json)';
const CDP_GET_DISCOVERED = 'https://docs.cdp.coinbase.com/x402/seller/get-discovered';

/**
 * EVIDENCE IS DIMENSION-SCOPED. Every citation names the dimension or dimensions
 * it supports, so a reader can mechanically ask "what supports the client_interop
 * verdict on this fixture?" and get an answer instead of a fixture-wide array to
 * read by eye. The schema requires the field and the builder guards it.
 */
const cite = (kind) => (ref, dimensions) => {
  if (!Array.isArray(dimensions) || dimensions.length === 0) {
    throw new Error(`evidence "${ref.slice(0, 40)}…" names no dimension`);
  }
  for (const dim of dimensions) if (!DIMENSIONS.includes(dim)) throw new Error(`evidence names unknown dimension ${dim}`);
  return { kind, ref, dimensions };
};

const spec = cite('spec');
const client = cite('client-code');
const validator = cite('cdp-validator');
const cdpDocs = cite('cdp-docs');
const fieldReport = cite('field-report');
const observed = cite('provider-observation');
const house = cite('house-opinion');

const P = ['payment'];
const C = ['client_interop'];
const D = ['discovery'];
const PC = ['payment', 'client_interop'];

/**
 * THE PROVIDER A DISCOVERY VERDICT IS ABOUT, structured rather than implied.
 *
 * `discovery` in this corpus is STATIC DECLARATION ELIGIBILITY: is the
 * registry-facing declaration present, does it validate against the schema
 * published beside it, and does it meet this provider's DOCUMENTED requirements
 * as documented? It is not, and cannot be, a claim that anything was indexed or
 * listed — see FORMAT.md § discovery.
 */
const cdpBazaar = (basis) => ({
  provider: 'CDP Bazaar',
  provider_evidence: CDP_VALIDATOR,
  observed: '2026-08-19',
  claim: 'static-declaration-eligibility',
  basis,
});

// ------------------------------------------------------------------ helpers

/** Pull one fixture out of the suite by its name, and run its builder. */
function fromSuite(name) {
  const found = FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(`no suite fixture named ${JSON.stringify(name)}`);
  return { built: found.response(), why: found.why, suite: name };
}

/**
 * `payment`, `client_interop`, `discovery`.
 *
 * A verdict is `[verdict, tags?]`; `client_interop` additionally carries the
 * strength of the claim — `parse` or `execute`. An `n/a` carries WHICH KIND of
 * n/a it is, because the format now has two and they mean different things: the
 * question does not arise for this response (`question-does-not-arise`), or the
 * recording cannot support any answer (`scope`), which is excluded from the
 * agreement statistics rather than counted as an agreement.
 */
const expect = (payment, client_interop, discovery) => ({
  payment: dim(payment),
  client_interop: { ...dim(client_interop), claim_level: client_interop[3] ?? 'parse' },
  discovery: dim(discovery),
});

/** `[verdict, reason_tags, na_kind, claim_level]` — the last two are optional. */
function dim([verdict, tags, na]) {
  const out = { verdict, reason_tags: verdict === 'fail' ? tags : [] };
  if (verdict === 'n/a') out.na_kind = na ?? 'question-does-not-arise';
  return out;
}

const PASS = ['pass'];
const PASS_PARSE = ['pass', [], undefined, 'parse'];
const NA = ['n/a'];
const NA_SCOPE = ['n/a', [], 'scope'];
const fail = (...tags) => ['fail', tags];
const failExec = (...tags) => ['fail', tags, undefined, 'execute'];

// ------------------------------------------------------------------ constructed responses

/** A v2 accepts entry with no maxTimeoutSeconds, on a chain whose scheme needs one. */
function v2TimeoutAbsent() {
  const v2 = v2Envelope();
  delete v2.accepts[0].maxTimeoutSeconds;
  return response({ v1: v1Envelope(), v2, url: RESOURCE_URL });
}

/** `asset: "USDC"` — the ticker where the contract address belongs. v2-only, so exactly one fault. */
function v2AssetSymbol() {
  const v2 = v2Envelope();
  v2.accepts[0].asset = 'USDC';
  return response({ v2, url: RESOURCE_URL });
}

/**
 * A dual-stack Solana seller.
 *
 * v1 spells the network `solana` (its closed enum); v2 spells the same chain in
 * CAIP-2. base58 payTo and an SPL mint on both sides, and no EIP-712 domain on
 * either — Solana's `exact` scheme signs no typed-data domain. Nothing here is
 * broken; the fixture exists because a linter that hardcodes EVM shapes grades
 * it F, which is the failure the audit found in our own engine.
 */
function solanaDualStack() {
  const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const PAYEE = '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4';
  const v1 = v1Envelope();
  v1.accepts[0].network = 'solana';
  v1.accepts[0].asset = MINT;
  v1.accepts[0].payTo = PAYEE;
  delete v1.accepts[0].extra;
  const v2 = v2Envelope();
  v2.accepts[0].network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  v2.accepts[0].asset = MINT;
  v2.accepts[0].payTo = PAYEE;
  v2.accepts[0].extra = {
    feePayer: 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd',
    memo: 'pi_3abc123def456',
    recentBlockhash: 'EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k',
    lastValidBlockHeight: '291470237',
  };
  return response({ v1, v2, url: RESOURCE_URL });
}

// ------------------------------------------------------------------ the calibration set

/**
 * CALIBRATION 1 — the v2 transport spec's own canonical 402, verbatim.
 *
 * MUST PASS payment and client_interop: a conformance checker that flags the
 * specification's own example is wrong, and wrong in the direction that costs a
 * stranger a day. It legitimately FAILS discovery, because it publishes no
 * extensions.bazaar — which is the clearest single demonstration of why the
 * three dimensions have to be separate. Collapsing them grades the spec's own
 * example a C, which is what an earlier version of 10x402 did.
 */
const SPEC_V2_ENVELOPE = {
  x402Version: 2,
  error: 'PAYMENT-SIGNATURE header is required',
  resource: {
    url: 'https://api.example.com/premium-data',
    description: 'Access to premium market data',
    mimeType: 'application/json',
  },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '10000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2' },
    },
  ],
};

/** CALIBRATION 2 — bazaar.md's own worked example, whose output.example is an OBJECT. */
const BAZAAR_SPEC_EXAMPLE = {
  info: {
    input: { type: 'http', method: 'GET', queryParams: { city: 'San Francisco' } },
    output: { type: 'json', example: { city: 'San Francisco', weather: 'foggy', temperature: 60 } },
  },
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      input: {
        type: 'object',
        properties: {
          type: { type: 'string', const: 'http' },
          method: { type: 'string', enum: ['GET', 'HEAD', 'DELETE'] },
          queryParams: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['type', 'method'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { type: { type: 'string' }, example: { type: 'object' } },
        required: ['type'],
      },
    },
    required: ['input'],
  },
};

function bazaarSpecExampleResponse() {
  const env = JSON.parse(JSON.stringify(SPEC_V2_ENVELOPE));
  env.resource = {
    url: 'https://api.example.com/weather',
    description: 'Weather data endpoint',
    mimeType: 'application/json',
    serviceName: 'Example Weather',
    tags: ['weather', 'forecast'],
    iconUrl: 'https://api.example.com/icon.png',
  };
  env.extensions = { bazaar: BAZAAR_SPEC_EXAMPLE };
  return {
    status: 402,
    headers: { 'content-type': 'application/json', 'payment-required': b64(env) },
    body: '{}',
    url: 'https://api.example.com/weather',
    method: 'GET',
  };
}

/** CALIBRATION 3 — the Cloudflare batch-settlement profile, verbatim from its scheme spec. */
function cloudflareBatchSettlement() {
  return {
    status: 402,
    headers: {
      'content-type': 'text/html',
      'payment-required': b64({
        x402Version: 2,
        error: 'No PAYMENT-SIGNATURE header provided',
        resource: { url: 'https://example.com/article', mimeType: 'text/html' },
        accepts: [
          {
            scheme: 'batch-settlement',
            network: 'cloudflare:402',
            amount: '1',
            asset: 'USD',
            payTo: 'merchant',
            extra: { version: '1.0.0' },
          },
        ],
        extensions: {
          'http-message-signatures': {
            info: {
              registrationUrl:
                'https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-ai-owner/verify-ai-crawler/',
              signatureSchemes: ['ed25519'],
              tags: ['web-bot-auth'],
            },
          },
        },
      }),
    },
    body: '',
    url: 'https://example.com/article',
    method: 'GET',
  };
}

/** CALIBRATION 4 — a spec-conformant Solana v2 envelope, verbatim from the SVM exact scheme. */
function solanaSpecEnvelope() {
  const env = JSON.parse(JSON.stringify(SPEC_V2_ENVELOPE));
  env.accepts = [
    {
      scheme: 'exact',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      amount: '1000',
      asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      payTo: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4',
      maxTimeoutSeconds: 60,
      extra: {
        feePayer: 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd',
        memo: 'pi_3abc123def456',
        recentBlockhash: 'EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k',
        lastValidBlockHeight: '291470237',
      },
    },
  ];
  return {
    status: 402,
    headers: { 'content-type': 'application/json', 'payment-required': b64(env) },
    body: '{}',
    url: SPEC_V2_ENVELOPE.resource.url,
    method: 'GET',
  };
}

// ------------------------------------------------------------------ the corpus

const ENTRIES = [
  // ═══ calibration ═══════════════════════════════════════════════════
  {
    id: 'calibration-spec-canonical-402',
    title: 'the v2 transport spec’s own canonical 402',
    calibration: 'must-pass',
    built: {
      status: 402,
      headers: { 'content-type': 'application/json', 'payment-required': b64(SPEC_V2_ENVELOPE) },
      body: '{}',
      url: SPEC_V2_ENVELOPE.resource.url,
      method: 'GET',
    },
    expected: expect(PASS, PASS_PARSE, fail('bazaar-extension-absent')),
    discovery_target: cdpBazaar('has_bazaar_extension is a REQUIRED preflight and this envelope publishes no extensions.bazaar'),
    evidence: [
      spec(`${V2_TRANSPORT} — the whole response, verbatim`, P),
      spec(V2_ACCEPTS, P),
      client(`${CORE_SCHEMAS} — every field of this envelope is accepted by the v2 zod schemas. PARSE-LEVEL: no execution of this offer is evidenced here`, C),
      validator(`${CDP_VALIDATOR} preflight has_bazaar_extension (severity: required) — the documented requirement this envelope does not meet`, D),
    ],
    notes:
      'THE CALIBRATION TARGET. Payment and client_interop must pass: a checker that flags the ' +
      'specification’s own example is wrong. Discovery legitimately fails — the example ' +
      'publishes no extensions.bazaar and is therefore not ELIGIBLE for the named provider’s ' +
      'index. One fixture, two different correct answers, which is the argument for keeping the ' +
      'dimensions apart.',
  },
  {
    id: 'calibration-live-positive-control',
    title: 'a real production dual-stack 402, captured off the wire',
    calibration: 'must-pass',
    built: {
      status: POSITIVE_CONTROL.status,
      headers: POSITIVE_CONTROL.headers,
      body: POSITIVE_CONTROL.body,
      url: POSITIVE_CONTROL.url,
      method: POSITIVE_CONTROL.method,
    },
    expected: expect(PASS, PASS_PARSE, PASS),
    discovery_target: cdpBazaar('every REQUIRED preflight check passed in the captured validator run'),
    evidence: [
      observed(`captured ${POSITIVE_CONTROL.captured} from ${POSITIVE_CONTROL.url} with one unauthenticated POST`, PC),
      spec(V2_TRANSPORT, P),
      spec(V1_TRANSPORT, P),
      // THE PROVIDER EVIDENCE, ATTACHED. The pre-publication review found this
      // fixture asserting a discovery pass while citing only the seller capture
      // and the specs, although the repository held the provider's own answer.
      validator(
        `${CDP_VALIDATOR} — "valid": true with every severity:required preflight passed (returns_402, ` +
          `payment_required_header, accepts[0].amount >= 1000, bazaar.info.input.method.matches_request, ` +
          `bazaar.schema, parse) and "simulation": {"outcome": "accepted"}`,
        D
      ),
      observed(`${CDP_VALIDATOR} — "index": {"active": true, "lastCrawledAt": "2026-08-19T16:27:35.129Z"}. RECORDED FOR COMPLETENESS AND NOT THE BASIS OF THE VERDICT: this corpus’s discovery dimension asserts static declaration eligibility, never that a record is live`, D),
      spec(BAZAAR_SPEC, D),
      client(`${CORE_SCHEMAS} — the captured envelope parses. PARSE-LEVEL: the accepted settlement simulation in the validator capture is a FACILITATOR accepting a payment, which is evidence for \`payment\`, not for a client executing one`, C),
    ],
    notes:
      'The other half of the calibration argument: constructed fixtures prove the checks fire, ' +
      'a captured reality proves they stay quiet. All three dimensions pass. Frozen — refreshing ' +
      'it would make the corpus depend on a third party staying healthy.',
  },
  {
    id: 'calibration-bazaar-spec-example',
    title: 'bazaar.md’s own worked example, with an OBJECT output.example',
    calibration: 'must-pass',
    built: bazaarSpecExampleResponse(),
    expected: expect(PASS, PASS_PARSE, PASS),
    discovery_target: cdpBazaar('info validates against the schema published beside it, and every REQUIRED preflight field is declared'),
    evidence: [
      spec(`${BAZAAR_SPEC} — the GET-endpoint example, info and schema verbatim`, D),
      spec(`${BAZAAR_SPEC} — output.example is typed \`any\`, so an OBJECT example is conformant`, D),
      spec(V2_ACCEPTS, P),
      client(`${CORE_SCHEMAS} — the accepts entry and ResourceInfo parse. PARSE-LEVEL only`, C),
      validator(`${CDP_VALIDATOR} preflight — output and output.example are graded ADVISORY, so an object example cannot withhold eligibility`, D),
    ],
    notes:
      'Covers the “missing output example” case from the other side: the example is an OBJECT, ' +
      'which bazaar.md admits. A checker demanding a non-empty STRING reports the spec’s own ' +
      'example as missing — 10x402 did, before the audit.',
  },
  {
    id: 'calibration-cloudflare-batch-settlement',
    title: 'the Cloudflare batch-settlement profile',
    calibration: 'must-not-fail-payment',
    built: cloudflareBatchSettlement(),
    expected: expect(PASS, PASS_PARSE, fail('network-unsupported-by-provider', 'bazaar-extension-absent')),
    discovery_target: cdpBazaar('accepts[0].network is a REQUIRED preflight expecting "a facilitator-supported network (Base, Solana, Polygon, Arbitrum, World)" and cloudflare:402 is not one, and has_bazaar_extension is REQUIRED and absent'),
    evidence: [
      spec('specs/schemes/batch-settlement/scheme_batch_settlement_cloudflare.md — the scheme’s own 402, verbatim', P),
      spec('…:110 — maxTimeoutSeconds is optional on this network', P),
      spec('…:48 — the network omits `schema` to stay under 2 KB', D),
      client(
        `${PROBE} — OBSERVED: \`decodePaymentRequiredHeader\` ACCEPTS this envelope, and so does ` +
          `\`x402HTTPClient#getPaymentRequiredResponse\`, which is the path a client actually takes. That is what ` +
          `the parse-level pass rests on. PARSE-LEVEL AND NO FURTHER: no pinned client in this corpus implements ` +
          `\`batch-settlement\`, so nothing evidences that a client can EXECUTE this offer, and the corpus does not claim it can`,
        C
      ),
      client(
        `${PROBE} — AND THE DIVERGENCE, RECORDED RATHER THAN HIDDEN: the exported \`PaymentRequiredV2Schema.safeParse\` ` +
          `REJECTS this same envelope, with exactly one issue — \`accepts.0.maxTimeoutSeconds\`, invalid_type, "Required". ` +
          `The decoder and the schema shipped in one package disagree about a 402 the batch-settlement scheme publishes ` +
          `as its own example, because the decode path runs no zod at all. An earlier version of this fixture cited the ` +
          `zod schemas as the basis for the PASS, which is the opposite of what they do`,
        C
      ),
      validator(`${CDP_VALIDATOR} preflight has_bazaar_extension (severity: required) — absent here`, D),
      validator(`${CDP_VALIDATOR} preflight accepts[0].network (severity: required), expected "a facilitator-supported network (Base, Solana, Polygon, Arbitrum, World)" — cloudflare:402 is not among them, so the declaration is ineligible at this provider whatever else it does`, D),
    ],
    notes:
      'A spec-defined scheme with `asset: "USD"`, `payTo: "merchant"` and no bazaar extension. ' +
      'Deliberately terse and deliberately not discoverable — nothing about it is broken, and a ' +
      'payment-dimension failure here would be a checker asserting EVM shapes as protocol law. ' +
      'The client_interop pass is a PARSE-level claim: the declaration is readable, and no ' +
      'executable client for this scheme is cited.',
  },
  {
    id: 'calibration-solana-spec-envelope',
    title: 'a spec-conformant Solana v2 envelope',
    calibration: 'must-pass',
    built: solanaSpecEnvelope(),
    expected: expect(PASS, PASS_PARSE, fail('bazaar-extension-absent')),
    discovery_target: cdpBazaar('has_bazaar_extension is a REQUIRED preflight and this envelope publishes no extensions.bazaar'),
    evidence: [
      spec('specs/schemes/exact/scheme_exact_svm.md — the exact scheme’s own SVM PaymentRequirements, verbatim', P),
      spec('…:61-67 — Solana’s `extra` is {feePayer, memo, recentBlockhash, lastValidBlockHeight}; there is no EIP-712 domain', P),
      client(`${CORE_SCHEMAS} — the CAIP-2 solana network id and base58 fields parse. PARSE-LEVEL: the SVM signer is not among this corpus’s pinned packages, so no execution claim is made`, C),
      validator(`${CDP_VALIDATOR} preflight has_bazaar_extension (severity: required)`, D),
    ],
    notes:
      'base58 payTo, an SPL mint as asset, and no typed-data domain. 10x402 graded this F before ' +
      'the audit because its address regex hardcoded a 20-byte EVM address for every network.',
  },

  // ═══ the reference shapes ══════════════════════════════════════════
  {
    id: 'perfect-dual-stack',
    ...fromSuite('perfect dual-stack 402'),
    expected: expect(PASS, PASS_PARSE, PASS),
    discovery_target: cdpBazaar('every REQUIRED preflight field is declared and info validates against its schema'),
    evidence: [
      spec(V2_TRANSPORT, P),
      spec(V1_TRANSPORT, P),
      spec(BAZAAR_SPEC, D),
      client(`${CORE_SCHEMAS} and ${V1_SCHEMAS} — both envelopes parse under their own generation’s schema. PARSE-LEVEL`, C),
      validator(`${CDP_VALIDATOR} preflight — the required set this envelope satisfies`, D),
    ],
  },
  {
    id: 'perfect-v2-only',
    ...fromSuite('perfect v2-only 402'),
    expected: expect(PASS, PASS_PARSE, PASS),
    discovery_target: cdpBazaar('every REQUIRED preflight field is declared and info validates against its schema'),
    evidence: [
      spec(V2_TRANSPORT, P),
      client(`${V1_FETCH} — a pre-header client reads the body and finds none, so it does not attempt payment. PARSE-LEVEL`, C),
      client(`${CORE_SCHEMAS} — the v2 envelope parses`, C),
      validator(`${CDP_VALIDATOR} preflight — the required set this envelope satisfies`, D),
    ],
  },
  {
    id: 'perfect-v1-only',
    ...fromSuite('perfect v1-only 402'),
    expected: expect(PASS, PASS_PARSE, NA),
    evidence: [
      spec(V1_TRANSPORT, P),
      client(`${CORE_SCHEMAS} — @x402/core falls back to a v1 body when there is no header, so the declaration is readable. PARSE-LEVEL`, C),
      validator(`${CDP_VALIDATOR} preflight payment_required_header (severity: required) — a v2-shaped requirement this v1-only seller has no declaration to answer`, D),
    ],
    notes:
      'DISCOVERY IS n/a, NOT fail. CDP’s requirements are a v2 shape; answering `fail` would read ' +
      'as a list of things wrong with a v2 envelope this seller never published. The n/a kind is ' +
      '`question-does-not-arise`, not `scope`: the corpus HAS the whole response, and the question ' +
      'is what does not apply.',
  },
  {
    id: 'dual-offers-reordered',
    ...fromSuite('the same two offers, listed in a different order in each envelope'),
    expected: expect(PASS, PASS_PARSE, PASS),
    discovery_target: cdpBazaar('every REQUIRED preflight field is declared; ordering is not a preflight subject'),
    evidence: [
      house('neither specification orders accepts[]; offers are matched on (chain, asset) before anything is compared. NOT NORMATIVE — recorded so the reader knows the pairing rule is ours', PC),
      spec(V2_ACCEPTS, P),
      client(`${CORE_SCHEMAS} — both envelopes parse whatever the order. PARSE-LEVEL`, C),
      validator(`${CDP_VALIDATOR} preflight — the required set this envelope satisfies`, D),
    ],
  },

  // ═══ encoding ══════════════════════════════════════════════════════
  {
    id: 'v2-header-b64-urlsafe',
    ...fromSuite('v2 header in url-safe base64'),
    expected: expect(PASS, fail('b64-urlsafe'), NA),
    evidence: [
      client(`${CORE_B64_REGEX}`, C),
      client(`${CORE_B64_USE}`, C),
      client(`${PROBE} — OBSERVED: \`decodePaymentRequiredHeader\` THROWS "Invalid payment required header" on this header value, and \`Base64EncodedRegex.test\` returns false. Note the envelope underneath is well formed — recovered leniently it passes \`PaymentRequiredV2Schema\` — so the fault is purely transport-layer, which is the whole of the client-interoperability claim`, C),
      spec(`${V2_TRANSPORT} — "Base64-encoded", and SILENT on the alphabet. CONTEXT, NOT AUTHORITY: this citation is why the corpus does NOT fail the payment dimension here`, P),
      fieldReport('x402-foundation/x402#3104 — reported as a case the doctor prototype did not yet cover', C),
    ],
    notes:
      'PAYMENT PASSES AND CLIENT INTEROPERABILITY FAILS, and the split is the point. The transport ' +
      'specification says the header carries Base64-encoded JSON and does not say which alphabet; ' +
      'the corpus’s own 2026-08-19 provenance audit records that in as many words. So base64url is ' +
      'not a violation of the normative specification — it is a declaration the pinned client ' +
      'refuses to decode, which is exactly what `client_interop` is for. An earlier version of this ' +
      'corpus failed both dimensions on the strength of a spec citation that does not say what it ' +
      'was being made to say.',
  },
  {
    id: 'v2-header-b64-whitespace',
    ...fromSuite('a v2 header padded with whitespace'),
    population: 'raw-input',
    expected: expect(PASS, fail('b64-urlsafe'), NA),
    evidence: [
      client(`${CORE_B64_REGEX} — a leading or trailing space fails the regex before any decode`, C),
      client(`${CORE_B64_USE}`, C),
      client(`${PROBE} — OBSERVED: \`decodePaymentRequiredHeader\` THROWS "Invalid payment required header" on the padded value. The probe never makes an HTTP round trip, which is exactly why it can see a fault a live doctor structurally cannot`, C),
      house('`response.headers` in this corpus are PARSED FIELD VALUES, so a padded value is one that reached the client by a path with no HTTP parser in it — a stored declaration replayed by a facilitator, an SDK reading a cache, a pasted capture. The fixture is scoped to that population and makes no claim about an HTTP-delivered one', C),
      spec(`${V2_TRANSPORT} — "Base64-encoded", and SILENT on padding as on the alphabet. The declared terms are conformant and settleable, which is why the payment dimension PASSES and the fault is confined to the client that refuses to decode it`, P),
      spec(`${V1_ACCEPTS} — and the v1 body in this dual-stack response is intact and independently payable`, P),
    ],
    notes:
      'A RAW-INPUT/PASTED-POPULATION FIXTURE, and labelled `population: "raw-input"` so it cannot be ' +
      'read as anything else. Because the corpus defines `response.headers` as PARSED field values ' +
      '(FORMAT.md § response.headers), an HTTP parser would already have removed this padding: any ' +
      'live probe sees a clean header. The fault survives only where a value reaches a client ' +
      'without a transport in between. It therefore makes NO payment claim at all — an earlier ' +
      'version of this corpus failed the payment dimension on it, which was a client-specific ' +
      'raw-input opinion sitting in a normative dimension. ' +
      'Discovery is n/a for the same reason as the other base64 fixture: the cited client cannot ' +
      'decode the envelope, so there is no read declaration whose registry metadata could be judged.',
  },
  {
    id: 'no-envelope-html-body',
    ...fromSuite('a 402 with an unparseable body and no header'),
    expected: expect(fail('envelope-absent', 'envelope-not-json'), fail('envelope-absent', 'envelope-not-json'), NA),
    evidence: [
      spec(`${V2_TRANSPORT} — a 402 declares its terms; this one declares none`, P),
      spec(V1_TRANSPORT, P),
      client(`${V1_FETCH} — the v1 client parses the body and gets a SyntaxError; there is no header for the v2 path. PARSE-LEVEL`, C),
    ],
    notes:
      'THE CHALLENGE IS RECORDED AND IT IS EMPTY, which is why this is a failure rather than an ' +
      '`n/a`. Compare free-tier-200 and redirect-instead-of-402, where there is no challenge in the ' +
      'recording at all.',
  },

  // ═══ version boundary ══════════════════════════════════════════════
  {
    id: 'v2-network-bare-name',
    ...fromSuite('v2 envelope naming the network "base"'),
    expected: expect(fail('network-form'), fail('network-form'), fail('network-unsupported-by-provider')),
    discovery_target: cdpBazaar('accepts[0].network is a REQUIRED preflight expecting a facilitator-supported network in CAIP-2, and "base" is not a string it can match'),
    evidence: [
      spec(V2_ACCEPTS, P),
      client(`${CORE_SCHEMAS} — NetworkSchemaV2 requires a colon`, C),
      client(`${PROBE} — OBSERVED, AND NOT WHERE THIS FIXTURE USED TO SAY: \`decodePaymentRequiredHeader\` ACCEPTS this envelope; it is the exported \`PaymentRequiredV2Schema.safeParse\` that rejects it, with \`accepts.0.network\`, custom, "Network must be in CAIP-2 format (e.g., 'eip155:84532')". So the failure belongs to a consumer that VALIDATES, not to one that decodes — a decoding client carries the bad network onward. PARSE-LEVEL`, C),
      validator(`${CDP_VALIDATOR} preflight accepts[0].network (severity: required), captured with "eip155:8453" as the actual value — the v1 spelling "base" is not a member of the set this check matches against, so the listing is refused as well as the payment`, D),
    ],
    notes:
      'ONE SPELLING MISTAKE, TWO REGIMES. The bazaar extension on this envelope is complete and ' +
      'schema-valid, and an earlier version of this corpus passed discovery on that basis alone — ' +
      'reading "the extension is fine" as "the declaration is eligible", when the provider’s ' +
      'required preflight set covers the payment terms too.',
  },
  {
    id: 'v1-network-caip2',
    ...fromSuite('v1 envelope naming the network in CAIP-2'),
    expected: expect(fail('network-form'), fail('network-form'), PASS),
    discovery_target: cdpBazaar('the v2 half carries a complete, schema-valid bazaar declaration; the v1 body is not a preflight subject'),
    evidence: [
      spec(V1_ACCEPTS, P),
      client(`${V1_SCHEMAS} — the v1 network field is a closed enum of bare names, so the entry throws invalid_enum_value at parse. PARSE-LEVEL`, C),
      validator(`${CDP_VALIDATOR} preflight — the required set the v2 half satisfies`, D),
    ],
  },
  {
    id: 'v2-amount-uses-v1-field-name',
    ...fromSuite('v2 envelope carrying maxAmountRequired instead of amount'),
    expected: expect(fail('missing-required-field'), fail('missing-required-field'), fail('missing-required-field')),
    discovery_target: cdpBazaar('accepts[0].amount is a REQUIRED preflight with the expectation ">= 1000", and a v2 entry carrying the v1 field name presents that comparison with nothing to read'),
    evidence: [
      spec(`${V2_ACCEPTS} — v2 renamed maxAmountRequired to amount, and amount is required`, P),
      client(`${CORE_SCHEMAS} — \`amount\` is absent, so the entry fails the schema`, C),
      client(`${PROBE} — OBSERVED: \`decodePaymentRequiredHeader\` ACCEPTS it and \`PaymentRequiredV2Schema.safeParse\` REJECTS it with \`accepts.0.amount\`, invalid_type, "Required". A decoding client reads \`undefined\` as the price and has nothing to sign over. PARSE-LEVEL`, C),
      validator(`${CDP_VALIDATOR} preflight accepts[0].amount (severity: required), expected ">= 1000" — the check compares a VALUE, and there is none at the name it reads`, D),
    ],
    notes: 'The corpus tags the FATAL reason (`amount` is absent). The v1 field left behind is reported by 10x402 as a non-fatal crosstalk warning.',
  },
  {
    id: 'v2-resource-flat-string',
    ...fromSuite('v2 envelope with a flat-string resource'),
    expected: expect(fail('resource-shape'), fail('resource-shape'), NA),
    evidence: [
      spec(V2_RESOURCE, P),
      client(`${CORE_SCHEMAS} — ResourceInfoSchema is an object; a string fails it`, C),
      client(`${PROBE} — OBSERVED: \`decodePaymentRequiredHeader\` ACCEPTS it; \`PaymentRequiredV2Schema.safeParse\` REJECTS it with \`resource\`, invalid_type, "Expected object, received string". PARSE-LEVEL`, C),
      validator(`${CDP_VALIDATOR} — every preflight in the required set reads the ResourceInfo OBJECT, so with a string in its place not one of them can run`, D),
    ],
    notes:
      'DISCOVERY IS n/a, AND THAT ANSWER IS THE ONE 10x402 GOT WRONG. The registry checks all ' +
      'read the ResourceInfo object; with the v1 flat string in its place not one of them can ' +
      'run, so there is no blocker — and the engine reported the absence of a blocker as ' +
      '"indexable: true" to a seller whose envelope no indexer can read. Fixed while building ' +
      'this corpus; see DISAGREEMENTS.md § Where 10x402 was wrong.',
  },
  {
    id: 'v2-envelope-echoed-into-body',
    ...fromSuite('the v2 envelope echoed into the 402 body'),
    expected: expect(PASS, PASS_PARSE, PASS),
    discovery_target: cdpBazaar('the header declaration is complete and schema-valid; what the body echoes is not a preflight subject'),
    evidence: [
      spec('specs/transports-v2/http.md § Response Body — "Response bodies are a server implementation concern"', P),
      client(`${V1_FETCH} — a pre-header client parses the body with v1 rules and finds a v2 payload it does not recognise as a v1 envelope. PARSE-LEVEL`, C),
      validator(`${CDP_VALIDATOR} preflight — the required set the header satisfies`, D),
    ],
    notes:
      'NOT A FAILURE ON ANY DIMENSION. A body that declares itself v2 is not a broken v1 ' +
      'envelope. 10x402 used to run the whole v1 core cascade over it and report five core ' +
      'errors about an object that never claimed to be v1.',
  },

  // ═══ payment terms ═════════════════════════════════════════════════
  {
    id: 'v2-timeout-string',
    ...fromSuite('maxTimeoutSeconds as the string "60"'),
    expected: expect(fail('timeout-form'), failExec('timeout-form'), PASS),
    discovery_target: cdpBazaar('accepts[0].maxTimeoutSeconds is SET, which is what the preflight requires; its JSON type is not a preflight subject'),
    evidence: [
      spec(V2_ACCEPTS, P),
      client(`${CORE_SCHEMAS} — \`maxTimeoutSeconds: z.number().positive()\`, no coercion, so "60" fails the schema`, C),
      client(`${PROBE} — OBSERVED: \`PaymentRequiredV2Schema.safeParse\` rejects with \`accepts.0.maxTimeoutSeconds\`, invalid_type, "Expected number, received string", while \`decodePaymentRequiredHeader\` accepts it — which is precisely why the EXECUTE-level citation below is the one that matters here`, C),
      client(`${EVM_SIGNER}:34 — EXECUTE-LEVEL: \`validBefore: (now + paymentRequirements.maxTimeoutSeconds).toString()\` concatenates rather than adds when the value is a string, and the signer produces a nonsense deadline`, C),
      validator(`${CDP_VALIDATOR} preflight accepts[0].maxTimeoutSeconds (severity: required) — satisfied, the field IS set`, D),
    ],
  },
  {
    id: 'v2-timeout-absent',
    title: 'a v2 accepts entry with no maxTimeoutSeconds, on an EVM chain',
    built: v2TimeoutAbsent(),
    constructed: true,
    expected: expect(fail('timeout-form'), failExec('timeout-form'), fail('timeout-form')),
    discovery_target: cdpBazaar('accepts[0].maxTimeoutSeconds is a REQUIRED preflight — "maxTimeoutSeconds is set" — and this fixture deliberately omits the field'),
    evidence: [
      spec(`${V2_ACCEPTS} — maxTimeoutSeconds is required for the exact scheme on EVM`, P),
      client(`${CORE_SCHEMAS} — the field is required by the zod schema`, C),
      client(`${PROBE} — OBSERVED: \`PaymentRequiredV2Schema.safeParse\` rejects with \`accepts.0.maxTimeoutSeconds\`, invalid_type, "Required", while \`decodePaymentRequiredHeader\` accepts it; the break a buyer actually hits is the signer, cited next`, C),
      client(`${EVM_SIGNER}:34 — EXECUTE-LEVEL: \`now + undefined\` yields "NaN", and BigInt("NaN") throws inside signEIP3009Authorization, so no payment is created`, C),
      spec('specs/schemes/batch-settlement/scheme_batch_settlement_cloudflare.md:110 — and is OPTIONAL on cloudflare:402, which is why this fixture is on eip155', P),
      validator(`${CDP_VALIDATOR} preflight accepts[0].maxTimeoutSeconds (severity: required) — "maxTimeoutSeconds is set". PRESENCE is the whole of the provider’s stated rule, which is why v2-timeout-string (the field set to a string) keeps its discovery pass while this fixture cannot`, D),
    ],
    notes:
      'DISCOVERY FAILS TOO, AND AN EARLIER VERSION OF THIS CORPUS SAID IT PASSED — against a ' +
      'provider target whose own cited capture marks the omitted field required. A verdict may ' +
      'not contradict the evidence it cites. ' +
      'The pair to calibration-cloudflare-batch-settlement: the ' +
      'same absent field is a defect on one network and legal on another, so a checker that ' +
      'hardcodes "maxTimeoutSeconds is required" fails a spec-defined profile.',
  },
  {
    id: 'v2-asset-ticker-not-address',
    title: 'asset given as the ticker "USDC" instead of the contract address',
    built: v2AssetSymbol(),
    constructed: true,
    expected: expect(fail('asset-form'), failExec('asset-form'), fail('asset-form')),
    discovery_target: cdpBazaar('accepts[0].asset is a REQUIRED preflight — captured as "Asset is USDC" against a token contract address — and on an eip155 network a ticker is not a token the provider can resolve'),
    evidence: [
      spec(`${V2_ACCEPTS} — asset is the on-chain identifier: "Token contract address or ISO 4217 currency code"`, P),
      // CORRECTED. The review found this fixture claiming the generic core
      // schema requires an address. It does not: the pinned core schema is
      // `asset: NonEmptyString` (audit/2026-08-19/fable-spec-truth.jsonl:19).
      // Address validation happens in the EVM signer, and that is what is cited.
      client(`${CORE_SCHEMAS} — \`asset: NonEmptyString\`. THE GENERIC SCHEMA DOES NOT REQUIRE AN ADDRESS, and an earlier version of this fixture said it did; ISO 4217 codes are spec-legal, which is why it cannot`, C),
      client(`${EVM_SIGNER} — EXECUTE-LEVEL AND THE ACTUAL AUTHORITY: on an eip155 network the signer computes \`verifyingContract: getAddress(requirements.asset)\`, and getAddress throws on "USDC", so the payment is never signed`, C),
      client(`${PROBE} — AND THE LIMIT OF WHAT WAS OBSERVED, stated rather than left to be assumed: this envelope PARSES cleanly at all eleven reachable entry points. The signer is \`not-exercisable-offline\` — reaching it needs a private key and a chain — so the execute-level claim above rests on reading @x402/evm at the pinned version, not on running it`, C),
      validator(`${CDP_VALIDATOR} preflight accepts[0].asset (severity: required), captured with "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as the actual value and the detail "Asset is USDC" — the provider resolves the token to decide what it is listing, and "USDC" on eip155:8453 is not a token identifier it can resolve`, D),
    ],
    notes:
      'ONE FAULT, THREE DIMENSIONS. An earlier version of this corpus passed discovery here on the ' +
      'reasoning that asset form "is not a preflight subject" — which its own cited capture ' +
      'contradicts, since accepts[0].asset is in the required set. v2-only so it still carries ' +
      'exactly one fault; a fault can legitimately cost a seller three different things.',
  },
  {
    id: 'extra-eip712-absent',
    ...fromSuite('no EIP-712 domain in `extra`'),
    expected: expect(fail('missing-eip712-extra'), failExec('missing-eip712-extra'), PASS),
    discovery_target: cdpBazaar('the bazaar declaration is complete and schema-valid; accepts[].extra is not a preflight subject'),
    evidence: [
      spec('specs/schemes/exact/scheme_exact_evm.md — extra.name and extra.version are required for the default eip3009 assetTransferMethod', P),
      client(`${EVM_SIGNER}:49-53 — EXECUTE-LEVEL: \`if (!requirements.extra?.name || !requirements.extra?.version) throw\` at payment CREATION, with no fallback`, C),
      client(`${PROBE} — AND THE LIMIT OF WHAT WAS OBSERVED: this envelope PARSES cleanly at every reachable entry point, which is the point of the fixture — nothing in the decode or validate layer objects. The signer is \`not-exercisable-offline\` without a key and a chain, so the execute-level claim rests on reading @x402/evm at the pinned version rather than on running it`, C),
      validator(`${CDP_VALIDATOR} preflight — the required set the bazaar half satisfies`, D),
    ],
  },
  {
    id: 'v2-payto-array',
    ...fromSuite('payTo as an array holding a valid address'),
    expected: expect(fail('payee-form'), failExec('payee-form'), fail('payee-form')),
    discovery_target: cdpBazaar('accepts[0].payTo is a REQUIRED preflight captured as "payTo address present" against a literal string address, and a one-element ARRAY is not an address'),
    evidence: [
      spec(V2_ACCEPTS, P),
      client(`${CORE_SCHEMAS} — the zod schema rejects a non-string payTo`, C),
      client(`${PROBE} — OBSERVED: \`PaymentRequiredV2Schema.safeParse\` rejects with \`accepts.0.payTo\`, invalid_type, "Expected string, received array"; \`decodePaymentRequiredHeader\` accepts it, so a decoding client carries the array as far as the signer`, C),
      client(`${EVM_SIGNER} — EXECUTE-LEVEL: viem’s getAddress rejects a non-string outright, so the transfer authorisation cannot be built`, C),
      validator(`${CDP_VALIDATOR} preflight accepts[0].payTo (severity: required) — "payTo address present", captured with a string address as the actual value. An earlier version of this corpus read that as a PRESENCE rule satisfied by an array; the captured detail says address, and the wrapped value is exactly the type-coercion trap this fixture exists to demonstrate`, D),
    ],
    notes:
      'THE REASON SET IS `payee-form` AND NOTHING ELSE. An earlier version of this corpus added ' +
      '`dual-divergence` here as well, on the strength of a dual-stack consistency rule that no ' +
      'specification states — a house position sitting inside a normative dimension. The ' +
      'divergence is real and it is recorded, as an OBSERVATION in the results file, where an ' +
      'unsourced rule belongs.',
  },
  {
    id: 'dual-payto-divergence',
    ...fromSuite('dual-stack payTo divergence'),
    expected: expect(PASS, PASS_PARSE, PASS),
    discovery_target: cdpBazaar('the v2 half carries a complete, schema-valid bazaar declaration'),
    evidence: [
      house(
        'NOT A PROTOCOL REQUIREMENT, AND THEREFORE NOT A VERDICT. Neither specification says a ' +
          'dual-stack seller’s two envelopes must name the same payee; both halves are individually ' +
          'valid and individually settleable, so the payment dimension PASSES. 10x402 does hold a ' +
          'house position that the divergence is a defect — the money lands in two places — and that ' +
          'position is recorded in the results file as an observed tag, which is where an unsourced ' +
          'rule belongs. An earlier version of this corpus made it `expected.payment: fail`, which ' +
          'is the exact failure mode the thread named.',
        P
      ),
      spec(`${V2_ACCEPTS} — each envelope is independently well-formed`, P),
      client(`${V1_FETCH} — a v1 client reads the body; a v2 client reads the header; each parses its own half and neither sees the other. PARSE-LEVEL`, C),
      client(
        `${PROBE} — OBSERVED ON BOTH SIDES, which is what this fixture previously claimed while citing only the v1 ` +
          `path: the v2 header is accepted by \`decodePaymentRequiredHeader\`, by \`x402HTTPClient\` (which returns ` +
          `x402Version 2 — the header wins over the body) and by \`PaymentRequiredV2Schema\`; the v1 body is accepted by ` +
          `\`x402ResponseSchema\` and \`selectPaymentRequirements\`, which picks the exact/base offer. Two generations, ` +
          `two payees, and neither client can see the other's half`,
        C
      ),
      validator(`${CDP_VALIDATOR} preflight — the required set the v2 half satisfies`, D),
    ],
    notes:
      'THE FIXTURE THE PRE-PUBLICATION REVIEW CALLED AN INCORRECT FAIL, and it was right. All ' +
      'three dimensions pass; the house objection survives as an observation in ' +
      'corpus/results-10x402.json and as a row in DISAGREEMENTS.md, and decides nothing.',
  },
  {
    id: 'dual-network-unmapped-chain',
    ...fromSuite('dual-stack on a chain outside the linter’s table'),
    expected: expect(PASS, fail('network-unknown'), PASS),
    discovery_target: cdpBazaar('the v2 half carries a complete, schema-valid bazaar declaration'),
    evidence: [
      client(`${V1_SCHEMAS} — "arbitrum" is not a member of the v1 closed enum, so x402-fetch throws invalid_enum_value on this entry at parse. PARSE-LEVEL`, C),
      spec(`${V1_ACCEPTS} — nothing in either specification closes that enum, which is why the payment dimension passes`, P),
      house('the v1↔v2 chain equivalence table covers the nine chains x402 clients ship with; outside it the pair is unverified, not divergent. NOT NORMATIVE', PC),
      validator(`${CDP_VALIDATOR} preflight — the required set the v2 half satisfies`, D),
    ],
    notes:
      'A CLIENT-INTEROP FAILURE THAT IS NOT A PAYMENT FAILURE, and one of the clearest cases for ' +
      'the split: the v2 half is correct, the chain simply has no v1 spelling in the cited ' +
      'client’s enum. Nothing in either specification closes that enum.',
  },

  // ═══ transport-level ═══════════════════════════════════════════════
  {
    id: 'free-tier-200',
    ...fromSuite('free tier: 200 to an unauthenticated caller'),
    expected: expect(NA_SCOPE, NA_SCOPE, NA),
    evidence: [
      house(
        'NO CHALLENGE WAS RECORDED, so neither `pass` nor `fail` is available. A 200 to an ' +
          'anonymous caller declares no payment: there is nothing to interpret, nothing to settle, ' +
          'and nothing for a client to parse or execute. A recorded corpus cannot demonstrate ' +
          'payability it never recorded, and it must not manufacture a failure out of an absence ' +
          'either. See FORMAT.md § The recorded-challenge precondition',
        PC
      ),
      client(`${V1_FETCH} — \`if (response.status !== 402) return response\`; the client never enters the payment flow, which is why there is no client verdict to reach`, C),
      validator(`${CDP_VALIDATOR} preflight returns_402 (severity: required) — a documented provider requirement this response does not meet`, D),
      cdpDocs(`${CDP_GET_DISCOVERED} — endpoints are health-probed on an interval and a non-402 is grounds for delisting`, D),
    ],
    notes:
      'PAYMENT AND CLIENT INTEROPERABILITY ARE `n/a`, KIND `scope`, AND EXCLUDED FROM THE ' +
      'AGREEMENT STATISTICS. An earlier version of this corpus passed both, which reproduced ' +
      '10x402’s warning severity as fixture truth. Discovery is `n/a` too, and for a different ' +
      'reason: under the corpus’s static-declaration reading there is no v2 declaration in this ' +
      'response to judge for eligibility at all. What the two tools WOULD have said is preserved ' +
      'in the results files as scope-suppressed observations and reported in DISAGREEMENTS.md — ' +
      'it is the sharpest difference in the corpus and it is not thrown away, it is just not ' +
      'allowed to become a verdict the recording cannot support.',
  },
  {
    id: 'redirect-instead-of-402',
    ...fromSuite('a redirect instead of a 402'),
    expected: expect(NA_SCOPE, NA_SCOPE, NA),
    evidence: [
      house(
        'THE TARGET RESPONSE IS NOT IN THE RECORDING. The fixture is a 307 and a Location header; ' +
          'whatever the target answers was never captured, so "the envelope is reachable" is an ' +
          'assumption and not an observation. Payment and client interoperability are therefore ' +
          '`n/a`. See FORMAT.md § The recorded-challenge precondition',
        PC
      ),
      client('@x402/fetch@2.23.0 dist/esm/index.mjs:10 — `await fetch(request)`, the default redirect mode, so a live client WOULD follow the redirect. That is why the corpus does not fail this fixture; it is not why it could pass one', C),
      validator(`${CDP_VALIDATOR} preflight returns_402 (severity: required) — the provider probes the ADVERTISED url, and this one does not answer 402`, D),
    ],
    notes:
      'An earlier version of this corpus passed payment and client interoperability here, citing ' +
      'default-follow behaviour. Default-follow says a client would go and look; it does not say ' +
      'what it would find, and the corpus does not hold the answer. Adding the target response as ' +
      'a second recorded exchange would make this fixture judgeable, and that is the right way to ' +
      'fix it — not a verdict inferred from a Location header.',
  },

  // ═══ discovery ═════════════════════════════════════════════════════
  {
    id: 'bazaar-extension-absent',
    ...fromSuite('v2 envelope with no extensions.bazaar'),
    expected: expect(PASS, PASS_PARSE, fail('bazaar-extension-absent')),
    discovery_target: cdpBazaar('has_bazaar_extension is a REQUIRED preflight and this envelope publishes no extensions.bazaar'),
    evidence: [
      validator(`${CDP_VALIDATOR} preflight has_bazaar_extension (severity: required) — the documented requirement this envelope does not meet`, D),
      spec(BAZAAR_SPEC, D),
      spec(V2_ACCEPTS, P),
      client(`${CORE_SCHEMAS} — the payment half parses and is unaffected. PARSE-LEVEL`, C),
      fieldReport('x402-foundation/x402#2207, #2284', D),
    ],
    notes: 'Payable and undiscoverable. Every payment on this endpoint works; the listing never appears and nothing says why.',
  },
  {
    id: 'bazaar-info-schema-mismatch',
    ...fromSuite('bazaar info that does not validate against its own schema'),
    expected: expect(PASS, PASS_PARSE, fail('bazaar-info-schema-mismatch')),
    discovery_target: cdpBazaar('bazaar.schema and the parse preflight are REQUIRED, and info does not validate against the schema published beside it'),
    evidence: [
      spec(`${BAZAAR_SPEC} § Schema Validation — "Facilitators must validate info against schema before cataloging"`, D),
      validator(`${CDP_VALIDATOR} preflight parse (severity: required)`, D),
      spec(V2_ACCEPTS, P),
      client(`${CORE_SCHEMAS} — the payment half parses and is unaffected. PARSE-LEVEL`, C),
      fieldReport('x402-foundation/x402#3045', D),
    ],
  },
  {
    id: 'bazaar-schema-external-ref',
    ...fromSuite('a bazaar schema behind an external $ref'),
    expected: expect(PASS, PASS_PARSE, fail('bazaar-schema-unresolvable', 'bazaar-info-schema-mismatch')),
    discovery_target: cdpBazaar('the schema cannot be resolved without an external fetch the specification forbids, so info cannot be validated and the REQUIRED parse preflight cannot pass'),
    evidence: [
      spec(`${BAZAAR_SPEC} — $ref and $id must be same-document fragments; a facilitator MUST NOT resolve an external one`, D),
      validator(`${CDP_VALIDATOR} preflight parse (severity: required)`, D),
      spec(V2_ACCEPTS, P),
      client(`${CORE_SCHEMAS} — the payment half parses and is unaffected. PARSE-LEVEL`, C),
      fieldReport('x402-foundation/x402#3045, fifth production bug', D),
    ],
  },
  {
    id: 'bazaar-input-no-type',
    ...fromSuite('a bazaar input with no `type` discriminator'),
    expected: expect(PASS, PASS_PARSE, fail('bazaar-input-shape', 'bazaar-info-schema-mismatch')),
    discovery_target: cdpBazaar('bazaar.info.input.type is a REQUIRED preflight and the declared input carries no discriminator'),
    evidence: [
      spec(`${BAZAAR_SPEC} — \`type\` is the discriminator that selects which input shape applies`, D),
      validator(`${CDP_VALIDATOR} preflight bazaar.info.input.type (severity: required)`, D),
      spec(V2_ACCEPTS, P),
      client(`${CORE_SCHEMAS} — the payment half parses and is unaffected. PARSE-LEVEL`, C),
      fieldReport('x402-foundation/x402#3045, fourth production bug', D),
    ],
  },
  {
    id: 'bazaar-input-method-mismatch',
    ...fromSuite('a bazaar input.method that is not the verb we probed'),
    expected: expect(PASS, PASS_PARSE, fail('bazaar-input-method')),
    discovery_target: cdpBazaar('bazaar.info.input.method.matches_request is a REQUIRED preflight, compared against the verb in `context.method`'),
    evidence: [
      validator(`${CDP_VALIDATOR} preflight bazaar.info.input.method.matches_request (severity: required) — "Declared method POST matches the probed method"`, D),
      spec(BAZAAR_SPEC, D),
      spec(V2_ACCEPTS, P),
      client(`${CORE_SCHEMAS} — the payment half parses and is unaffected. PARSE-LEVEL`, C),
    ],
    notes:
      'The closest fixture to the doctor prototype’s founding check (replay the declared crawler ' +
      'request and require 402 rather than an accidental 400) — reached statically here, because ' +
      'a corpus fixture is a recorded response rather than a live endpoint. That difference is ' +
      'exactly the boundary of the static reading: the corpus can say the declared method does not ' +
      'match the verb the response was fetched with; it cannot say what the endpoint would answer.',
  },
  {
    id: 'bazaar-output-example-absent',
    ...fromSuite('bazaar info with no computed output example'),
    expected: expect(PASS, PASS_PARSE, PASS),
    discovery_target: cdpBazaar('bazaar.info.output and bazaar.info.output.example are graded ADVISORY, so their absence cannot withhold eligibility'),
    evidence: [
      validator(`${CDP_VALIDATOR} preflight bazaar.info.output / bazaar.info.output.example (severity: ADVISORY, not required)`, D),
      spec(BAZAAR_SPEC, D),
      spec(V2_ACCEPTS, P),
      client(`${CORE_SCHEMAS} — the payment half parses and is unaffected. PARSE-LEVEL`, C),
    ],
    notes: 'DISCOVERY PASSES. The provider asks for an output example and does not withhold the listing over it — an advisory observation that must not become a requirement.',
  },
  {
    id: 'amount-below-cdp-floor',
    ...fromSuite('a price below CDP’s indexing floor'),
    expected: expect(PASS, PASS_PARSE, fail('amount-below-provider-floor')),
    discovery_target: cdpBazaar('accepts[0].amount is a REQUIRED preflight with a documented expectation of ">= 1000" atomic units, and this offer is below it'),
    evidence: [
      validator(`${CDP_VALIDATOR} preflight accepts[0].amount (severity: required), expected ">= 1000" — "Amount 1000 meets $0.001 USDC minimum"`, D),
      house('nothing in either specification sets a price floor; this is a provider observation, it is confined to the provider’s own dimension, and it is labelled as one', D),
      spec(`${V2_ACCEPTS} — an atomic-unit integer string is all the specification requires, which this offer is`, P),
      client(`${CORE_SCHEMAS} — the amount parses and the offer is payable. PARSE-LEVEL`, C),
    ],
    notes:
      'THE CLEANEST PROVIDER-OBSERVATION FIXTURE. Perfectly legal x402, perfectly payable, and ' +
      'ineligible at one named provider. Exactly the case the thread meant by "provider ' +
      'observations should not silently become protocol requirements".',
  },
  {
    id: 'solana-dual-stack',
    title: 'a dual-stack Solana seller',
    built: solanaDualStack(),
    constructed: true,
    expected: expect(PASS, PASS_PARSE, PASS),
    discovery_target: cdpBazaar('the v2 half carries a complete, schema-valid bazaar declaration and every REQUIRED preflight field'),
    evidence: [
      spec('specs/schemes/exact/scheme_exact_svm.md', P),
      client(`${V1_SCHEMAS} — \`solana\` is a member of the v1 network enum, so the v1 half parses`, C),
      client(`${CORE_SCHEMAS} — solana:5eykt… is a CAIP-2 identifier, so the v2 half parses. PARSE-LEVEL ON BOTH: no SVM signer is among this corpus’s pinned packages, so no execution claim is made`, C),
      validator(`${CDP_VALIDATOR} preflight — the required set this envelope satisfies`, D),
    ],
    notes:
      'Nothing here is broken — it exists because a checker that ' +
      'hardcodes EVM address shapes or demands an EIP-712 domain fails all three dimensions on a ' +
      'conformant seller.',
  },
];

// ------------------------------------------------------------------ assemble

export function buildCorpus({ generated, headCommit } = {}) {
  const prior = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  const stamp = {
    generated: generated ?? prior?.generated ?? new Date().toISOString().slice(0, 10),
    headCommit: headCommit ?? prior?.pins?.['10x402']?.commit ?? git(['rev-parse', 'HEAD']),
  };

  const fixtures = ENTRIES.map((entry) => {
    const built = entry.built;
    const { status, headers, body = '', url = null, method = null } = built;
    const response_ = { status, headers, body };
    const fixture = {
      id: entry.id,
      title: entry.title ?? entry.suite ?? entry.id,
      response: response_,
      context: { method: method ?? null, url: url ?? null },
      // COMPUTED, NEVER HAND-WRITTEN. `judgeableFrom()` reads the recorded
      // response and nothing else, so a third adapter reaches the same set from
      // the published file — see FORMAT.md § The recorded-challenge precondition.
      judgeable: judgeableFrom(response_),
      expected: entry.expected,
      evidence: entry.evidence,
    };
    if (entry.population) fixture.population = entry.population;
    if (entry.calibration) fixture.calibration = entry.calibration;
    if (entry.discovery_target) fixture.discovery_target = entry.discovery_target;
    const notes = [entry.notes, entry.why && `From the 10x402 suite — ${entry.why}`, entry.constructed && 'Constructed for this corpus.']
      .filter(Boolean)
      .join(' ');
    if (notes) fixture.notes = notes;
    if (entry.suite) fixture.origin = { kind: '10x402-suite', ref: `test/fixtures/envelopes.mjs — ${entry.suite}` };
    else if (entry.constructed) fixture.origin = { kind: 'constructed', ref: 'corpus/build-fixtures.mjs' };
    else fixture.origin = { kind: 'calibration', ref: entry.evidence[0].ref };
    return fixture;
  });

  // --- guards on the corpus itself, before it is written ----------------
  const ids = new Set();
  for (const f of fixtures) {
    if (ids.has(f.id)) throw new Error(`duplicate fixture id ${f.id}`);
    ids.add(f.id);
    for (const dim of DIMENSIONS) {
      const e = f.expected[dim];
      if (!e || !['pass', 'fail', 'n/a'].includes(e.verdict)) throw new Error(`${f.id}.${dim}: bad verdict`);
      if (e.verdict !== 'fail' && e.reason_tags.length) throw new Error(`${f.id}.${dim}: only a fail carries reason_tags`);
      if (e.verdict === 'fail' && !e.reason_tags.length) throw new Error(`${f.id}.${dim}: a fail must say why`);
      for (const tag of e.reason_tags) {
        if (!TAGS.includes(tag)) throw new Error(`${f.id}.${dim}: unknown reason tag ${tag}`);
        if (!REASON_TAGS[tag].fatal) throw new Error(`${f.id}.${dim}: ${tag} is observational and cannot be a reason`);
      }
      // A dimension the recording cannot support must be `n/a`, kind `scope`,
      // and a dimension it CAN support must not claim to be scope-excluded.
      if (f.judgeable[dim] === false && !(e.verdict === 'n/a' && e.na_kind === 'scope')) {
        throw new Error(`${f.id}.${dim}: not judgeable from this recording, so it must be n/a with na_kind "scope"`);
      }
      if (f.judgeable[dim] !== false && e.na_kind === 'scope') {
        throw new Error(`${f.id}.${dim}: claims na_kind "scope" but the recording supports a verdict`);
      }
    }
    if (!CLIENT_INTEROP_LEVELS.includes(f.expected.client_interop.claim_level)) {
      throw new Error(`${f.id}: client_interop claim_level ${f.expected.client_interop.claim_level}`);
    }
    // An EXECUTE-level claim has to cite the code that executes. Everything in
    // this corpus that does is in @x402/evm; the guard names the marker rather
    // than the package so a future SVM signer citation satisfies it too.
    if (f.expected.client_interop.claim_level === 'execute') {
      const execEvidence = f.evidence.filter((e) => e.kind === 'client-code' && e.dimensions.includes('client_interop') && /EXECUTE-LEVEL/.test(e.ref));
      if (!execEvidence.length) throw new Error(`${f.id}: claims execute-level client interoperability with no execution citation`);
    }
    if (!f.evidence?.length) throw new Error(`${f.id}: no evidence`);
    for (const dim of DIMENSIONS) {
      if (f.expected[dim].verdict === 'n/a') continue;
      if (!f.evidence.some((e) => e.dimensions.includes(dim))) throw new Error(`${f.id}.${dim}: a verdict with no evidence scoped to it`);
    }
    // EVERY NON-n/a DISCOVERY VERDICT NAMES ITS PROVIDER. This is the repair for
    // "provider-specific discovery verdicts asserted without a provider".
    if (f.expected.discovery.verdict !== 'n/a') {
      if (!f.discovery_target?.provider) throw new Error(`${f.id}: a discovery verdict with no named provider`);
      const kinds = new Set(f.evidence.filter((e) => e.dimensions.includes('discovery')).map((e) => e.kind));
      if (!kinds.has('cdp-validator') && !kinds.has('cdp-docs') && !kinds.has('provider-observation')) {
        throw new Error(`${f.id}: a discovery verdict with no provider evidence`);
      }
    }
  }

  return {
    corpus_version: 3,
    name: 'x402 portable conformance corpus',
    description:
      'Recorded 402 responses with tool-neutral, three-dimensional expectations. See corpus/FORMAT.md. ' +
      'Assembled for x402-foundation/x402#3104.',
    generated: stamp.generated,
    schema: {
      fixtures: 'corpus/schema/fixtures.schema.json',
      results: 'corpus/schema/results.schema.json',
      conformance: 'corpus/validate-results.mjs — run it against your own results file',
    },
    pins: buildPins(stamp.headCommit),
    dimensions: {
      payment:
        'can the declared payment be interpreted and settled under the stated x402 version, per the normative specification? ' +
        'Only a NORMATIVE citation may fail it.',
      client_interop:
        'will the cited client implementations, at the pinned versions, parse and execute it correctly? ' +
        'Each fixture states whether its claim is `parse` or `execute`; an `execute` claim cites a signer or a payment path.',
      discovery:
        'STATIC DECLARATION ELIGIBILITY: is the registry-facing declaration present, schema-valid, and does it meet the ' +
        'named provider’s DOCUMENTED requirements as documented? Never a claim that anything was indexed, listed or crawled — ' +
        'those outcomes need a live adapter and are outside this corpus’s scope. Provider observation by construction.',
    },
    verdicts: {
      pass: 'the dimension’s question is answered yes',
      fail: 'answered no; carries at least one reason_tag',
      'n/a': 'the question cannot be answered from this fixture. `na_kind` says which of the two reasons applies',
      'not-evaluated': 'RESULTS ONLY — this tool did not run the rules that would answer this. Never a pass, never in an expectation',
    },
    na_kinds: {
      'question-does-not-arise': 'the recording is complete and the question does not apply to it — a v1-only seller against a v2-shaped registry requirement, an envelope that did not decode',
      scope: 'the recording cannot support any answer — no challenge was recorded at all. EXCLUDED from the agreement statistics rather than counted as an agreement',
    },
    client_interop_levels: {
      parse: 'the cited client’s decoder accepts or rejects the declaration',
      execute: 'the cited client also selects the offer, signs it and issues the payment. Requires a citation into a signer or a payment path',
    },
    evidence_kinds: {
      spec: 'normative — a section of the x402 specification at the pinned commit. THE ONLY KIND THAT MAY FAIL `payment`',
      'client-code': 'binding for that client at the pinned version, and for nothing else. THE ONLY KIND THAT MAY FAIL `client_interop`',
      'cdp-validator': 'observed behaviour of the CDP Bazaar validator — provider observation, not protocol',
      'cdp-docs': 'CDP’s published seller documentation — provider observation, not protocol',
      'field-report': 'a reproduced report from the x402 issue tracker',
      'provider-observation': 'observed behaviour of a named provider or a live capture',
      'house-opinion': 'this corpus’s own reasoning, cited as such. NOT normative, and it may not fail any dimension',
    },
    reason_tags: Object.fromEntries(Object.entries(REASON_TAGS).map(([tag, v]) => [tag, v.meaning])),
    fixtures,
  };
}

// ------------------------------------------------------------------ cli

if (import.meta.url === `file://${process.argv[1]}`) {
  const stampNow = process.argv.includes('--stamp');
  const doc = buildCorpus(
    stampNow ? { generated: new Date().toISOString().slice(0, 10), headCommit: git(['rev-parse', 'HEAD']) } : {}
  );
  writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(
    `corpus/fixtures.json — ${doc.fixtures.length} fixtures, corpus_version ${doc.corpus_version}` +
      `${stampNow ? ' (re-stamped)' : ' (date and commit carried forward — pass --stamp to refresh)'}\n`
  );
}
