// THE CALIBRATION INVARIANTS. Pure, no worker.
//
// Five responses that the engine MUST NOT fail, taken from the specifications
// and the wire rather than from this repo's imagination. They come from
// `.groundtruth/ADJUDICATION.md` § Calibration, the binding merge of a
// five-auditor accuracy review of the check catalogue.
//
// The distinction from test/lint-engine.test.mjs matters. That file proves the
// checks FIRE — each fixture is a correct envelope with one thing broken, and
// the assertion is that the break is caught. This file proves the checks STAY
// QUIET, against documents nobody here wrote: the v2 transport spec's own 402,
// the bazaar extension's own worked example, the Solana and Cloudflare scheme
// specs' own PaymentRequirements, and a real production capture.
//
// A linter that flags the specification's own examples is not strict. It is
// wrong, and it is wrong in the direction that costs a stranger a day of
// looking for a fault that is in this file's engine rather than in their
// endpoint. Every one of the five below was FAILING when it was written; the
// audit is the reason each one is here.
//
// WHERE EACH FIXTURE COMES FROM is cited on the fixture. When a spec moves,
// the citation is how you find what to re-check — the same discipline the
// catalogue's own `sources` array exists for.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lint, CHECKS_BY_ID } from '../worker/lint.js';
import { base64Json, build402 } from '../worker/envelope.js';
import { POSITIVE_CONTROL } from '../worker/positive-control.js';
import { ENDPOINTS } from '../worker/catalog.js';

/** Every finding, rendered for an assertion message that says what went wrong. */
const show = (report) =>
  `grade ${report.grade}\n` +
  report.findings.map((f) => `  [${f.severity}${f.core ? ', core' : ''}] ${f.code}: ${f.message}`).join('\n');

/** The findings whose check sits in one regime. */
const inRegime = (report, regime) =>
  report.findings.filter((f) => CHECKS_BY_ID.get(f.code)?.regime === regime);

// ═══════════════════════════════════════════════════════════════════════
// 1. The v2 transport spec's own canonical 402
// ═══════════════════════════════════════════════════════════════════════
//
// .groundtruth/spec-repo/specs/transports-v2/http.md:19-53 — the whole
// response, verbatim: status 402, `Content-Type: application/json`, the
// PAYMENT-REQUIRED header, and a body of `{}`.
//
// It publishes no `extensions.bazaar`, no `resource.method`, no serviceName and
// no tags, because none of those is required to be payable. Three checks used
// to charge it for that, and the spec's own example graded C.

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

const specV2Response = (overrides = {}) => ({
  status: 402,
  headers: {
    'content-type': 'application/json',
    'payment-required': base64Json(SPEC_V2_ENVELOPE),
  },
  body: '{}',
  ...overrides,
});

