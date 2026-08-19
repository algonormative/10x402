// ═══════════════════════════════════════════════════════════════════════════
// THE DOGFOOD INVARIANT. This is the flagship test of this repository.
// ═══════════════════════════════════════════════════════════════════════════
//
// 10x402 sells a conformance lint of an x402 402. This file takes 10x402's OWN
// 402 — the real one, from the running Worker, in the production configuration
// — and runs it through 10x402's OWN lint engine.
//
//   IT MUST GRADE A, WITH ZERO FINDINGS. Not zero errors. ZERO FINDINGS, info
//   included.
//
// If that ever stops being true, the build fails, and it should: a conformance
// linter that does not pass its own lint is a shop with a broken sign. Every
// sentence of marketing this service could write is a claim about knowing what
// a correct envelope looks like, and this is the only test that can back it.
//
// ------------------------------------------------------------------ why it is here and not in the pure phase
//
// The engine phase could construct an envelope and lint it, and does — but a
// constructed envelope is what this repo BELIEVES it publishes. This file
// asserts on the bytes that actually came off the wire, through wrangler,
// through workerd, with real header encoding and real serialisation, in the
// phase whose vars are the production ones. The two are different claims, and
// the second is the one a buyer cares about.
//
// ------------------------------------------------------------------ what would make it fail
//
// Everything you would want to be told about, immediately:
//   - the v2 header encoded with base64url instead of standard base64
//   - a v1 field left in the v2 accepts entry after a refactor
//   - the two envelopes drifting apart on price, payTo, chain or asset
//   - the bazaar `info` and `schema` falling out of agreement
//   - a free tier being switched on (HTTP_FREE_TIER_200)
//   - the output example going stale against the report shape
//   - a new check landing that this service's own envelope does not satisfy —
//     which is the case worth dwelling on, because it is the honest one: if a
//     check is right, fix the envelope; if the envelope is right, the check is
//     wrong and a stranger is about to be told the same wrong thing.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { callers, client, decodeV2, PAYTO_TEST, useWorker } from './harness.mjs';
import { lint, CHECKS } from '../worker/lint.js';
import { build402 } from '../worker/envelope.js';
import { ENDPOINTS } from '../worker/catalog.js';

const ips = callers('self-lint');
let worker;
let api;

/**
 * The checks that CANNOT apply to a correct 402 of ours, and why.
 *
 * Not a list of checks that happen not to fire — a check that fires is a
 * finding, and the test above demands zero. These are the ones whose PRECONDITION
 * this response does not meet, so they never run at all and `checks_run` is
 * short by exactly this many.
 */
const CANNOT_APPLY = [
  // Only runs on a 200. We answer 402, which is the point.
  'HTTP_FREE_TIER_200',
  // Needs the URL the response was fetched from to compare resource.url
  // against, and the self-lint hands lint() the response without one.
  'V2_RESOURCE_URL_MATCHES',
  // Both only run in v2-only mode. We publish both envelopes.
  'V1_ABSENT',
  'V1_BODY_NOT_ENVELOPE',
  // Only runs when a report is long enough to be capped. Ours has no findings.
  'FINDINGS_TRUNCATED',
];

before(async () => {
  worker = await useWorker({ payTo: PAYTO_TEST });
  api = client(worker);
});
after(async () => {
  await worker?.stop();
});

/** Fetch this service's real 402 for an endpoint and normalise it for lint(). */
async function own402(endpoint) {
  const res = await api.post(
    endpoint.path,
    endpoint.id === 'lint' ? { url: 'https://example.com/x' } : { status: 402 },
    { ip: ips.next() }
  );
  assert.equal(res.status, 402, `${endpoint.path} did not answer its own front door: ${res.text}`);

  const headers = {};
  for (const [key, value] of res.headers) headers[key.toLowerCase()] = value;
  return { status: res.status, headers, body: res.text };
}

describe('10x402 lints itself', () => {
  for (const endpoint of ENDPOINTS) {
    test(`${endpoint.path} grades A with ZERO findings`, async () => {
      const report = lint(await own402(endpoint));

      assert.deepEqual(
        report.findings,
        [],
        `\n\n  ${endpoint.path} FAILED ITS OWN LINT.\n\n` +
          `  Either this service's envelope is wrong, or a check is wrong and a\n` +
          `  paying stranger is about to be told the same wrong thing. Do not\n` +
          `  weaken the check to make this pass without deciding which.\n\n` +
          `${JSON.stringify(report.findings, null, 2)}\n`
      );
      assert.equal(report.grade, 'A');
    });

    test(`${endpoint.path} earns that A across all but ${CANNOT_APPLY.length} of the catalogue`, async () => {
      // An A from four checks would be meaningless. This is what makes the
      // invariant a claim about the whole product rather than about a subset.
      //
      // EXACT, NOT A SLACK BOUND. This was `>= CHECKS.length - 6` for a while,
      // and a tolerance of six is six checks that could quietly stop applying
      // to our own envelope without anything failing — which is the same class
      // of green-but-empty assertion this repo exists to find in other people's
      // work. Every check that does not run is named below with the reason it
      // cannot, so adding a check forces a decision here rather than eating the
      // slack.
      const report = lint(await own402(endpoint));
      assert.equal(
        report.checks_run,
        CHECKS.length - CANNOT_APPLY.length,
        `${report.checks_run} of ${CHECKS.length} checks applied; ${CANNOT_APPLY.length} are expected not to`
      );
    });
  }
});

