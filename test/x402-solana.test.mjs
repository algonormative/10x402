// The second rail: USDC on Solana, alongside USDC on Base.
//
// PHASE: standalone. Every worker here needs a FACILITATOR_URL pointing at a
// mock on a port only learned at startup, and several need DIFFERENT vars from
// each other (PAYTO_SOLANA set, unset, and a /supported that fails), so the file
// boots what it needs and tears it down.
//
// NOTHING HERE IS BILLED AND NOTHING LEAVES 127.0.0.1: the facilitator is the
// in-process mock, the CDP credentials are generated per run, and every paid
// route exercised is one of the PASTED-envelope routes, which make no outbound
// request of their own.
//
// FIVE CLAIMS, and they are the five ways a second rail goes wrong.
//
// 1. THE GATE HOLDS. With PAYTO_SOLANA unset the envelope is byte-identical to
//    the single-rail one — asserted as a whole-object deep-equal, not as "there
//    is no solana string in it". A rail that quietly perturbed the rail with real
//    settlements on it would be the expensive regression.
//
// 2. BOTH ENTRIES ARE OFFERED, BASE FIRST, at the same price. A buyer takes the
//    first entry it can pay; Base is the rail with a settlement history, so it
//    leads in both the v1 body and the v2 header.
//
// 3. REQUIREMENTS ARE SELECTED BY (VERSION, NETWORK). This is the bug the whole
//    change turns on. Before it, selection was by protocol version alone, which
//    with two entries hands the facilitator the Base terms for a Solana payment —
//    a perfectly good payment that verifies as invalid. The mock is strict about
//    exactly this (see mock-facilitator.mjs), so a regression answers 400 upstream
//    and fails loudly rather than passing green.
//
// 4. THE FEE PAYER IS FETCHED AND FAIL-CLOSED. CDP draws Solana feePayers from a
//    pool and the v1 and v2 rows have been seen carrying different ones, so the
//    fixture gives them different ones too — a Worker that fetched once and reused
//    the answer publishes a v2 entry naming the v1 payer, and nobody pays the fee.
//    When /supported cannot be read at all the Solana entry is simply absent:
//    never a stale guess, never an entry with no feePayer, never a 500.
//
// 5. A VERDICT ON A 4xx IS A VERDICT. CDP answers some invalid payments with HTTP
//    400 AND a readable `{ isValid: false, invalidReason }` body. Availability-
//    first must not eat that and serve the report free.
//
// And one more, at the bottom: THE OWNER ALERT NAMES THE RAIL. A Solana signature
// pasted into basescan.org returns nothing, which reads to a human as "the
// settlement did not happen" — so the explorer link branches, with a Base control
// beside it so the branch cannot be one-sided.

import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  bootWorker,
  callers,
  client,
  fakeCdpCredentials,
  isSqlNull,
  PAYTO_SOLANA_TEST,
  PAYTO_TEST,
} from './harness.mjs';
import { ENDPOINTS_BY_ID, SITE_BASE, USDC_BASE, USDC_SOLANA } from '../worker/catalog.js';
import { atomicAmount } from '../worker/envelope.js';
import {
  FEE_PAYER_V1,
  FEE_PAYER_V2,
  SOLANA_SIGNATURE,
  startMockFacilitator,
  VERIFIED_PAYER,
} from './mock-facilitator.mjs';

const ips = callers('solana');

const SOLANA_V1 = 'solana';
const SOLANA_V2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

// The two PASTED-envelope routes: they lint a request body and make no outbound
// call, so a served payment here needs no lint target and no relaxed SSRF guard.
// Prices come from the catalogue rather than typed — the whole point of the
// second rail is that this ONE figure serves both entries, because USDC is 6
// decimals on Base and on Solana alike, and a literal here would keep passing
// after a re-price while the Worker quoted something else.
const ENVELOPE_PATH = '/lint/envelope';
const ENVELOPE_PRICE = atomicAmount(ENDPOINTS_BY_ID.get('lint-envelope').price_usd);
const ONE_PATH = '/lint/envelope/one';
const ONE_PRICE = atomicAmount(ENDPOINTS_BY_ID.get('lint-envelope-one').price_usd);

/** A body both pasted routes accept — a minimal captured 402 to lint. */
const SAMPLE = { status: 402 };
const ONE_SAMPLE = { status: 402, check: 'V2_HEADER_PRESENT' };

// The dual-rail worker every test below shares unless it says otherwise.
let mock;
let worker;
let api;

before(async () => {
  mock = await startMockFacilitator();
  worker = await bootWorker({
    vars: {
      PAYTO: PAYTO_TEST,
      PAYTO_SOLANA: PAYTO_SOLANA_TEST,
      FACILITATOR_URL: mock.url,
      ...fakeCdpCredentials(),
    },
  });
  api = client(worker);
});

after(async () => {
  await worker?.stop();
  await mock?.stop();
});

// ------------------------------------------------------------------ helpers

