#!/usr/bin/env node
// Generates corpus/fixtures.json.
//
// EVERY FIXTURE'S SEMANTICS COME FROM SOMEWHERE THAT ALREADY EXISTED. The bulk
// are the broken-envelope fixtures in test/fixtures/envelopes.mjs, imported and
// invoked rather than retyped, so "the exported corpus is the same fixture the
// suite asserts on" is true by construction and cannot drift. The calibration
// pair are the v2 transport spec's own canonical 402 and the frozen production
// capture in worker/positive-control.js. Four more are constructed here, for
// cases the thread named that the suite had no fixture for; each is the same
// one-thing-changed discipline and says so in `notes`.
//
// EXPECTATIONS ARE HAND-AUTHORED, NEVER READ BACK OUT OF THE ENGINE. That is
// the whole point: corpus/run-10x402.mjs then has to reproduce them, and a
// mismatch means the fixture is wrong or the engine is. Nothing in this file
// imports worker/lint.js.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  FIXTURES,
  v1Envelope,
  v2Envelope,
  v2Accept,
  response,
  RESOURCE_URL,
} from '../test/fixtures/envelopes.mjs';
import { base64Encode } from '../worker/envelope.js';
import { POSITIVE_CONTROL } from '../worker/positive-control.js';
import { TAGS } from './vocabulary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const b64 = (value) => base64Encode(new TextEncoder().encode(JSON.stringify(value)));

// ------------------------------------------------------------------ pins

const sha = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const PINS = {
  '10x402': {
    repo: 'https://github.com/chronick/10x402',
    commit: sha(['rev-parse', 'HEAD'], join(here, '..')),
    note: 'the engine under test — worker/lint.js, 75 checks',
  },
  '@x402/core': {
    version: '2.23.0',
    note: 'the v2 client schemas every client-code citation in this corpus resolves against',
  },
  x402: {
    version: '1.2.0',
    note: 'the v1 client package (x402 / x402-fetch), cited for v1 parse behaviour',
  },
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
    note:
      'run from a temporary clone only. No file from this repository is vendored into 10x402, ' +
      'and no code from it is copied into the adapter: corpus/run-x402-doctor.mjs imports ' +
      'diagnoseX402Endpoint() from the clone at this commit and maps its output.',
  },
};

// ------------------------------------------------------------------ evidence refs

const V2_TRANSPORT = 'specs/transports-v2/http.md § Payment Required Signaling';
const V1_TRANSPORT = 'specs/transports-v1/http.md § Payment Required Signaling';
const V2_ACCEPTS = 'specs/x402-specification-v2.md § 5.1.2 (PaymentRequirements table)';
const V2_RESOURCE = 'specs/x402-specification-v2.md § 5.1.2 (ResourceInfo table)';
const V1_ACCEPTS = 'specs/x402-specification-v1.md § 5.1.2 (PaymentRequirements table)';
const BAZAAR_SPEC = 'specs/extensions/bazaar.md';
const CORE_SCHEMAS = '@x402/core@2.23.0 dist/cjs/schemas/index.js';
const V1_SCHEMAS = 'x402@1.2.0 dist/esm/chunk-V3RMM5AE.mjs (PaymentRequirementsSchema)';
const V1_FETCH = 'x402-fetch@1.2.0 dist/esm/index.mjs:19-23';
const CDP_VALIDATOR = 'audit/2026-08-19/cdp-validator-toolshed.json';
const CDP_GET_DISCOVERED = 'https://docs.cdp.coinbase.com/x402/seller/get-discovered';

const spec = (ref) => ({ kind: 'spec', ref });
const client = (ref) => ({ kind: 'client-code', ref });
const validator = (ref) => ({ kind: 'cdp-validator', ref });
const cdpDocs = (ref) => ({ kind: 'cdp-docs', ref });
const fieldReport = (ref) => ({ kind: 'field-report', ref });
const observed = (ref) => ({ kind: 'provider-observation', ref });
const house = (ref) => ({ kind: 'house-opinion', ref });

// ------------------------------------------------------------------ helpers

/** Pull one fixture out of the suite by its name, and run its builder. */
function fromSuite(name) {
  const found = FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(`no suite fixture named ${JSON.stringify(name)}`);
  return { built: found.response(), why: found.why, suite: name };
}

