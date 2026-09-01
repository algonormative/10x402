// Real payment verification and settlement, against a MOCK CDP facilitator.
//
// This suite is the one that proves the paid path is a PAYMENT path rather than
// a header check. It boots its own Worker — PAYTO set, structurally real (and
// worthless) CDP credentials, FACILITATOR_URL pointing at an http server this
// file runs — so every assertion is about what the Worker actually sent and
// what it did with the answer.
//
// NOTHING HERE IS BILLED, AND NOTHING HERE LEAVES 127.0.0.1. There is no live
// facilitator, no chain, no wallet and no money; the mock is in-process, the
// credentials are generated per run, and the one test that needs POST /lint to
// serve a real report points it at a local 402 this file also runs.
//
// Four things are worth knowing before reading further.
//
// 1. THE MOCK IS PROGRAMMABLE AND RECORDS EVERY HIT. That is what makes the
//    NEGATIVE assertions possible: "the facilitator was not called" is
//    `mock.hits.length === 0`, not an inference from a response header.
//
// 2. THE JWT IS REAL. The Worker signs an Ed25519 CDP bearer token with
//    WebCrypto inside workerd; the mock structure-checks the header and claims.
//    It deliberately does NOT verify the signature — that would be testing
//    Ed25519, not the Worker — but a Worker that failed to sign would produce
//    no Authorization header at all, and these assertions would catch it.
//
// 3. SETTLEMENT IS ASYNCHRONOUS. It runs in ctx.waitUntil AFTER the response,
//    so the ledger assertions poll rather than read once.
//
// 4. THE MOCK IS STRICT ABOUT VERSION SHAPE. v1 and v2 send the same
//    three-field body to the same endpoint and differ entirely in the shapes
//    inside it, so a Worker that shipped a v1 envelope alongside a v2 payload
//    would look completely healthy against a mock that only echoes canned
//    answers — and would verify as invalid against the real facilitator, which
//    recovers the signature from what it is handed. Every hit is shape-checked
//    against its own declared version and a mismatch answers 400. Drift is
//    meant to be loud.

import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { bootWorker, callers, client, fakeCdpCredentials, isSqlNull, PAYTO_TEST } from './harness.mjs';
import { ENDPOINTS, ENDPOINTS_BY_ID } from '../worker/catalog.js';
import { atomicAmount } from '../worker/envelope.js';
import { startMockFacilitator, TX_HASH, VERIFIED_PAYER } from './mock-facilitator.mjs';

const ips = callers('settlement');

// The prices a payer signs against, taken from the catalogue rather than typed:
// what a payment authorises and what the ledger records must both be whatever
// the 402 quoted, and a literal here would keep passing after a re-price while
// the Worker quoted something else. The literal atomic values are asserted once,
// on purpose, in test/single-check.test.mjs.
const LINT_PRICE = atomicAmount(ENDPOINTS_BY_ID.get('lint').price_usd);
const ENVELOPE_PRICE = atomicAmount(ENDPOINTS_BY_ID.get('lint-envelope').price_usd);
const ENVELOPE_ONE_PRICE = atomicAmount(ENDPOINTS_BY_ID.get('lint-envelope-one').price_usd);

// VERIFIED_PAYER and TX_HASH are what the mock hands back, so the ledger
// assertions can prove the values came from the FACILITATOR rather than from
// the payload the caller sent. They live with the mock now — see the note at
// the top of mock-facilitator.mjs — because the Solana suite drives the same
// upstream and two hand-written copies would be two definitions of it.
const CLAIMED_PAYER = '0x000000000000000000000000000000000000Bad1';

let worker;
let api;
let mock;
let lintTarget;

// ------------------------------------------------------------------ helpers

/**
 * A NONCE, freshly random per authorization — which is what an EIP-3009 nonce
 * is, and what a real client does.
 *
 * It was a constant here until one payment buying one report became a rule the
 * Worker enforces, at which point two tests that happened to run inside the
 * same second were sending the byte-identical payment and the second was
 * correctly refused. A fixed nonce was never realistic: on chain it is what
 * makes an authorization single-use.
 */
const freshNonce = () => `0x${randomBytes(32).toString('hex')}`;

/**
 * A well-formed x402 v1 payment payload, base64 as X-PAYMENT.
 *
 * The signature is nonsense — the mock decides valid from invalid, so a real
 * one would prove nothing and would need a funded key. The SHAPE is real,
 * because the Worker reads `payload.authorization.from` out of it.
 */