/** The v1 envelope (the 402's body) and the v2 one (its header), together. */
async function envelopes(apiClient, path, ip) {
  const res = await apiClient.post(path, SAMPLE, { ip });
  assert.equal(res.status, 402, `${path} did not answer the 402 front door: ${res.status} ${res.text}`);
  const header = res.headers.get('payment-required');
  assert.ok(header, `${path} published no v2 envelope`);
  return { res, v1: res.body, v2: JSON.parse(Buffer.from(header, 'base64').toString('utf8')) };
}

/**
 * A well-formed x402 v1 payment on the SOLANA rail.
 *
 * The SVM `exact` scheme carries a serialised transaction rather than an
 * EIP-3009 authorization, and that is what is built here — a shape the Worker can
 * read no `from` out of, which is deliberate: it forces the ledger assertions to
 * prove the payer came from the FACILITATOR, which on this rail is the only place
 * it can come from. The transaction bytes are fresh per call because one
 * authorization buys one report, and a constant would make the second test using
 * it a correctly-refused replay.
 */
const solanaPaymentV1 = () =>
  Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: SOLANA_V1,
      payload: { transaction: randomBytes(48).toString('base64') },
    })
  ).toString('base64');

/** The same, on whichever rail is named — for the un-offered-network tests. */
const paymentV1On = (network) =>
  Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network,
      payload: { transaction: randomBytes(16).toString('base64') },
    })
  ).toString('base64');

/** A v1 payment on BASE, in the EVM shape, so the control is a real control. */
function basePaymentV1(value = ENVELOPE_PRICE) {
  const now = Math.floor(Date.now() / 1000);
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: {
        signature: `0x${'ab'.repeat(65)}`,
        authorization: {
          from: '0x000000000000000000000000000000000000dEaD',
          to: PAYTO_TEST,
          value,
          validAfter: String(now - 600),
          validBefore: String(now + 60),
          nonce: `0x${randomBytes(32).toString('hex')}`,
        },
      },
    })
  ).toString('base64');
}

/**
 * A v2 payment built FROM the Worker's own envelope, on the rail at `index`.
 *
 * Built rather than typed, for the same reason the settlement suite builds its
 * v2 payloads: `accepted` has to be the accepts entry we advertised, byte for
 * byte, or the signature was made over something else — and the mock compares the
 * two. `mutate` is how the rotated-feePayer and tampered-amount tests doctor one
 * field of a payload that is otherwise genuinely ours.
 */
async function paymentV2(apiClient, path, ip, index, mutate = (a) => a) {
  const { v2 } = await envelopes(apiClient, path, ip);
  const entry = v2.accepts[index];
  assert.ok(entry, `${path} published no accepts[${index}]`);
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: v2.resource,
      accepted: mutate({ ...entry }),
      payload: { transaction: randomBytes(48).toString('base64') },
      extensions: v2.extensions,
    })
  ).toString('base64');
}

const settlements = (w = worker) =>
  w.d1(
    'SELECT ts, endpoint, payer, amount, verify_ok, settle_ok, tx_hash, error FROM settlements ORDER BY ts, rowid;'
  );