describe('calibration 1: the v2 spec’s own canonical 402', () => {
  test('grades A', () => {
    const report = lint(specV2Response());
    assert.equal(report.grade, 'A', `the specification's own example is not an A:\n${show(report)}`);
  });

  test('produces no error and no warning in any regime', () => {
    const report = lint(specV2Response());
    const loud = report.findings.filter((f) => f.severity !== 'info');
    assert.deepEqual(loud.map((f) => f.code), [], show(report));
  });

  test('a body of `{}` next to a valid v2 header is at most an info', () => {
    // transports-v2/http.md § Response Body: "Response bodies are a server
    // implementation concern." The spec's own example serves `{}`, so an
    // info is the ceiling — anything louder fails the document it came from.
    const report = lint(specV2Response());
    const body = report.findings.find((f) => f.code === 'V1_BODY_NOT_ENVELOPE');
    if (body) assert.equal(body.severity, 'info', show(report));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. The bazaar extension's own worked example
// ═══════════════════════════════════════════════════════════════════════
//
// .groundtruth/spec-repo/specs/extensions/bazaar.md:21-95 — the GET-endpoint
// example, `info` and `schema` copied verbatim. Its `output.example` is a JSON
// OBJECT, which bazaar.md:284-294 types as `any`; the old predicate demanded a
// non-empty STRING and reported the spec's own example as "missing".

const BAZAAR_SPEC_EXAMPLE = {
  info: {
    input: {
      type: 'http',
      method: 'GET',
      queryParams: { city: 'San Francisco' },
    },
    output: {
      type: 'json',
      example: { city: 'San Francisco', weather: 'foggy', temperature: 60 },
    },
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
          queryParams: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
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

const bazaarSpecResponse = () => {
  const env = JSON.parse(JSON.stringify(SPEC_V2_ENVELOPE));
  // bazaar.md:24-31 — the example's own resource block.
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
    headers: { 'content-type': 'application/json', 'payment-required': base64Json(env) },
    body: '{}',
    // The example is a GET endpoint, and bazaar.info.input.method says so —
    // so the probed verb has to be GET or the method-agreement check is
    // measuring this test's carelessness rather than the envelope.
    method: 'GET',
  };
};

describe('calibration 2: bazaar.md’s own worked example', () => {
  test('draws no bazaar finding at all', () => {
    const report = lint(bazaarSpecResponse());
    const bazaar = report.findings.filter((f) => f.code.startsWith('V2_BAZAAR'));
    assert.deepEqual(bazaar.map((f) => f.code), [], show(report));
  });

  test('an object-valued output.example is accepted', () => {
    const report = lint(bazaarSpecResponse());
    assert.ok(
      !report.findings.some((f) => f.code === 'V2_BAZAAR_OUTPUT_EXAMPLE'),
      `bazaar.md types output.example as \`any\` and its own example is an object:\n${show(report)}`
    );
  });

  test('grades A and is bazaar-ready', () => {
    const report = lint(bazaarSpecResponse());
    assert.equal(report.grade, 'A', show(report));
    assert.equal(report.summary.bazaar_ready, true, show(report));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. A spec-conformant Solana envelope
// ═══════════════════════════════════════════════════════════════════════
//
// .groundtruth/spec-repo/specs/schemes/exact/scheme_exact_svm.md:53-68 — the
// `exact` scheme's own PaymentRequirements for Solana, verbatim. base58 payTo,
// an SPL mint as `asset`, and an `extra` of {feePayer, memo, recentBlockhash,
// lastValidBlockHeight} — there is no EIP-712 domain on Solana.
//
// The old engine graded this F on V2_PAYTO, because ADDRESS_RE hardcoded a
// 20-byte EVM address for every network. CDP's facilitator settles Solana.

const SVM_ACCEPT = {
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
};

const svmResponse = () => {
  const env = JSON.parse(JSON.stringify(SPEC_V2_ENVELOPE));
  env.accepts = [SVM_ACCEPT];
  return {
    status: 402,
    headers: { 'content-type': 'application/json', 'payment-required': base64Json(env) },
    body: '{}',
  };
};

describe('calibration 3: a spec-conformant Solana envelope', () => {
  test('grades A', () => {
    const report = lint(svmResponse());
    assert.equal(report.grade, 'A', `a conformant solana:* envelope is not an A:\n${show(report)}`);
  });

  test('does not demand an EVM address for a base58 payTo', () => {
    const report = lint(svmResponse());
    assert.ok(!report.findings.some((f) => f.code === 'V2_PAYTO'), show(report));
  });

  test('does not demand an EIP-712 domain on a chain that has none', () => {
    // scheme_exact_svm.md:61-67: Solana's `extra` carries feePayer/memo/
    // recentBlockhash/lastValidBlockHeight. name/version are meaningless here.
    const report = lint(svmResponse());
    assert.ok(!report.findings.some((f) => f.code === 'V2_EXTRA_EIP712'), show(report));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. The Cloudflare batch-settlement profile
// ═══════════════════════════════════════════════════════════════════════
//
// .groundtruth/spec-repo/specs/schemes/batch-settlement/scheme_batch_settlement_cloudflare.md:75-112
// — the scheme's own 402, verbatim. `network: "cloudflare:402"`, `asset: "USD"`
// (ISO 4217), `payTo: "merchant"` (a role constant the core spec allows), no
// `maxTimeoutSeconds` (":110" marks it optional for this network), and no
// bazaar extension (":48" — the network omits `schema` to stay under 2 KB).
//
// Not an A: it is deliberately not discoverable and deliberately terse. But
// nothing about it is BROKEN, and an F would say it was.

const cloudflareResponse = () => ({
  status: 402,
  headers: {
    'content-type': 'text/html',
    'payment-required': base64Json({
      x402Version: 2,
      error: 'No PAYMENT-SIGNATURE header provided',
      resource: {
        url: 'https://example.com/article',
        mimeType: 'text/html',
      },
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
});

describe('calibration 4: the Cloudflare batch-settlement profile', () => {
  test('produces no core error', () => {
    const report = lint(cloudflareResponse());
    const core = report.findings.filter((f) => f.core);
    assert.deepEqual(core.map((f) => f.code), [], `a spec-defined scheme graded F:\n${show(report)}`);
    assert.notEqual(report.grade, 'F', show(report));
  });

  test('accepts `merchant` as payTo and `USD` as asset', () => {
    const report = lint(cloudflareResponse());
    assert.ok(!report.findings.some((f) => f.code === 'V2_PAYTO'), show(report));
    assert.ok(!report.findings.some((f) => f.code === 'V2_ASSET'), show(report));
  });

  test('accepts `cloudflare:402` as a network identifier', () => {
    // @x402/core@2.23.0 dist/cjs/schemas/index.js:63-65 — NetworkSchemaV2 is
    // min(3) plus "contains a colon". A ten-character namespace is legal there
    // and the scheme spec calls cloudflare:402 CAIP-2 format at :107.
    const report = lint(cloudflareResponse());
    const network = report.findings.find((f) => f.code === 'V2_NETWORK_CAIP2');
    assert.equal(network, undefined, show(report));
  });

  test('does not treat this scheme’s optional maxTimeoutSeconds as a break', () => {
    // scheme_batch_settlement_cloudflare.md:110 — "maxTimeoutSeconds:
    // Maximum time allowed for payment completion (optional, see note below)".
    const report = lint(cloudflareResponse());
    const timeout = report.findings.find((f) => f.code === 'V2_MAX_TIMEOUT');
    if (timeout) assert.ok(!timeout.core, show(report));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. The two known-good responses this repo already depends on
// ═══════════════════════════════════════════════════════════════════════
//
// The positive control is a real production 402 captured off the wire; the
// self-lint is the 402 this service itself publishes. Both graded A before the
// audit and must still grade A after it — a catalogue change that quietly
// breaks either one has broken the ground the measurement stands on.

describe('calibration 5: the known-good responses still grade A', () => {
  test('the captured production 402 grades A with zero findings', () => {
    const report = lint({
      status: POSITIVE_CONTROL.status,
      headers: POSITIVE_CONTROL.headers,
      body: POSITIVE_CONTROL.body,
      url: POSITIVE_CONTROL.url,
      method: POSITIVE_CONTROL.method,
    });
    assert.deepEqual(report.findings.map((f) => f.code), [], show(report));
    assert.equal(report.grade, 'A');
  });

  for (const endpoint of ENDPOINTS) {
    test(`this service's own 402 for ${endpoint.path} grades A with zero findings`, () => {
      // build402() is the same pure builder the Worker serves from, so this is
      // the constructed claim; test/self-lint.test.mjs asserts the same thing
      // against the bytes that actually come off wrangler.
      const built = build402(endpoint.id, '0x0000000000000000000000000000000000000001');
      const report = lint({
        status: 402,
        headers: built.headers,
        body: JSON.stringify(built.body),
        method: endpoint.method,
      });
      assert.deepEqual(report.findings.map((f) => f.code), [], show(report));
      assert.equal(report.grade, 'A');
    });
  }
});