function paymentHeaderV1({ from = CLAIMED_PAYER, value = ENVELOPE_PRICE } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: {
        signature: `0x${'ab'.repeat(65)}`,
        authorization: {
          from,
          to: PAYTO_TEST,
          value,
          validAfter: String(now - 600),
          validBefore: String(now + 60),
          nonce: freshNonce(),
        },
      },
    })
  ).toString('base64');
}

/** The v2 envelope this Worker publishes for an endpoint, read off its own 402. */
async function v2EnvelopeFor(path, ip) {
  const probe = await api.post(path, { status: 402 }, { ip });
  assert.equal(probe.status, 402, `${path} did not answer the 402 front door: ${probe.text}`);
  const header = probe.headers.get('payment-required');
  assert.ok(header, `${path} published no v2 envelope`);
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

/**
 * A well-formed x402 v2 payment, base64 as PAYMENT-SIGNATURE.
 *
 * Built FROM the Worker's own 402 rather than typed out here, which is what a
 * real client does and is the only version that stays true: `accepted` has to
 * be the accepts entry we advertised, or the signature was made over something
 * else.
 */
async function paymentHeaderV2(path, { ip, from = CLAIMED_PAYER } = {}) {
  const env = await v2EnvelopeFor(path, ip);
  const accepted = env.accepts[0];
  const now = Math.floor(Date.now() / 1000);
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: env.resource,
      accepted,
      payload: {
        signature: `0x${'ab'.repeat(65)}`,
        authorization: {
          from,
          to: accepted.payTo,
          value: accepted.amount,
          validAfter: String(now - 600),
          validBefore: String(now + accepted.maxTimeoutSeconds),
          nonce: freshNonce(),
        },
      },
      extensions: env.extensions,
    })
  ).toString('base64');
}

const settlements = () =>
  worker.d1(
    'SELECT ts, endpoint, payer, amount, verify_ok, settle_ok, tx_hash, error FROM settlements ORDER BY ts, rowid;'
  );