/** Settlement runs in ctx.waitUntil, so the ledger is polled rather than read. */
async function awaitSettlement(predicate, what, w = worker, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await settlements(w);
    const hit = rows.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`no settlements row matching ${what} within ${timeoutMs} ms; saw ${JSON.stringify(rows)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A settle that lands a Solana SIGNATURE rather than a Base 0x hash. */
const solanaSettleResponse = {
  status: 200,
  body: { success: true, transaction: SOLANA_SIGNATURE, network: SOLANA_V1, payer: VERIFIED_PAYER },
};

/** The dual-rail boot config, with whatever facilitator a test wants. */
const dualRailVars = (facilitatorUrl, extra = {}) => ({
  PAYTO: PAYTO_TEST,
  PAYTO_SOLANA: PAYTO_SOLANA_TEST,
  FACILITATOR_URL: facilitatorUrl,
  ...fakeCdpCredentials(),
  ...extra,
});

// ------------------------------------------------------------------ the gate

describe('PAYTO_SOLANA unset leaves the envelope exactly as it was', () => {
  test('one accepts entry in both versions, byte for byte the single-rail shape', async () => {
    // THE REGRESSION PIN, and it is deliberately a whole-object deep-equal rather
    // than a field check: the claim is not "Solana is absent", it is "nothing
    // moved". The worker is otherwise identically configured — same mock, same
    // CDP credentials, a /supported that WOULD answer — so the only difference
    // between it and the shared worker above is the var.
    const scratch = await bootWorker({
      vars: { PAYTO: PAYTO_TEST, FACILITATOR_URL: mock.url, ...fakeCdpCredentials() },
    });
    try {
      mock.reset();
      const endpoint = ENDPOINTS_BY_ID.get('lint-envelope');
      const { v1, v2 } = await envelopes(client(scratch), ENVELOPE_PATH, ips.next());

      assert.equal(v1.accepts.length, 1, 'the gate leaked: a second v1 entry with PAYTO_SOLANA unset');
      assert.deepEqual(v1.accepts[0], {
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: ENVELOPE_PRICE,
        resource: `${SITE_BASE}${ENVELOPE_PATH}`,
        description: endpoint.description,
        mimeType: endpoint.mimeType,
        payTo: PAYTO_TEST,
        maxTimeoutSeconds: 60,
        asset: USDC_BASE,
        extra: { name: 'USD Coin', version: '2' },
        outputSchema: {
          input: {
            type: 'http',
            method: 'POST',
            discoverable: true,
            bodyType: 'text',
            description: `${endpoint.inputDescription}, up to 256 KB`,
          },
          output: { type: 'string', description: endpoint.outputDescription },
        },
      });

      assert.equal(v2.accepts.length, 1, 'the gate leaked: a second v2 entry with PAYTO_SOLANA unset');
      assert.deepEqual(v2.accepts[0], {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: ENVELOPE_PRICE,
        asset: USDC_BASE,
        payTo: PAYTO_TEST,
        maxTimeoutSeconds: 60,
        extra: { name: 'USD Coin', version: '2' },
      });

      // …and it never even asked. A gated feature that still makes the upstream
      // call has not been gated, it has been hidden.
      assert.equal(mock.hitsOn('supported').length, 0, 'the Worker read /supported with PAYTO_SOLANA unset');
    } finally {
      await scratch.stop();
    }
  });
});

// ------------------------------------------------------------------ the offer

describe('with PAYTO_SOLANA set the envelope offers both rails', () => {
  test('the v1 body carries Base first and Solana second, at the same price', async () => {
    const { v1 } = await envelopes(api, ENVELOPE_PATH, ips.next());
    assert.equal(v1.accepts.length, 2, `expected two accepts entries, got ${v1.accepts.length}`);

    const [base, solana] = v1.accepts;
    assert.equal(base.network, 'base', 'Base is not the first entry — a buyer takes the first it can pay');
    assert.equal(solana.network, SOLANA_V1, 'the v1 Solana entry must use the plain name, not CAIP-2');

    // The Base entry is untouched by the rail beside it.
    assert.equal(base.asset, USDC_BASE);
    assert.equal(base.payTo, PAYTO_TEST);
    assert.deepEqual(base.extra, { name: 'USD Coin', version: '2' });

    assert.equal(solana.asset, USDC_SOLANA);
    assert.equal(solana.payTo, PAYTO_SOLANA_TEST);
    assert.equal(solana.scheme, 'exact');
    assert.equal(solana.maxTimeoutSeconds, 60);
    // ONE PRICE, TWO RAILS. USDC is 6 decimals on both chains, so the atomic
    // figure is identical — a difference here is a buyer paying the wrong amount
    // on one of them.
    assert.equal(solana.maxAmountRequired, base.maxAmountRequired);
    assert.equal(solana.maxAmountRequired, ENVELOPE_PRICE);
    // Same thing being sold, so the same resource and the same discovery block.
    assert.equal(solana.resource, base.resource);
    assert.equal(solana.description, base.description);
    assert.deepEqual(solana.outputSchema, base.outputSchema);

    // `extra` is the SVM fee payer, not an EIP-712 domain. Signing a Solana
    // transaction over `name`/`version` is meaningless, and publishing them would
    // tell a client to do exactly that.
    assert.deepEqual(solana.extra, { feePayer: FEE_PAYER_V1 });
    assert.equal(solana.extra.name, undefined, 'the Solana entry carries the EVM EIP-712 name');
    assert.equal(solana.extra.version, undefined, 'the Solana entry carries the EVM EIP-712 version');
  });

  test('the v2 header carries both too, with the v2 fee payer', async () => {
    const { v2 } = await envelopes(api, ENVELOPE_PATH, ips.next());
    assert.equal(v2.accepts.length, 2, `expected two v2 accepts entries, got ${v2.accepts.length}`);

    const [base, solana] = v2.accepts;
    assert.equal(base.network, 'eip155:8453');
    assert.deepEqual(solana, {
      scheme: 'exact',
      network: SOLANA_V2,
      amount: ENVELOPE_PRICE,
      asset: USDC_SOLANA,
      payTo: PAYTO_SOLANA_TEST,
      maxTimeoutSeconds: 60,
      // THE PER-VERSION CACHE, asserted. The fixture's v1 and v2 rows name
      // different fee payers on purpose; a Worker that cached one answer for both
      // versions publishes FEE_PAYER_V1 here and this fails.
      extra: { feePayer: FEE_PAYER_V2 },
    });
    assert.notEqual(FEE_PAYER_V1, FEE_PAYER_V2, 'the fixture stopped exercising the per-version cache');

    // The rest of the v2 envelope is per-RESOURCE, not per-rail, and a second
    // entry must not have displaced any of it.
    assert.deepEqual(Object.keys(v2).sort(), ['accepts', 'error', 'extensions', 'resource', 'x402Version']);
    assert.ok(v2.extensions?.bazaar?.info, 'the bazaar extension went missing beside the Solana entry');
    assert.equal(v2.resource.url, `${SITE_BASE}${ENVELOPE_PATH}`);
  });

  test('the two envelopes name the same rails in the same order, on every paid route', async () => {
    // The dual-stack invariant, extended to two rails: the v2 header is a
    // projection of the v1 body, so entry i of one is entry i of the other.
    for (const path of [ENVELOPE_PATH, ONE_PATH]) {
      const { v1, v2 } = await envelopes(api, path, ips.next());
      assert.equal(v1.accepts.length, v2.accepts.length, `${path}: the envelopes offer different rail counts`);
      for (let i = 0; i < v1.accepts.length; i++) {
        assert.equal(v2.accepts[i].amount, v1.accepts[i].maxAmountRequired, `${path} rail ${i}: different prices`);
        assert.equal(v2.accepts[i].payTo, v1.accepts[i].payTo, `${path} rail ${i}: different payees`);
        assert.equal(v2.accepts[i].asset, v1.accepts[i].asset, `${path} rail ${i}: different assets`);
      }
      // …and the same amount on both rails within each envelope, whatever the
      // route's price. The price sheet's pairwise-uniqueness invariant is
      // per-ENDPOINT and is untouched by this: two rails of ONE endpoint quoting
      // one figure is the point.
      assert.equal(v1.accepts[0].maxAmountRequired, v1.accepts[1].maxAmountRequired, `${path}: rails differ on price`);
    }
  });
});

// ------------------------------------------------------------------ /supported

describe('the fee payer is fetched, cached per version, and never guessed', () => {
  test('the read is authenticated with a CDP bearer JWT bound to GET /supported', async () => {
    // Same credentials, same signing path as verify and settle — and the `uris`
    // claim is what proves the token was minted for THIS call rather than reused
    // from one of them.
    const hits = mock.hitsOn('supported');
    assert.ok(hits.length >= 1, 'the Worker never read /supported');
    const hit = hits[0];
    assert.equal(hit.method, 'GET');
    assert.match(hit.authorization || '', /^Bearer /, '/supported was read unauthenticated');
    const claims = JSON.parse(Buffer.from(hit.authorization.split('.')[1], 'base64url').toString('utf8'));
    assert.deepEqual(claims.uris, [`GET ${new URL(mock.url).host}/platform/v2/x402/supported`]);
  });

  test('a burst of 402s costs one upstream read, not one each', async () => {
    // Single flight plus a TTL. The 402 is the hot path — it is what Bazaar and
    // every rating surface health-probe, forever — so a fetch per unpaid call
    // would be a new upstream request for every probe.
    const before = mock.hitsOn('supported').length;
    await Promise.all([1, 2, 3, 4, 5].map(() => api.post(ENVELOPE_PATH, SAMPLE, { ip: ips.next() })));
    assert.equal(
      mock.hitsOn('supported').length,
      before,
      'a cached fee payer was re-fetched — /supported is being read per request'
    );
  });

  test('a /supported that cannot be read leaves a Base-only envelope, not a crash', async () => {
    // FAIL CLOSED. The alternative — publishing the Solana entry with a stale or
    // guessed fee payer — is a transaction nobody pays the fee for, which reads to
    // the buyer as a seller that took their signature and did nothing.
    const downMock = await startMockFacilitator();
    downMock.state.supported = { status: 500, body: { error: 'internal' } };
    const scratch = await bootWorker({ vars: dualRailVars(downMock.url) });
    try {
      const { res, v1, v2 } = await envelopes(client(scratch), ENVELOPE_PATH, ips.next());

      assert.equal(res.status, 402, 'a /supported outage broke the front door');
      assert.equal(v1.accepts.length, 1, 'a Solana entry was published with no fee payer');
      assert.equal(v1.accepts[0].network, 'base');
      assert.equal(v2.accepts.length, 1, 'a v2 Solana entry was published with no fee payer');
      assert.deepEqual(v2.accepts[0], {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: ENVELOPE_PRICE,
        asset: USDC_BASE,
        payTo: PAYTO_TEST,
        maxTimeoutSeconds: 60,
        extra: { name: 'USD Coin', version: '2' },
      });
      assert.ok(v2.extensions?.bazaar?.info, 'the bazaar extension went missing with the Solana entry');

      assert.ok(downMock.hitsOn('supported').length >= 1, 'it did not even try');
    } finally {
      await scratch.stop();
      await downMock.stop();
    }
  });

  test('a /supported with no exact Solana row is the same fail-closed answer', async () => {
    // Not an outage — a well-formed document that simply does not offer the rail
    // on this account. The `upto` row in the default fixture is there so a Worker
    // matching on network alone would pick up the WRONG fee payer; here the exact
    // rows are removed entirely and the answer must be Base-only.
    const thinMock = await startMockFacilitator();
    thinMock.state.supported = {
      status: 200,
      body: { kinds: [{ x402Version: 1, scheme: 'exact', network: 'base' }] },
    };
    const scratch = await bootWorker({ vars: dualRailVars(thinMock.url) });
    try {
      const { v1, v2 } = await envelopes(client(scratch), ENVELOPE_PATH, ips.next());
      assert.equal(v1.accepts.length, 1, 'a Solana entry was published from a document that offers none');
      assert.equal(v2.accepts.length, 1, 'a v2 Solana entry was published from a document that offers none');
    } finally {
      await scratch.stop();
      await thinMock.stop();
    }
  });

  test('a Solana row with no CDP credentials never even reaches /supported', async () => {
    // The other fail-closed door, and the one an operator is most likely to walk
    // into: PAYTO_SOLANA set on a deployment whose CDP keys are not. An
    // unauthenticated read does not answer, so it is not attempted — the envelope
    // is Base-only and the var changes nothing at all.
    const keylessMock = await startMockFacilitator();
    const scratch = await bootWorker({
      vars: { PAYTO: PAYTO_TEST, PAYTO_SOLANA: PAYTO_SOLANA_TEST, FACILITATOR_URL: keylessMock.url },
    });
    try {
      const { v1, v2 } = await envelopes(client(scratch), ENVELOPE_PATH, ips.next());
      assert.equal(v1.accepts.length, 1, 'a Solana entry was published with no way to read a fee payer');
      assert.equal(v2.accepts.length, 1, 'a v2 Solana entry was published with no way to read a fee payer');
      assert.equal(
        keylessMock.hitsOn('supported').length,
        0,
        '/supported was read with no credentials — an unauthenticated read cannot answer'
      );
    } finally {
      await scratch.stop();
      await keylessMock.stop();
    }
  });
});

// ------------------------------------------------------------------ selection

describe('requirements are selected by (version, network)', () => {
  test('a v1 Solana payment is verified and settled against the SOLANA entry', async () => {
    // THE TEST THIS WHOLE CHANGE EXISTS FOR. Selecting by protocol version alone
    // would send the facilitator the Base terms — same version, wrong chain, wrong
    // asset, wrong payTo — and the mock's strictness turns that into a 400, an
    // unverified serve, and a red test rather than a green one.
    mock.reset();
    mock.state.settle = solanaSettleResponse;
    const ip = ips.next();

    const res = await api.post(ENVELOPE_PATH, SAMPLE, { ip, headers: { 'x-payment': solanaPaymentV1() } });

    assert.equal(res.status, 200, `a Solana payment was not accepted: ${res.status} ${res.text}`);
    assert.equal(res.headers.get('x-payment-verified'), 'true');
    assert.ok(res.body?.grade, 'the lint did not run');

    const row = await awaitSettlement((r) => r.tx_hash === SOLANA_SIGNATURE, 'the Solana settlement');
    assert.equal(row.endpoint, 'lint-envelope');
    assert.equal(row.verify_ok, 1);
    assert.equal(row.settle_ok, 1);
    assert.equal(row.amount, ENVELOPE_PRICE, 'the Solana rail was billed a different amount');
    // The SVM payload names no `from`, so a payer in the ledger can only have come
    // from the facilitator's answer.
    assert.equal(row.payer, VERIFIED_PAYER);
    assert.ok(isSqlNull(row.error));

    assert.equal(mock.problems(), '', 'the facilitator was sent requirements for the wrong rail');

    const verify = mock.hitsOn('verify');
    const settle = mock.hitsOn('settle');
    assert.equal(verify.length, 1, `expected exactly one verify, saw ${verify.length}`);
    assert.equal(settle.length, 1, `expected exactly one settle, saw ${settle.length}`);

    for (const hit of [verify[0], settle[0]]) {
      assert.equal(hit.body.x402Version, 1, `${hit.endpoint} declared the wrong version`);
      const req = hit.body.paymentRequirements;
      assert.equal(req.network, SOLANA_V1, `${hit.endpoint} was sent the wrong network`);
      assert.equal(req.payTo, PAYTO_SOLANA_TEST, `${hit.endpoint} was sent the wrong payTo`);
      assert.equal(req.asset, USDC_SOLANA, `${hit.endpoint} was sent the wrong asset`);
      assert.deepEqual(req.extra, { feePayer: FEE_PAYER_V1 }, `${hit.endpoint} was sent the wrong fee payer`);
      assert.equal(req.maxAmountRequired, ENVELOPE_PRICE);
    }

    // The settle body still names the resource a Bazaar listing attaches to, and
    // it is the shared one — the resource does not change with the rail.
    assert.equal(settle[0].body.paymentPayload.resource, `${SITE_BASE}${ENVELOPE_PATH}`);
  });

  test('a v2 Solana payment is verified and settled against the v2 SOLANA entry', async () => {
    mock.reset();
    mock.state.settle = solanaSettleResponse;
    const ip = ips.next();
    const header = await paymentV2(api, ONE_PATH, ip, 1);

    const res = await api.post(ONE_PATH, ONE_SAMPLE, { ip, headers: { 'payment-signature': header } });

    assert.equal(res.status, 200, `a v2 Solana payment was not accepted: ${res.status} ${res.text}`);
    assert.equal(res.headers.get('x-payment-verified'), 'true');
    await awaitSettlement((r) => r.endpoint === 'lint-envelope-one' && r.settle_ok === 1, 'the v2 Solana settlement');
    assert.equal(mock.problems(), '', 'the facilitator was sent requirements for the wrong rail');

    for (const hit of [mock.hitsOn('verify')[0], mock.hitsOn('settle')[0]]) {
      assert.equal(hit.body.x402Version, 2, `${hit.endpoint} declared the wrong version`);
      assert.deepEqual(hit.body.paymentRequirements, {
        scheme: 'exact',
        network: SOLANA_V2,
        amount: ONE_PRICE, // the same figure this route quotes on Base
        asset: USDC_SOLANA,
        payTo: PAYTO_SOLANA_TEST,
        maxTimeoutSeconds: 60,
        extra: { feePayer: FEE_PAYER_V2 },
      });
    }

    // The v2 settle body's resource is the OBJECT, unchanged by the rail.
    const resource = mock.hitsOn('settle')[0].body.paymentPayload.resource;
    assert.equal(resource.url, `${SITE_BASE}${ONE_PATH}`);
    assert.equal(resource.serviceName, '10x402');
  });

  test('a v2 payment signed against a ROTATED pool feePayer is checked against that feePayer', async () => {
    // CDP rotates feePayers between reads. The 402 this payment quotes from may
    // have carried a different pool address than the isolate's cache holds by the
    // time the paid retry arrives — the buyer's transaction is built against the
    // one in ITS 402, so verification must adopt the payload's echoed feePayer,
    // not the cache's current one. The mock's own invariant (payload.accepted must
    // deep-equal the requirements) fails this test against any Worker that
    // re-derives the feePayer at verify time.
    mock.reset();
    mock.state.settle = solanaSettleResponse;
    const ROTATED = 'RotatedPoo1FeePayer1111111111111111111111111';
    const ip = ips.next();
    const header = await paymentV2(api, ONE_PATH, ip, 1, (a) => ({ ...a, extra: { feePayer: ROTATED } }));

    const res = await api.post(ONE_PATH, ONE_SAMPLE, { ip, headers: { 'payment-signature': header } });

    assert.equal(res.status, 200, `a rotated-feePayer payment was not accepted: ${res.status} ${res.text}`);
    assert.equal(mock.problems(), '', 'the facilitator saw requirements that disagree with what the buyer signed');
    for (const hit of [mock.hitsOn('verify')[0], mock.hitsOn('settle')[0]]) {
      assert.deepEqual(
        hit.body.paymentRequirements.extra,
        { feePayer: ROTATED },
        `${hit.endpoint} was sent the cache's feePayer instead of the one the buyer signed against`
      );
    }
  });

  test('the feePayer echo is the ONLY term a payload may restate — a tampered amount is not adopted', async () => {
    // Adoption is deliberately narrow: the buyer restates the feePayer we could
    // have served, never a term we charge on. An accepted entry with a doctored
    // amount must not be adopted — the requirements sent to the facilitator keep
    // OUR amount and OUR cached feePayer, so the doctored payload no longer
    // matches them (the mock records exactly that mismatch), and a strict
    // facilitator refuses it.
    mock.reset();
    const ip = ips.next();
    const header = await paymentV2(api, ONE_PATH, ip, 1, (a) => ({
      ...a,
      amount: '1',
      extra: { feePayer: 'RotatedPoo1FeePayer1111111111111111111111111' },
    }));

    await api.post(ONE_PATH, ONE_SAMPLE, { ip, headers: { 'payment-signature': header } });

    const verify = mock.hitsOn('verify')[0];
    assert.ok(verify, 'the facilitator was never asked');
    assert.equal(
      verify.body.paymentRequirements.amount,
      ONE_PRICE,
      'a tampered amount must never be adopted into the requirements'
    );
    assert.deepEqual(
      verify.body.paymentRequirements.extra,
      { feePayer: FEE_PAYER_V2 },
      'a payload with tampered terms gets the cache feePayer, not its own'
    );
    assert.match(
      mock.problems(),
      /not the accepts entry the payload signed against/,
      'the doctored payload should no longer match the requirements — a strict facilitator refuses it'
    );
  });

  test('a verdict on an HTTP 400 is a refusal, never a free report', async () => {
    // CDP answers some invalid payments with HTTP 400 AND a well-formed
    // { isValid: false, invalidReason } body (observed live 2026-08-31 on the
    // sibling property: preflight_validation_failed on the first Solana smoke
    // payment). Availability-first must not eat that: a readable verdict on a 4xx
    // is a verdict, and the payment is refused — not served unverified for free.
    mock.reset();
    mock.state.verify = { status: 400, body: { isValid: false, invalidReason: 'preflight_validation_failed' } };
    const ip = ips.next();
    const header = await paymentV2(api, ONE_PATH, ip, 1);

    const res = await api.post(ONE_PATH, ONE_SAMPLE, { ip, headers: { 'payment-signature': header } });

    assert.equal(res.status, 402, `a 400-verdict must refuse, not serve: got ${res.status} ${res.text}`);
    assert.equal(res.body.invalidReason, 'preflight_validation_failed', "the refusal must carry the facilitator's reason");
    assert.equal(res.headers.get('x-payment-verified'), null, 'a refused payment must not be reported as served');
    assert.equal(mock.hitsOn('settle').length, 0, 'a refused payment must never settle');
  });

  test('a non-200 with no verdict in it is still an outage, not a refusal', async () => {
    // THE CONTROL FOR THE TEST ABOVE. Without it, "a 400 refuses" would also pass
    // against a Worker that had started refusing every facilitator hiccup — which
    // would turn our dependency's outage into the caller's problem, the exact
    // thing the availability-first rule exists to prevent.
    mock.reset();
    mock.state.verify = { status: 503, body: { error: 'down' } };
    const ip = ips.next();

    const res = await api.post(ENVELOPE_PATH, SAMPLE, { ip, headers: { 'x-payment': solanaPaymentV1() } });

    assert.equal(res.status, 200, `an unreadable 503 must serve, not refuse: ${res.status} ${res.text}`);
    assert.equal(res.headers.get('x-payment-verified'), 'false');
    assert.equal(res.headers.get('x-payment-error'), 'facilitator-unreachable');
  });

  test('a Base payment still selects the Base entry, both versions', async () => {
    // THE POSITIVE CONTROL FOR THE RAIL THAT ALREADY HAS MONEY ON IT. Without it,
    // "the Solana payment picked the Solana entry" would also pass against a
    // Worker that had started picking Solana for everything.
    mock.reset();
    const ip = ips.next();

    const v1Res = await api.post(ENVELOPE_PATH, SAMPLE, { ip, headers: { 'x-payment': basePaymentV1() } });
    assert.equal(v1Res.status, 200, v1Res.text);
    await awaitSettlement((r) => r.endpoint === 'lint-envelope' && r.settle_ok === 1, 'the Base settlement');

    const v1Verify = mock.hitsOn('verify')[0];
    assert.equal(v1Verify.body.paymentRequirements.network, 'base');
    assert.equal(v1Verify.body.paymentRequirements.payTo, PAYTO_TEST);
    assert.equal(v1Verify.body.paymentRequirements.asset, USDC_BASE);
    assert.deepEqual(v1Verify.body.paymentRequirements.extra, { name: 'USD Coin', version: '2' });

    mock.reset();
    const ip2 = ips.next();
    const v2Header = await paymentV2(api, ENVELOPE_PATH, ip2, 0);
    const v2Res = await api.post(ENVELOPE_PATH, SAMPLE, { ip: ip2, headers: { 'payment-signature': v2Header } });
    assert.equal(v2Res.status, 200, v2Res.text);

    const v2Verify = mock.hitsOn('verify')[0];
    assert.equal(v2Verify.body.paymentRequirements.network, 'eip155:8453');
    assert.equal(v2Verify.body.paymentRequirements.payTo, PAYTO_TEST);
    assert.equal(v2Verify.body.paymentRequirements.asset, USDC_BASE);
    assert.deepEqual(v2Verify.body.paymentRequirements.extra, { name: 'USD Coin', version: '2' });
    assert.equal(mock.problems(), '');
  });

  test('a payload naming a rail we did not offer is refused, and never settled', async () => {
    mock.reset();

    for (const network of ['polygon', 'avalanche', 'solana-devnet']) {
      const res = await api.post(ENVELOPE_PATH, SAMPLE, {
        ip: ips.next(),
        headers: { 'x-payment': paymentV1On(network) },
      });

      assert.equal(res.status, 402, `a payment on ${network} answered ${res.status}: ${res.text}`);
      assert.equal(res.body.invalidReason, 'unsupported_network');
      // The refusal names what IS on offer, so a client can fix itself rather than
      // retrying the same unpayable rail forever.
      assert.match(res.body.invalidMessage, /base/);
      assert.match(res.body.invalidMessage, /solana/);
      // …and the envelope is still attached, with both rails, so paying again is
      // one step rather than a fresh discovery round.
      assert.equal(res.body.accepts.length, 2);
      assert.ok(res.headers.get('payment-required'), 'the refusal dropped the v2 envelope');
    }

    // Nothing to check and nothing to charge: the facilitator was never asked, and
    // nothing was ever settled.
    assert.equal(mock.hitsOn('verify').length, 0, 'an un-offered rail was sent to the facilitator');
    assert.equal(mock.hitsOn('settle').length, 0, 'AN UN-OFFERED RAIL WAS SETTLED');

    // Give a queued settle time to be wrong before believing it was right.
    await new Promise((r) => setTimeout(r, 1_000));
    assert.equal(mock.hitsOn('settle').length, 0, 'a settle was queued after the refusal');

    // …and the refusal IS recorded, because a payment was presented and answered.
    await awaitSettlement((r) => r.error === 'unsupported_network', 'the un-offered-rail refusal');
  });

  test('a payload naming Solana when Solana is not on offer is refused, not mispaid', async () => {
    // The state a buyer reaches by caching an envelope from a moment when the rail
    // WAS advertised. The wrong answer here is not a 500, it is the seller quietly
    // checking a Solana payment against Base terms.
    const downMock = await startMockFacilitator();
    downMock.state.supported = { status: 500, body: { error: 'internal' } };
    const scratch = await bootWorker({ vars: dualRailVars(downMock.url) });
    try {
      const res = await client(scratch).post(ENVELOPE_PATH, SAMPLE, {
        ip: ips.next(),
        headers: { 'x-payment': solanaPaymentV1() },
      });
      assert.equal(res.status, 402, `expected the refusal, got ${res.status}: ${res.text}`);
      assert.equal(res.body.invalidReason, 'unsupported_network');
      assert.equal(downMock.hitsOn('verify').length, 0, 'the Base terms were sent for a Solana payment');
      assert.equal(downMock.hitsOn('settle').length, 0);
    } finally {
      await scratch.stop();
      await downMock.stop();
    }
  });
});