describe('the invariant survives the round trip through the product itself', () => {
  for (const endpoint of ENDPOINTS) {
    test(`${endpoint.path}: POST /lint/envelope on our own 402 also reports A`, async () => {
      // The strongest form available without a wallet: the real 402 goes back
      // in through the real paid endpoint (paid for here by presenting a
      // payment the facilitator cannot check, which is served
      // availability-first and is honest about it) and comes back graded.
      //
      // This closes the loop the pure test cannot: engine, Worker, HTTP
      // serialisation, JSON round trip and header handling, all in the path.
      const own = await own402(endpoint);
      const res = await api.lintEnvelope(
        { status: own.status, headers: own.headers, body: own.body },
        {
          ip: ips.next(),
          // Structurally valid, cryptographically worthless, and no facilitator
          // is configured on this worker — so the call is served with
          // x-payment-verified: false, which is exactly what the chassis
          // promises and what makes this reachable without money.
          headers: { 'x-payment': Buffer.from(JSON.stringify({ x402Version: 1, payload: {} })).toString('base64') },
        }
      );

      assert.equal(res.status, 200, res.text);
      assert.equal(res.headers.get('x-payment-verified'), 'false');
      assert.equal(res.headers.get('x-payment-error'), 'facilitator-unconfigured');
      assert.deepEqual(res.body.findings, [], JSON.stringify(res.body.findings, null, 2));
      assert.equal(res.body.grade, 'A');
    });
  }
});

describe('the constructed envelope and the served one are the same envelope', () => {
  // build402() is what the self-lint in the pure phase and build.mjs both use.
  // If it drifted from what the Worker serves, every claim made from it would
  // be about a different service.
  for (const endpoint of ENDPOINTS) {
    test(`${endpoint.path}`, async () => {
      const served = await own402(endpoint);
      const constructed = build402(endpoint.id, PAYTO_TEST, {
        error: 'X-PAYMENT header is required',
        v2Error: 'Payment required',
      });

      assert.equal(
        served.headers['payment-required'],
        constructed.headers['payment-required'],
        'the served v2 envelope differs from the constructed one, byte for byte'
      );
      assert.deepEqual(JSON.parse(served.body), constructed.body);
    });
  }
});

describe('the specific things this service would be most embarrassing to get wrong', () => {
  test('its own v2 header is standard base64', async () => {
    for (const endpoint of ENDPOINTS) {
      const header = (await own402(endpoint)).headers['payment-required'];
      assert.match(header, /^[A-Za-z0-9+/]*={0,2}$/, `${endpoint.path}`);
      assert.ok(!/[-_]/.test(header), `${endpoint.path} publishes a base64url envelope`);
    }
  });

  test('its own bazaar info validates against its own bazaar schema', async () => {
    const { validateAgainstSchema } = await import('../worker/json-schema.js');
    for (const endpoint of ENDPOINTS) {
      const env = decodeV2((await own402(endpoint)).headers['payment-required']);
      const { info, schema } = env.extensions.bazaar;
      assert.deepEqual(validateAgainstSchema(info, schema), [], `${endpoint.path}`);
    }
  });

  test('its own payTo is a real address shape, in both envelopes', async () => {
    // The chassis this is adapted from used a payTo placeholder that was not
    // 40 hex characters. Harmless there; here it would fail V1_PAYTO/V2_PAYTO
    // and take the flagship invariant down for a reason with nothing to do
    // with the product. Asserted so the reason stays visible.
    for (const endpoint of ENDPOINTS) {
      const own = await own402(endpoint);
      const v1 = JSON.parse(own.body).accepts[0];
      const v2 = decodeV2(own.headers['payment-required']);
      assert.match(v1.payTo, /^0x[0-9a-fA-F]{40}$/);
      assert.match(v2.accepts[0].payTo, /^0x[0-9a-fA-F]{40}$/);
    }
  });

  test('it answers 402 to an unauthenticated caller, so it passes its own free-tier check', async () => {
    const report = lint(await own402(ENDPOINTS[0]));
    assert.ok(!report.findings.some((f) => f.code === 'HTTP_FREE_TIER_200'));
  });

  test('its own 402 is not behind a redirect', async () => {
    const report = lint(await own402(ENDPOINTS[0]));
    assert.ok(!report.findings.some((f) => f.code === 'HTTP_REDIRECT'));
  });
});