/** Settlement runs in ctx.waitUntil, so the ledger is polled rather than read. */
async function awaitSettlement(predicate, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await settlements();
    const hit = rows.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`no settlements row matching ${what} within ${timeoutMs} ms; saw ${JSON.stringify(rows)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const paid = (path, payload, header, ip) =>
  api.post(path, payload, { ip, headers: header });

/**
 * A local 402, for the one test that needs POST /lint to actually SERVE a report.
 *
 * That test used to name `https://example.com/x`, which the production guard
 * accepts — so the Worker really did fetch example.com, and the test passed
 * only because the internet was up. A live call inside a suite whose whole
 * claim is that it makes none: it would have failed on a plane, and it made the
 * README's "no live network calls, ever" untrue while reading as proof of it.
 */
async function startLintTarget() {
  const body = JSON.stringify({
    x402Version: 1,
    accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '1000', resource: 'https://example.com/x' }],
  });
  const server = http.createServer((_req, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/x`,
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}

// ------------------------------------------------------------------ lifecycle

before(async () => {
  mock = await startMockFacilitator();
  lintTarget = await startLintTarget();
  worker = await bootWorker({
    // LINT_UNSAFE_TARGETS so POST /lint can reach the local target above. This
    // suite asserts nothing about the SSRF guard — test/ssrf-worker.test.mjs
    // does that, in a phase where the guard is deliberately left as shipped.
    vars: {
      PAYTO: PAYTO_TEST,
      FACILITATOR_URL: mock.url,
      LINT_UNSAFE_TARGETS: '1',
      ...fakeCdpCredentials(),
    },
  });
  api = client(worker);
});

after(async () => {
  await worker?.stop();
  await mock?.stop();
  await lintTarget?.stop();
});

beforeEach(() => mock.reset());

// ------------------------------------------------------------------ tests

describe('an unpaid call never reaches the facilitator', () => {
  test('no payment header means no verify, no settle, no ledger row', async () => {
    // With nothing presented there is nothing to verify, so the facilitator
    // must not be called AT ALL. Zero hits is the assertion — not a header.
    const res = await api.lintEnvelope({ status: 402 }, { ip: ips.pinned(1) });
    assert.equal(res.status, 402);
    assert.equal(mock.hits.length, 0);
  });
});

describe('x402 v1: a verified payment', () => {
  test('is verified, served, and settled after the response', async () => {
    const ip = ips.next();
    const res = await paid('/lint/envelope', { status: 402 }, { 'x-payment': paymentHeaderV1() }, ip);

    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('x-payment-verified'), 'true');
    assert.ok(res.body.grade, 'the report is the product and it must still be there');
    assert.equal(mock.problems(), '', 'the facilitator was sent a malformed body');

    const verify = mock.hitsOn('verify');
    assert.equal(verify.length, 1);
    assert.equal(verify[0].version, 1);
    assert.equal(verify[0].body.paymentRequirements.maxAmountRequired, ENVELOPE_PRICE);
    assert.equal(verify[0].body.paymentRequirements.network, 'base');

    const row = await awaitSettlement((r) => Number(r.settle_ok) === 1, 'a settled v1 payment');
    assert.equal(row.endpoint, 'lint-envelope');
    assert.equal(row.amount, ENVELOPE_PRICE);
    assert.equal(Number(row.verify_ok), 1);
    assert.equal(row.tx_hash, TX_HASH);
    // The payer recorded is the FACILITATOR's, not the one the caller claimed.
    assert.equal(row.payer.toLowerCase(), VERIFIED_PAYER.toLowerCase());
    assert.ok(isSqlNull(row.error));
  });

  test('the settle body carries our own resource, which a v1 client need not echo', async () => {
    // A discovery index attaches a settlement to a listing by reading
    // `resource` off the settle body, and x402-fetch does not send one — so a
    // settlement from an ordinary client would index against nothing.
    await paid('/lint/envelope', { status: 402 }, { 'x-payment': paymentHeaderV1() }, ips.next());
    await awaitSettlement((r) => Number(r.settle_ok) === 1, 'a settlement');

    const settle = mock.hitsOn('settle');
    assert.equal(settle.length, 1);
    assert.equal(settle[0].body.paymentPayload.resource, 'https://10x402.com/lint/envelope');
    // And NOT on verify: verify is the signature check, and the payload it sees
    // stays byte-for-byte what arrived.
    assert.equal(mock.hitsOn('verify')[0].body.paymentPayload.resource, undefined);
  });

  test('the CDP JWT is real, and bound to the call it authorises', async () => {
    await paid('/lint/envelope', { status: 402 }, { 'x-payment': paymentHeaderV1() }, ips.next());
    await awaitSettlement((r) => Number(r.settle_ok) === 1, 'a settlement');

    for (const hit of mock.hits) {
      assert.ok(hit.authorization, `${hit.endpoint} carried no Authorization`);
      const [scheme, token] = hit.authorization.split(' ');
      assert.equal(scheme, 'Bearer');
      const [header, claims] = token.split('.').slice(0, 2).map((seg) => JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')));
      assert.equal(header.alg, 'EdDSA');
      assert.ok(header.nonce, 'no nonce — a replayable token');
      assert.equal(claims.iss, 'cdp');
      // The `uris` claim names the exact endpoint, so a token minted for
      // /verify cannot be replayed at /settle.
      assert.equal(claims.uris.length, 1);
      assert.match(claims.uris[0], new RegExp(`POST 127\\.0\\.0\\.1:\\d+/platform/v2/x402/${hit.endpoint}$`));
      assert.ok(claims.exp > claims.iat, 'the token does not expire');
    }
  });
});

describe('x402 v2: a verified payment', () => {
  test('is verified against the v2 SHAPES, served, and settled', async () => {
    const ip = ips.next();
    const header = await paymentHeaderV2('/lint/envelope', { ip });
    mock.reset();

    const res = await paid('/lint/envelope', { status: 402 }, { 'payment-signature': header }, ip);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('x-payment-verified'), 'true');
    assert.equal(mock.problems(), '', 'the v2 call was not v2-shaped');

    const verify = mock.hitsOn('verify')[0];
    assert.equal(verify.version, 2);
    assert.equal(verify.body.paymentRequirements.network, 'eip155:8453');
    assert.equal(verify.body.paymentRequirements.amount, ENVELOPE_PRICE);
    assert.equal(verify.body.paymentRequirements.maxAmountRequired, undefined);
    assert.equal(verify.body.paymentRequirements.resource, undefined);

    const row = await awaitSettlement((r) => Number(r.settle_ok) === 1, 'a settled v2 payment');
    assert.equal(row.tx_hash, TX_HASH);
  });

  test('the settle body completes `resource` with the v2 OBJECT, not the v1 string', async () => {
    const ip = ips.next();
    const header = await paymentHeaderV2('/lint', { ip });
    mock.reset();

    // A v2 client built by @x402/core echoes the resource back already, so
    // strip it to exercise the backstop for one that does not.
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    delete decoded.resource;
    const stripped = Buffer.from(JSON.stringify(decoded)).toString('base64');

    await paid('/lint', { url: lintTarget.url }, { 'payment-signature': stripped }, ip);
    await awaitSettlement((r) => r.endpoint === 'lint', 'a lint settlement');

    const sent = mock.hitsOn('settle')[0].body.paymentPayload.resource;
    assert.equal(typeof sent, 'object', 'a v2 settle got the v1 string form');
    assert.equal(sent.url, 'https://10x402.com/lint');
    assert.equal(sent.method, 'POST');
  });

  test('the version is read from the PAYLOAD, not from the header it arrived in', async () => {
    // A client that puts a v2 payload in the old X-PAYMENT header must still be
    // verified with v2 shapes. The mock's strictness is what turns this into a
    // testable claim rather than a hope.
    const ip = ips.next();
    const header = await paymentHeaderV2('/lint/envelope', { ip });
    mock.reset();

    const res = await paid('/lint/envelope', { status: 402 }, { 'x-payment': header }, ip);
    assert.equal(res.status, 200, res.text);
    assert.equal(mock.hitsOn('verify')[0].version, 2);
    assert.equal(mock.problems(), '');
  });
});

describe('the mock’s strictness has teeth', () => {
  test('turning enforcement off changes the outcome, which proves it was on', async () => {
    // A strictness nothing ever trips is indistinguishable from no strictness.
    // This deliberately sends a v1 payload declaring itself v2 and checks that
    // the mock notices, then that it does not when told not to.
    const bad = Buffer.from(
      JSON.stringify({ x402Version: 2, scheme: 'exact', network: 'base', payload: {} })
    ).toString('base64');

    const strict = await paid('/lint/envelope', { status: 402 }, { 'payment-signature': bad }, ips.next());
    assert.notEqual(mock.problems(), '', 'the mock accepted a malformed v2 payload');
    // A 400 from the facilitator reads as an outage, so the call is served
    // unverified — availability-first — and recorded.
    assert.equal(strict.status, 200);
    assert.equal(strict.headers.get('x-payment-verified'), 'false');
    assert.match(strict.headers.get('x-payment-error'), /unreachable/);

    mock.reset();
    mock.state.strict = false;
    const lax = await paid('/lint/envelope', { status: 402 }, { 'payment-signature': bad }, ips.next());
    assert.equal(lax.headers.get('x-payment-verified'), 'true', 'the same payload was not waved through');
  });
});

describe('a rejected payment', () => {
  test('answers 402 with the reason, serves nothing, and settles nothing', async () => {
    mock.state.verify = {
      status: 200,
      body: { isValid: false, invalidReason: 'insufficient_funds', invalidMessage: 'the wallet is empty' },
    };

    const res = await paid('/lint/envelope', { status: 402 }, { 'x-payment': paymentHeaderV1() }, ips.next());
    assert.equal(res.status, 402);
    assert.equal(res.body.invalidReason, 'insufficient_funds');
    assert.equal(res.body.invalidMessage, 'the wallet is empty');
    assert.equal(res.body.grade, undefined, 'a rejected payment was served a report');
    assert.equal(mock.hitsOn('settle').length, 0);

    const rows = await settlements();
    const row = rows.at(-1);
    assert.equal(row.error, 'insufficient_funds');
    assert.equal(Number(row.verify_ok), 0);
    assert.equal(Number(row.settle_ok), 0);
  });

  test('the 402 it answers with is still a complete, payable envelope', async () => {
    // A rejection is not a dead end: the caller needs the terms to sign against
    // on the retry.
    mock.state.verify = { status: 200, body: { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' } };
    const res = await paid('/lint/envelope', { status: 402 }, { 'x-payment': paymentHeaderV1() }, ips.next());
    assert.ok(res.body.accepts[0].payTo);
    assert.ok(res.headers.get('payment-required'));
  });
});

describe('the facilitator being down', () => {
  test('serves the report anyway, says nothing was checked, and records it', async () => {
    // Availability-first, on purpose: at these prices the number is a signal,
    // and turning paying callers away for OUR dependency's outage is the worse
    // failure. What must never happen is claiming a payment was verified.
    mock.state.verify = { status: 503, body: { error: 'down' } };

    const res = await paid('/lint/envelope', { status: 402 }, { 'x-payment': paymentHeaderV1() }, ips.next());
    assert.equal(res.status, 200);
    assert.ok(res.body.grade);
    assert.equal(res.headers.get('x-payment-verified'), 'false');
    assert.equal(res.headers.get('x-payment-error'), 'facilitator-unreachable');
    assert.equal(res.headers.get('x-pricing'), 'pending');

    const row = (await settlements()).at(-1);
    assert.equal(row.error, 'facilitator-http-503');
    assert.equal(Number(row.verify_ok), 0);
    assert.equal(mock.hitsOn('settle').length, 0);
  });

  test('a verify timeout is bounded and recorded distinctly from an outage', async () => {
    mock.state.delayMs.verify = 4000; // VERIFY_TIMEOUT_MS is 2s
    const started = Date.now();
    const res = await paid('/lint/envelope', { status: 402 }, { 'x-payment': paymentHeaderV1() }, ips.next());
    const elapsed = Date.now() - started;

    assert.equal(res.status, 200);
    assert.ok(elapsed < 3500, `verify took ${elapsed}ms — the 2s cap did not hold`);
    const row = (await settlements()).at(-1);
    assert.equal(row.error, 'facilitator-timeout');
  });
});

describe('settlement failing after a verified payment', () => {
  test('the caller keeps the report; the ledger records the loss', async () => {
    // The accepted exposure: one report served for a payment that never arrived.
    // It is recorded rather than hidden, because a run of these is the alarm.
    mock.state.settle = { status: 200, body: { success: false, errorReason: 'nonce_already_used' } };

    const res = await paid('/lint/envelope', { status: 402 }, { 'x-payment': paymentHeaderV1() }, ips.next());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-payment-verified'), 'true', 'verify DID say yes, and saying otherwise would be a lie');

    const row = await awaitSettlement((r) => r.error === 'nonce_already_used', 'a failed settlement');
    assert.equal(Number(row.verify_ok), 1);
    assert.equal(Number(row.settle_ok), 0);
    assert.ok(isSqlNull(row.tx_hash));
  });
});

describe('payment fairness: nobody is charged for work that was not served', () => {
  test('a verified payment on a request that then 400s settles nothing', async () => {
    // The rule the service would be most unforgivable for breaking. A verified
    // authorization moves nothing until someone submits it, and here nobody
    // does — so the buyer whose input we could not lint is simply not charged.
    // The ledger is CUMULATIVE across this suite — earlier tests settled real
    // (mock) payments on purpose — so the assertion is a delta. Comparing the
    // absolute count is what a first draft of this test did, and it failed
    // against seven perfectly correct rows.
    const settledBefore = (await settlements()).filter((r) => Number(r.settle_ok) === 1).length;

    const res = await paid('/lint/envelope', { notAStatus: true }, { 'x-payment': paymentHeaderV1() }, ips.next());
    assert.equal(res.status, 400, res.text);

    // Give the deferred work every chance to have happened.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(mock.hitsOn('settle').length, 0, 'a settlement was submitted for work that was never served');
    const settledAfter = (await settlements()).filter((r) => Number(r.settle_ok) === 1).length;
    assert.equal(settledAfter, settledBefore, 'the ledger gained a settlement for a request that 400d');
  });

  test('an unreachable lint target also settles nothing', async () => {
    const res = await paid(
      '/lint',
      { url: 'https://x402-settlement-probe.invalid/x' },
      { 'x-payment': paymentHeaderV1({ value: LINT_PRICE }) },
      ips.next()
    );
    assert.equal(res.status, 400, res.text);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(mock.hitsOn('settle').length, 0);
  });

  test('but a SERVED report does settle, which is what makes the above a rule and not a bug', async () => {
    const res = await paid('/lint/envelope', { status: 402 }, { 'x-payment': paymentHeaderV1() }, ips.next());
    assert.equal(res.status, 200);
    await awaitSettlement((r) => Number(r.settle_ok) === 1, 'the control settlement');
  });

  test('an unknown check id settles nothing and gives the payment back', async () => {
    // THE NEW WAY TO SPEND MONEY ON NOTHING, and the reason the validation
    // happens before any work: a caller who mistypes a check id has bought no
    // answer, so the authorization must survive to buy a real one. Asserted as
    // a retry with the SAME header, which is the only proof that means anything
    // — a released claim that cannot be re-spent is not released.
    const header = paymentHeaderV1({ value: ENVELOPE_ONE_PRICE });
    const settledBefore = (await settlements()).filter((r) => Number(r.settle_ok) === 1).length;

    const typo = await paid(
      '/lint/envelope/one',
      { status: 402, check: 'V2_B64_URLSAF' },
      { 'x-payment': header },
      ips.next()
    );
    assert.equal(typo.status, 400, typo.text);
    assert.match(typo.body.error, /no check "V2_B64_URLSAF"/);

    await new Promise((r) => setTimeout(r, 1500));
    const settledAfter = (await settlements()).filter((r) => Number(r.settle_ok) === 1).length;
    assert.equal(settledAfter, settledBefore, 'a typo in a check id settled a payment');

    const retry = await paid(
      '/lint/envelope/one',
      { status: 402, check: 'V2_HEADER_PRESENT' },
      { 'x-payment': header },
      ips.next()
    );
    assert.equal(retry.status, 200, `the payment was burned by an unknown check id: ${retry.text}`);
    assert.equal(retry.body.check, 'V2_HEADER_PRESENT');
  });
});

describe('the single-check routes settle their own price', () => {
  test('a served single check settles the single-check amount, under its own endpoint id', async () => {
    // The ledger has to be able to tell a $0.004 answer from a $0.10 report:
    // `endpoint` and `amount` are what the revenue queries in the README group
    // by, and eight routes at eight prices through one settle path is exactly
    // where those two could quietly come from the wrong endpoint.
    const res = await paid(
      '/lint/envelope/one',
      { status: 402, check: 'V2_HEADER_PRESENT' },
      { 'x-payment': paymentHeaderV1({ value: ENVELOPE_ONE_PRICE }) },
      ips.next()
    );
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('x-payment-verified'), 'true');
    assert.equal(res.body.check, 'V2_HEADER_PRESENT');
    assert.equal(res.body.grade, undefined, 'a single-check answer must not carry a whole-report grade');

    const verify = mock.hitsOn('verify').at(-1);
    assert.equal(verify.body.paymentRequirements.maxAmountRequired, ENVELOPE_ONE_PRICE);

    const row = await awaitSettlement(
      (r) => r.endpoint === 'lint-envelope-one' && Number(r.settle_ok) === 1,
      'a settled single-check payment'
    );
    assert.equal(row.amount, ENVELOPE_ONE_PRICE);
    assert.equal(row.amount, '4000', '$0.004 of a 6-decimal USDC');
  });

  test('every route quotes its OWN distinct amount, in both envelopes', async () => {
    // THE PRICE IS THE ATTRIBUTION MECHANISM. A settlement seen from a bare
    // chain explorer shows an amount and little else, so two routes sharing a
    // price would make their revenue indistinguishable. The whole sheet is
    // walked here rather than four hand-listed rows, so a route added tomorrow
    // is covered the day it lands — and the uniqueness is asserted, not assumed.
    const quoted = {};
    for (const endpoint of ENDPOINTS) {
      const quote = await paid(endpoint.path, {}, {}, ips.next());
      assert.equal(quote.status, 402, `${endpoint.path}: ${quote.text}`);
      const atomic = atomicAmount(endpoint.price_usd);
      assert.equal(quote.body.accepts[0].maxAmountRequired, atomic, `${endpoint.path} v1 amount`);
      const v2 = JSON.parse(Buffer.from(quote.headers.get('payment-required'), 'base64').toString('utf8'));
      assert.equal(v2.accepts[0].amount, atomic, `${endpoint.path} v2 amount`);
      quoted[endpoint.path] = atomic;
    }
    assert.equal(
      new Set(Object.values(quoted)).size,
      Object.keys(quoted).length,
      `two routes quote the same amount: ${JSON.stringify(quoted)}`
    );
  });
});

describe('one payment buys one report', () => {
  test('the same header twice: the first is served, the second is 402', async () => {
    // VERIFYING A PAYMENT IS A READ. The facilitator says the signature is good
    // and the funds are there, and says the same thing every time it is asked;
    // nothing moves until settle, and settle runs after the response. So one
    // paid header replayed bought a report every time, bounded only by the
    // per-caller ceiling — which is per IP, and therefore not a bound at all
    // for anyone with more than one address.
    const header = paymentHeaderV1();
    const settledBefore = (await settlements()).length;

    const first = await paid('/lint/envelope', { status: 402 }, { 'x-payment': header }, ips.next());
    assert.equal(first.status, 200, first.text);
    assert.equal(first.headers.get('x-payment-verified'), 'true');
    assert.ok(first.body.grade);

    // A different caller, so the per-IP ceiling is provably not what refuses it.
    const second = await paid('/lint/envelope', { status: 402 }, { 'x-payment': header }, ips.next());
    assert.equal(second.status, 402, second.text);
    assert.equal(second.body.invalidReason, 'payment_already_used');
    assert.equal(second.body.grade, undefined, 'a replayed payment was served a report');
    // The 402 is still a complete, payable envelope: the caller needs terms to
    // sign a fresh authorization against.
    assert.ok(second.body.accepts[0].payTo);

    await awaitSettlement((r) => Number(r.settle_ok) === 1, 'the first payment settling');
    await new Promise((r) => setTimeout(r, 1000));
    const rows = (await settlements()).slice(settledBefore);
    assert.equal(rows.length, 1, `${rows.length} ledger rows for one payment: ${JSON.stringify(rows)}`);
    assert.equal(mock.hitsOn('settle').length, 1, 'the replay was settled a second time');
  });

  test('concurrent replays of one payment serve exactly one report', async () => {
    // The claim is an INSERT rather than a read-then-write precisely because
    // the attack is concurrent: eight requests in flight at once would all pass
    // a "have we seen this?" read before any of them wrote.
    const header = paymentHeaderV1();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => paid('/lint/envelope', { status: 402 }, { 'x-payment': header }, ips.next()))
    );
    const served = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status === 402);
    assert.equal(served.length, 1, `${served.length} of 8 concurrent replays were served`);
    assert.equal(refused.length, 7);
    for (const res of refused) assert.equal(res.body.invalidReason, 'payment_already_used');
  });

  test('a request that gets no report gives the payment back', async () => {
    // THE RULE AT THE TOP OF worker.js: nobody is charged for a lint that was
    // not served, and a payment CONSUMED is a charge whether or not a
    // settlement followed it. The single-use claim is taken before the request
    // body has even been read, so without a compensating release every typo
    // between here and the report — an empty body, bad JSON, a missing `url`,
    // an unreachable target — permanently spent the caller's authorization and
    // answered their retry with "this payment has already bought a report",
    // which would have been false.
    const header = paymentHeaderV1();

    const typo = await paid('/lint/envelope', { notAStatus: true }, { 'x-payment': header }, ips.next());
    assert.equal(typo.status, 400, typo.text);

    const retry = await paid('/lint/envelope', { status: 402 }, { 'x-payment': header }, ips.next());
    assert.equal(retry.status, 200, `the payment was burned by a 400: ${retry.text}`);
    assert.equal(retry.headers.get('x-payment-verified'), 'true');
    assert.ok(retry.body.grade);
  });

  test('an unreachable lint target gives the payment back too', async () => {
    // The same rule on the other endpoint, where the failure happens after the
    // outbound fetch rather than during input validation.
    const header = paymentHeaderV1({ value: LINT_PRICE });

    const dead = await paid(
      '/lint',
      { url: 'https://x402-release-probe.invalid/x' },
      { 'x-payment': header },
      ips.next()
    );
    assert.equal(dead.status, 400, dead.text);

    const retry = await paid('/lint', { url: lintTarget.url }, { 'x-payment': header }, ips.next());
    assert.equal(retry.status, 200, `the payment was burned by an unreachable target: ${retry.text}`);
    assert.ok(retry.body.grade);
  });

  test('but a payment that DID buy a report stays spent', async () => {
    // The control. Releasing on failure must not become releasing on success,
    // which would put the replay back.
    const header = paymentHeaderV1();
    assert.equal((await paid('/lint/envelope', { status: 402 }, { 'x-payment': header }, ips.next())).status, 200);
    const replay = await paid('/lint/envelope', { status: 402 }, { 'x-payment': header }, ips.next());
    assert.equal(replay.status, 402);
    assert.equal(replay.body.invalidReason, 'payment_already_used');
  });

  test('a payment that did NOT verify does not burn the hash', async () => {
    // Otherwise anyone could spend a stranger's payment by presenting it while
    // the facilitator was down: the claim would be taken, and the real buyer
    // would be told their own payment was already used.
    mock.state.verify = { status: 503, body: { error: 'down' } };
    const header = paymentHeaderV1();

    const unverified = await paid('/lint/envelope', { status: 402 }, { 'x-payment': header }, ips.next());
    assert.equal(unverified.status, 200);
    assert.equal(unverified.headers.get('x-payment-verified'), 'false');

    mock.state.verify = { status: 200, body: { isValid: true, payer: VERIFIED_PAYER } };
    const verified = await paid('/lint/envelope', { status: 402 }, { 'x-payment': header }, ips.next());
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.headers.get('x-payment-verified'), 'true', 'the hash was burned by an unverified attempt');
  });
});

describe('the verify quota bounds the facilitator calls a stranger can cause', () => {
  // Every verify is an outbound POST carrying a freshly signed Ed25519 JWT, and
  // a payload that merely DECODES costs the sender nothing to produce. Without
  // a bound on the attempt — not on the outcome — that is an unbounded outbound
  // amplifier reachable by anyone with a socket.
  //
  // Its own worker, because the ceiling has to be small enough to exhaust in a
  // few calls and a low ceiling shared with the suite above would refuse
  // payments those tests are asserting get through.
  let capped;
  let cappedApi;

  before(async () => {
    capped = await bootWorker({
      vars: { PAYTO: PAYTO_TEST, FACILITATOR_URL: mock.url, VERIFY_DAILY: '2', ...fakeCdpCredentials() },
    });
    cappedApi = client(capped);
  });
  after(async () => {
    await capped?.stop();
  });

  test('past the ceiling: 429, no facilitator call, no ledger row', async () => {
    mock.reset();
    const ip = ips.pinned(9);
    const send = () =>
      cappedApi.lintEnvelope({ status: 402 }, { ip, headers: { 'x-payment': paymentHeaderV1() } });

    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    assert.equal(mock.hitsOn('verify').length, 2);

    const over = await send();
    assert.equal(over.status, 429, over.text);
    assert.equal(over.headers.get('x-payment-verified'), 'false');
    assert.ok(Number(over.headers.get('retry-after')) > 0, 'no Retry-After on a limit that resets');
    assert.match(over.body.error, /payment-verification limit/);

    // THE LOAD-BEARING NEGATIVE. Not a header, not an inference: the mock
    // counted, and it counted two.
    assert.equal(mock.hitsOn('verify').length, 2, 'the over-quota call reached the facilitator anyway');

    const rows = await capped.d1('SELECT COUNT(*) AS n FROM settlements;');
    assert.equal(Number(rows[0].n), 2, 'the over-quota call wrote a ledger row');
  });

  test('it is per caller, so one exhausted caller cannot refuse another', async () => {
    const other = await cappedApi.lintEnvelope(
      { status: 402 },
      { ip: ips.pinned(10), headers: { 'x-payment': paymentHeaderV1() } }
    );
    assert.equal(other.status, 200, other.text);
  });

  test('it is not a 402, because paying again would not help', async () => {
    // A 402 means "pay and try again". This caller's next payment will not be
    // checked either, so a 402 here would be an invitation to spend money on a
    // call that cannot succeed.
    const ip = ips.pinned(11);
    for (let i = 0; i < 2; i++) {
      await cappedApi.lintEnvelope({ status: 402 }, { ip, headers: { 'x-payment': paymentHeaderV1() } });
    }
    const over = await cappedApi.lintEnvelope(
      { status: 402 },
      { ip, headers: { 'x-payment': paymentHeaderV1() } }
    );
    assert.equal(over.status, 429);
    assert.equal(over.headers.get('payment-required'), null, 'a 429 published payment terms');
  });
});

describe('the response never carries a receipt it does not have', () => {
  test('there is no PAYMENT-RESPONSE header, and its absence is honest', async () => {
    // In v2 that header is a settlement RECEIPT, and settlement is deliberately
    // queued behind the response. Emitting one with success: true and an empty
    // transaction would be a receipt for a payment that has not happened — the
    // first fake thing this service would say.
    const res = await paid('/lint/envelope', { status: 402 }, { 'x-payment': paymentHeaderV1() }, ips.next());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('payment-response'), null);
    assert.equal(res.headers.get('x-payment-verified'), 'true');
  });
});