// ------------------------------------------------------------------ alerts
//
// The owner's ping is the one place a human reads which chain the money moved on,
// and the one place a wrong answer is actively unhelpful: a Solana signature
// pasted into basescan.org returns nothing, which reads as "the settlement did not
// happen". The full alert machinery — both channels, the silences, the
// it-cannot-affect-the-caller rules — is alerts.test.mjs's job; what is proved
// here is only that the rail reaches the message.

/** A stand-in for api.telegram.org that records every sendMessage. */
async function startMockTelegram() {
  const sends = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const [, , method = ''] = new URL(req.url, 'http://mock').pathname.split('/');
      if (method === 'sendMessage') {
        try {
          sends.push(JSON.parse(raw).text);
        } catch {
          sends.push(null);
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"result":{"message_id":1}}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    sends,
    url: `http://127.0.0.1:${server.address().port}`,
    /** Alerts fire in ctx.waitUntil, so the channel is polled, not read once. */
    await: async (match, what, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = sends.find((t) => t && t.includes(match));
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error(`no Telegram message containing ${what} within ${timeoutMs} ms; saw ${JSON.stringify(sends)}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    stop: () => new Promise((r) => server.close(r)),
  };
}

describe('the owner alert names the rail the money moved on', () => {
  test('a Solana settlement links to solscan; a Base one still links to basescan', async () => {
    const alertMock = await startMockFacilitator();
    const telegram = await startMockTelegram();
    const scratch = await bootWorker({
      vars: dualRailVars(alertMock.url, {
        TELEGRAM_BOT_TOKEN: '123456:test-bot-token',
        TELEGRAM_CHAT_ID: '-1001234567890',
        TELEGRAM_API_BASE: telegram.url,
      }),
    });
    try {
      const scratchApi = client(scratch);

      alertMock.state.settle = solanaSettleResponse;
      const solRes = await scratchApi.post(ENVELOPE_PATH, SAMPLE, {
        ip: ips.next(),
        headers: { 'x-payment': solanaPaymentV1() },
      });
      assert.equal(solRes.status, 200, solRes.text);

      const solText = await telegram.await(SOLANA_SIGNATURE, 'the Solana settlement');
      assert.match(solText, /atomic USDC on Solana/, 'the alert calls a Solana payment a Base one');
      assert.ok(
        solText.includes(`https://solscan.io/tx/${SOLANA_SIGNATURE}`),
        `the Solana alert has no solscan link:\n${solText}`
      );
      assert.ok(!solText.includes('basescan.org'), 'a Solana signature was linked to basescan, where it does not exist');

      // THE CONTROL. Without it "the Solana alert says solscan" would also pass
      // against a Worker that had started sending every alert to solscan.
      alertMock.reset();
      const baseRes = await scratchApi.post(ENVELOPE_PATH, SAMPLE, {
        ip: ips.next(),
        headers: { 'x-payment': basePaymentV1() },
      });
      assert.equal(baseRes.status, 200, baseRes.text);

      const baseText = await telegram.await('basescan.org', 'the Base settlement');
      assert.match(baseText, /atomic USDC on Base/);
      assert.ok(!baseText.includes('solscan.io'), 'a Base hash was linked to solscan');
    } finally {
      await scratch.stop();
      await telegram.stop();
      await alertMock.stop();
    }
  });
});