const expect = (payment, client_interop, discovery) => ({
  payment: { verdict: payment[0], reason_tags: payment[1] ?? [] },
  client_interop: { verdict: client_interop[0], reason_tags: client_interop[1] ?? [] },
  discovery: { verdict: discovery[0], reason_tags: discovery[1] ?? [] },
});

const PASS = ['pass'];
const NA = ['n/a'];
const fail = (...tags) => ['fail', tags];

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

// ------------------------------------------------------------------ the calibration pair

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
    expected: expect(PASS, PASS, fail('bazaar-extension-absent')),
    evidence: [spec(`${V2_TRANSPORT} — the whole response, verbatim`), spec(V2_ACCEPTS), validator(`${CDP_VALIDATOR} preflight — bazaar extension required for indexing`)],
    notes:
      'THE CALIBRATION TARGET. Payment and client_interop must pass: a checker that flags the ' +
      'specification’s own example is wrong. Discovery legitimately fails — the example ' +
      'publishes no extensions.bazaar and is therefore not indexable. One fixture, two ' +
      'different correct answers, which is the argument for keeping the dimensions apart.',
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
    expected: expect(PASS, PASS, PASS),
    evidence: [
      observed(`captured ${POSITIVE_CONTROL.captured} from ${POSITIVE_CONTROL.url} with one unauthenticated POST`),
      spec(V2_TRANSPORT),
      spec(V1_TRANSPORT),
      spec(BAZAAR_SPEC),
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
    expected: expect(PASS, PASS, PASS),
    evidence: [spec(`${BAZAAR_SPEC} — the GET-endpoint example, info and schema verbatim`), spec(`${BAZAAR_SPEC} — output.example is typed \`any\``)],
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
    expected: expect(PASS, PASS, fail('bazaar-extension-absent')),
    evidence: [
      spec('specs/schemes/batch-settlement/scheme_batch_settlement_cloudflare.md — the scheme’s own 402, verbatim'),
      spec('…:110 — maxTimeoutSeconds is optional on this network'),
      spec('…:48 — the network omits `schema` to stay under 2 KB'),
      client(`${CORE_SCHEMAS} — NetworkSchemaV2 is min(3) plus a colon, so \`cloudflare:402\` is legal`),
    ],
    notes:
      'A spec-defined scheme with `asset: "USD"`, `payTo: "merchant"` and no bazaar extension. ' +
      'Deliberately terse and deliberately not discoverable — nothing about it is broken, and a ' +
      'payment-dimension failure here would be a checker asserting EVM shapes as protocol law.',
  },
  {
    id: 'calibration-solana-spec-envelope',
    title: 'a spec-conformant Solana v2 envelope',
    calibration: 'must-pass',
    built: solanaSpecEnvelope(),
    expected: expect(PASS, PASS, fail('bazaar-extension-absent')),
    evidence: [
      spec('specs/schemes/exact/scheme_exact_svm.md — the exact scheme’s own SVM PaymentRequirements, verbatim'),
      spec('…:61-67 — Solana’s `extra` is {feePayer, memo, recentBlockhash, lastValidBlockHeight}; there is no EIP-712 domain'),
    ],
    notes:
      'base58 payTo, an SPL mint as asset, and no typed-data domain. 10x402 graded this F before ' +
      'the audit because its address regex hardcoded a 20-byte EVM address for every network.',
  },

  // ═══ the reference shapes ══════════════════════════════════════════
  {
    id: 'perfect-dual-stack',
    ...fromSuite('perfect dual-stack 402'),
    expected: expect(PASS, PASS, PASS),
    evidence: [spec(V2_TRANSPORT), spec(V1_TRANSPORT), spec(BAZAAR_SPEC)],
  },
  {
    id: 'perfect-v2-only',
    ...fromSuite('perfect v2-only 402'),
    expected: expect(PASS, PASS, PASS),
    evidence: [spec(V2_TRANSPORT), client(`${V1_FETCH} — a pre-header client reads the body and finds none`)],
  },
  {
    id: 'perfect-v1-only',
    ...fromSuite('perfect v1-only 402'),
    expected: expect(PASS, PASS, NA),
    evidence: [
      spec(V1_TRANSPORT),
      client(`${CORE_SCHEMAS} — @x402/core falls back to a v1 body when there is no header, so this is payable`),
      validator(`${CDP_VALIDATOR} preflight — the PAYMENT-REQUIRED header is a required preflight, so this is not indexable`),
    ],
    notes:
      'DISCOVERY IS n/a, NOT fail. CDP’s requirements are a v2 shape; answering `fail` would read ' +
      'as a list of things wrong with a v2 envelope this seller never published.',
  },
  {
    id: 'dual-offers-reordered',
    ...fromSuite('the same two offers, listed in a different order in each envelope'),
    expected: expect(PASS, PASS, PASS),
    evidence: [house('neither specification orders accepts[]; offers are matched on (chain, asset) before anything is compared')],
  },

  // ═══ encoding ══════════════════════════════════════════════════════
  {
    id: 'v2-header-b64-urlsafe',
    ...fromSuite('v2 header in url-safe base64'),
    expected: expect(fail('b64-urlsafe'), fail('b64-urlsafe'), NA),
    evidence: [
      client(`${CORE_SCHEMAS} — Base64EncodedRegex is tested against the RAW header value BEFORE atob()`),
      spec(`${V2_TRANSPORT} — the header carries base64-encoded JSON`),
      fieldReport('x402-foundation/x402#3104 — reported as a case the doctor prototype did not yet cover'),
    ],
  },
  {
    id: 'v2-header-b64-whitespace',
    ...fromSuite('a v2 header padded with whitespace'),
    expected: expect(fail('b64-urlsafe'), fail('b64-urlsafe'), NA),
    evidence: [client(`${CORE_SCHEMAS} — the regex runs on the raw value, so a leading space fails it before decoding`)],
    notes:
      'Discovery is n/a on both base64 fixtures for the same reason: the envelope did not decode, ' +
      'so its registry metadata could not be judged at all — not a clean listing and not a refused ' +
      'one, an unanswerable question. ' +
      'THE FIXTURE THAT CANNOT SURVIVE A LIVE TRANSPORT. HTTP strips optional whitespace around a ' +
      'header value, so any tool that probes a live URL sees the trimmed header and cannot ' +
      'reproduce this at all. It is reachable only by linting a captured or pasted response — ' +
      'which is why the corpus carries the response rather than a URL.',
  },
  {
    id: 'no-envelope-html-body',
    ...fromSuite('a 402 with an unparseable body and no header'),
    expected: expect(fail('envelope-absent', 'envelope-not-json'), fail('envelope-absent', 'envelope-not-json'), NA),
    evidence: [spec(V2_TRANSPORT), spec(V1_TRANSPORT), client(V1_FETCH)],
  },

  // ═══ version boundary ══════════════════════════════════════════════
  {
    id: 'v2-network-bare-name',
    ...fromSuite('v2 envelope naming the network "base"'),
    expected: expect(fail('network-form'), fail('network-form'), PASS),
    evidence: [spec(V2_ACCEPTS), client(`${CORE_SCHEMAS} — NetworkSchemaV2 requires a colon`)],
  },
  {
    id: 'v1-network-caip2',
    ...fromSuite('v1 envelope naming the network in CAIP-2'),
    expected: expect(fail('network-form'), fail('network-form'), PASS),
    evidence: [spec(V1_ACCEPTS), client(`${V1_SCHEMAS} — the v1 network field is a closed enum of bare names`)],
  },
  {
    id: 'v2-amount-uses-v1-field-name',
    ...fromSuite('v2 envelope carrying maxAmountRequired instead of amount'),
    expected: expect(fail('missing-required-field'), fail('missing-required-field'), PASS),
    evidence: [spec(`${V2_ACCEPTS} — v2 renamed maxAmountRequired to amount`), client(CORE_SCHEMAS)],
    notes: 'The corpus tags the FATAL reason (`amount` is absent). The v1 field left behind is reported by 10x402 as a non-fatal crosstalk warning.',
  },
  {
    id: 'v2-resource-flat-string',
    ...fromSuite('v2 envelope with a flat-string resource'),
    expected: expect(fail('resource-shape'), fail('resource-shape'), NA),
    evidence: [spec(V2_RESOURCE), client(`${CORE_SCHEMAS} — ResourceInfoSchema is an object`), validator(CDP_VALIDATOR)],
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
    expected: expect(PASS, PASS, PASS),
    evidence: [
      spec('specs/transports-v2/http.md § Response Body — "Response bodies are a server implementation concern"'),
      client(`${V1_FETCH} — a pre-header client parses the body with v1 rules`),
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
    expected: expect(fail('timeout-form'), fail('timeout-form'), PASS),
    evidence: [
      spec(V2_ACCEPTS),
      client(`${CORE_SCHEMAS} — z.number().positive(), no coercion, so "60" fails the schema`),
      client('@x402/evm — where a quoted timeout slips through it is ADDED to a timestamp, concatenating rather than adding'),
    ],
  },
  {
    id: 'v2-timeout-absent',
    title: 'a v2 accepts entry with no maxTimeoutSeconds, on an EVM chain',
    built: v2TimeoutAbsent(),
    constructed: true,
    expected: expect(fail('timeout-form'), fail('timeout-form'), PASS),
    evidence: [
      spec(`${V2_ACCEPTS} — maxTimeoutSeconds is required for the exact scheme on EVM`),
      client(`${CORE_SCHEMAS}`),
      spec('specs/schemes/batch-settlement/scheme_batch_settlement_cloudflare.md:110 — and is OPTIONAL on cloudflare:402, which is why this fixture is on eip155'),
    ],
    notes:
      'Constructed for this corpus. The pair to calibration-cloudflare-batch-settlement: the ' +
      'same absent field is a defect on one network and legal on another, so a checker that ' +
      'hardcodes "maxTimeoutSeconds is required" fails a spec-defined profile.',
  },
  {
    id: 'v2-asset-ticker-not-address',
    title: 'asset given as the ticker "USDC" instead of the contract address',
    built: v2AssetSymbol(),
    constructed: true,
    expected: expect(fail('asset-form'), fail('asset-form'), PASS),
    evidence: [spec(`${V2_ACCEPTS} — asset is the on-chain identifier`), client(`${CORE_SCHEMAS} — the eip155 asset is an address`)],
    notes: 'Constructed for this corpus, v2-only so it carries exactly one fault.',
  },
  {
    id: 'extra-eip712-absent',
    ...fromSuite('no EIP-712 domain in `extra`'),
    expected: expect(fail('missing-eip712-extra'), fail('missing-eip712-extra'), PASS),
    evidence: [
      spec('specs/schemes/exact/scheme_exact_evm.md — the EIP-3009 domain is signed from extra.name/extra.version'),
      client('@x402/evm — throws at payment CREATION when extra.name or extra.version is absent'),
    ],
  },
  {
    id: 'v2-payto-array',
    ...fromSuite('payTo as an array holding a valid address'),
    expected: expect(fail('payee-form', 'dual-divergence'), fail('payee-form'), PASS),
    evidence: [
      spec(V2_ACCEPTS),
      client(`${CORE_SCHEMAS} — the zod schema and viem both reject a non-string payTo`),
      house('the dual-stack comparison is a house rule; neither specification requires the two envelopes to agree'),
    ],
  },
  {
    id: 'dual-payto-divergence',
    ...fromSuite('dual-stack payTo divergence'),
    expected: expect(fail('dual-divergence'), PASS, PASS),
    evidence: [
      house('NOT A PROTOCOL REQUIREMENT. Neither specification says a dual-stack seller’s two envelopes must name the same payee; both halves are individually valid and individually settleable. 10x402 treats the divergence as a payment-dimension defect because the money lands in two places, and records the evidence as house-opinion so nobody mistakes it for spec.'),
      client(`${V1_FETCH} — a v1 client reads the body; a v2 client reads the header; neither sees the other`),
    ],
  },
  {
    id: 'dual-network-unmapped-chain',
    ...fromSuite('dual-stack on a chain outside the linter’s table'),
    expected: expect(PASS, fail('network-unknown'), PASS),
    evidence: [
      client(`${V1_SCHEMAS} — "arbitrum" is not a member of the v1 closed enum, so x402-fetch throws invalid_enum_value on this entry`),
      house('the v1↔v2 chain equivalence table covers the nine chains x402 clients ship with; outside it the pair is unverified, not divergent'),
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
    expected: expect(PASS, PASS, NA),
    evidence: [
      client(`${V1_FETCH} — \`if (response.status !== 402) return response\`; the client never enters the payment flow`),
      validator(`${CDP_VALIDATOR} preflight returns_402 (required)`),
      cdpDocs(`${CDP_GET_DISCOVERED} — endpoints are health-probed on an interval`),
    ],
    notes:
      'THE MOST ARGUABLE EXPECTATION IN THE CORPUS, and it is written down rather than hidden. A ' +
      '200 to an anonymous caller is a seller CHOICE, not a malformed challenge: there is no ' +
      'envelope to misinterpret, so 10x402 does not fail the payment dimension on it. A tool ' +
      'that reads “Bazaar requires 402” as a protocol requirement fails it. See DISAGREEMENTS.md.',
  },
  {
    id: 'redirect-instead-of-402',
    ...fromSuite('a redirect instead of a 402'),
    expected: expect(PASS, PASS, NA),
    evidence: [
      client('@x402/fetch@2.23.0 dist/esm/index.mjs:10 — `await fetch(request)`, the default redirect mode, so redirects ARE followed'),
      house('the envelope is at the other end of the redirect, unread; the fixture is about the redirect, not about an absent envelope'),
    ],
  },

  // ═══ discovery ═════════════════════════════════════════════════════
  {
    id: 'bazaar-extension-absent',
    ...fromSuite('v2 envelope with no extensions.bazaar'),
    expected: expect(PASS, PASS, fail('bazaar-extension-absent')),
    evidence: [validator(`${CDP_VALIDATOR} — the bazaar extension is required for indexing`), spec(BAZAAR_SPEC), fieldReport('x402-foundation/x402#2207, #2284')],
    notes: 'Payable and undiscoverable. Every payment on this endpoint works; the listing never appears and nothing says why.',
  },
  {
    id: 'bazaar-info-schema-mismatch',
    ...fromSuite('bazaar info that does not validate against its own schema'),
    expected: expect(PASS, PASS, fail('bazaar-info-schema-mismatch')),
    evidence: [spec(`${BAZAAR_SPEC} — info must validate against the schema published beside it`), validator(CDP_VALIDATOR), fieldReport('x402-foundation/x402#3045')],
  },
  {
    id: 'bazaar-schema-external-ref',
    ...fromSuite('a bazaar schema behind an external $ref'),
    expected: expect(PASS, PASS, fail('bazaar-schema-unresolvable', 'bazaar-info-schema-mismatch')),
    evidence: [spec(`${BAZAAR_SPEC} — $ref and $id must be same-document fragments; a facilitator MUST NOT resolve an external one`), fieldReport('x402-foundation/x402#3045, fifth production bug')],
  },
  {
    id: 'bazaar-input-no-type',
    ...fromSuite('a bazaar input with no `type` discriminator'),
    expected: expect(PASS, PASS, fail('bazaar-input-shape', 'bazaar-info-schema-mismatch')),
    evidence: [spec(`${BAZAAR_SPEC} — \`type\` is the discriminator that selects which input shape applies`), fieldReport('x402-foundation/x402#3045, fourth production bug')],
  },
  {
    id: 'bazaar-input-method-mismatch',
    ...fromSuite('a bazaar input.method that is not the verb we probed'),
    expected: expect(PASS, PASS, fail('bazaar-input-method')),
    evidence: [validator(`${CDP_VALIDATOR} — the probed method is compared against the declared one, and the comparison is required`), spec(BAZAAR_SPEC)],
    notes:
      'The closest fixture to the doctor prototype’s founding check (replay the declared crawler ' +
      'request and require 402 rather than an accidental 400) — reached statically here, because ' +
      'a corpus fixture is a recorded response rather than a live endpoint.',
  },
  {
    id: 'bazaar-output-example-absent',
    ...fromSuite('bazaar info with no computed output example'),
    expected: expect(PASS, PASS, PASS),
    evidence: [validator(`${CDP_VALIDATOR} — both output checks are graded ADVISORY, not required`), spec(BAZAAR_SPEC)],
    notes: 'DISCOVERY PASSES. The provider asks for an output example and does not withhold the listing over it — an advisory observation that must not become a requirement.',
  },
  {
    id: 'amount-below-cdp-floor',
    ...fromSuite('a price below CDP’s indexing floor'),
    expected: expect(PASS, PASS, fail('amount-below-provider-floor')),
    evidence: [
      validator(`${CDP_VALIDATOR} — the amount check is required with an expectation of >= 1000 atomic units`),
      house('nothing in either specification sets a price floor; this is a provider observation and is labelled as one'),
    ],
    notes:
      'THE CLEANEST PROVIDER-OBSERVATION FIXTURE. Perfectly legal x402, perfectly payable, and ' +
      'un-indexable by one named provider. Exactly the case the thread meant by "provider ' +
      'observations should not silently become protocol requirements".',
  },
  {
    id: 'solana-dual-stack',
    title: 'a dual-stack Solana seller',
    built: solanaDualStack(),
    constructed: true,
    expected: expect(PASS, PASS, PASS),
    evidence: [
      spec('specs/schemes/exact/scheme_exact_svm.md'),
      client(`${V1_SCHEMAS} — \`solana\` is a member of the v1 network enum`),
      client(`${CORE_SCHEMAS} — solana:5eykt… is a CAIP-2 identifier`),
    ],
    notes:
      'Constructed for this corpus. Nothing here is broken — it exists because a checker that ' +
      'hardcodes EVM address shapes or demands an EIP-712 domain fails all three dimensions on a ' +
      'conformant seller.',
  },
];

// ------------------------------------------------------------------ assemble

const fixtures = ENTRIES.map((entry) => {
  const built = entry.built;
  const { status, headers, body = '', url = null, method = null } = built;
  const fixture = {
    id: entry.id,
    title: entry.title ?? entry.suite ?? entry.id,
    response: { status, headers, body },
    context: { method: method ?? null, url: url ?? null },
    expected: entry.expected,
    evidence: entry.evidence,
  };
  if (entry.calibration) fixture.calibration = entry.calibration;
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
  for (const dim of ['payment', 'client_interop', 'discovery']) {
    const e = f.expected[dim];
    if (!e || !['pass', 'fail', 'n/a'].includes(e.verdict)) throw new Error(`${f.id}.${dim}: bad verdict`);
    if (e.verdict !== 'fail' && e.reason_tags.length) throw new Error(`${f.id}.${dim}: only a fail carries reason_tags`);
    if (e.verdict === 'fail' && !e.reason_tags.length) throw new Error(`${f.id}.${dim}: a fail must say why`);
    for (const tag of e.reason_tags) if (!TAGS.includes(tag)) throw new Error(`${f.id}.${dim}: unknown reason tag ${tag}`);
  }
  if (!f.evidence?.length) throw new Error(`${f.id}: no evidence`);
}

const doc = {
  corpus_version: 1,
  name: 'x402 portable conformance corpus',
  description:
    'Recorded 402 responses with tool-neutral, three-dimensional expectations. See corpus/FORMAT.md. ' +
    'Assembled for x402-foundation/x402#3104.',
  generated: new Date().toISOString().slice(0, 10),
  pins: PINS,
  dimensions: {
    payment: 'can the declared payment be interpreted and settled under the stated x402 version, per the normative specification?',
    client_interop: 'will the cited client implementations parse and execute it correctly?',
    discovery: 'will registry-specific metadata be accepted and indexed by the cited provider? (provider observation)',
  },
  evidence_kinds: {
    spec: 'normative — a section of the x402 specification at the pinned commit',
    'client-code': 'binding for that client at the pinned version, and for nothing else',
    'cdp-validator': 'observed behaviour of the CDP Bazaar validator — provider observation, not protocol',
    'cdp-docs': 'CDP’s published seller documentation — provider observation, not protocol',
    'field-report': 'a reproduced report from the x402 issue tracker',
    'provider-observation': 'observed behaviour of a named provider or a live capture',
    'house-opinion': 'this corpus’s own reasoning, cited as such. NOT normative and never to be read as one.',
  },
  reason_tags: Object.fromEntries(TAGS.map((t) => [t, undefined])),
  fixtures,
};

// reason_tags with their meanings, in vocabulary order
const { REASON_TAGS } = await import('./vocabulary.mjs');
doc.reason_tags = Object.fromEntries(Object.entries(REASON_TAGS).map(([tag, v]) => [tag, v.meaning]));

writeFileSync(join(here, 'fixtures.json'), `${JSON.stringify(doc, null, 2)}\n`);
process.stdout.write(`corpus/fixtures.json — ${fixtures.length} fixtures, corpus_version ${doc.corpus_version}\n`);
