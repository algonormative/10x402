// The 402 front door, in the PRODUCTION configuration: no free tier, PAYTO set.
//
// This is what a stranger — or a discovery index's prober — actually meets on
// the first call. Three properties matter, and each has a reason that is not
// aesthetic:
//
//   THE FIRST unauthenticated call is the 402, not the fourth. A free tier
//   would hand the prober a 200 and delist the service. (It would also make
//   this service fail its own HTTP_FREE_TIER_200 check, which is why the
//   self-lint suite runs in this same phase.)
//
//   THE 402 TOUCHES NO STORE. It is the cheapest thing the Worker does, which
//   is what keeps a continuously scanned public endpoint from costing money.
//
//   BOTH VERSIONS COME OUT OF ONE RESPONSE, and they agree — v1 in the body,
//   v2 in the header, projected from one requirements object so they cannot
//   drift apart.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { callers, client, decodeV2, PAYTO_TEST, useWorker } from './harness.mjs';
import { ENDPOINTS } from '../worker/catalog.js';

const ips = callers('x402');
let worker;
let api;

before(async () => {
  worker = await useWorker({ payTo: PAYTO_TEST });
  api = client(worker);
});
after(async () => {
  await worker?.stop();
});

/** Every table a request could write to, counted. The 402 path writes to none. */
async function storeCounts() {
  const [rows] = await worker.d1(
    'SELECT (SELECT COUNT(*) FROM settlements) AS settlements, ' +
      '(SELECT COUNT(*) FROM call_quota) AS call_quota, ' +
      '(SELECT COUNT(*) FROM payment_seen) AS payment_seen, ' +
      '(SELECT COUNT(*) FROM lints) AS lints, ' +
      '(SELECT COUNT(*) FROM counters) AS counters;'
  );
  return rows;
}

const unpaid = (endpoint) =>
  api.post(endpoint.path, endpoint.id === 'lint' ? { url: 'https://example.com/x' } : { status: 402 }, {
    ip: ips.next(),
  });

describe('the first unauthenticated call', () => {
  for (const endpoint of ENDPOINTS) {
    test(`${endpoint.path} answers 402 immediately`, async () => {
      const res = await unpaid(endpoint);
      assert.equal(res.status, 402, res.text);
      assert.equal(res.body.x402Version, 1);
      assert.ok(res.headers.get('payment-required'), 'no v2 envelope');
    });

    test(`${endpoint.path} says the 402 must not be cached`, async () => {
      // An envelope is per-request. A cached 402 hands the next caller someone
      // else's terms.
      const res = await unpaid(endpoint);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });
  }

  test('it touches no store at all', async () => {
    // The whole cost argument. If the 402 fast path wrote a row, a scanned
    // endpoint would cost money to be discovered.
    const before = await worker.d1('SELECT COUNT(*) AS n FROM call_quota;');
    const saltBefore = await worker.d1("SELECT COUNT(*) AS n FROM salt;");
    for (let i = 0; i < 5; i++) await unpaid(ENDPOINTS[0]);
    const after_ = await worker.d1('SELECT COUNT(*) AS n FROM call_quota;');
    const saltAfter = await worker.d1("SELECT COUNT(*) AS n FROM salt;");
    assert.equal(Number(after_[0].n), Number(before[0].n));
    assert.equal(Number(saltAfter[0].n), Number(saltBefore[0].n));
  });

  test('it never becomes a 200, however many times it is probed', async () => {
    const ip = ips.pinned(1);
    for (let i = 0; i < 6; i++) {
      const res = await api.lintEnvelope({ status: 402 }, { ip });
      assert.equal(res.status, 402, `call ${i + 1} answered ${res.status}`);
    }
  });

  test('it is reached before the body is even read', async () => {
    // A caller with no payment gets the price quote regardless of what they
    // sent, which is what makes the 402 the front door rather than a validation
    // outcome. Garbage in, price quote out.
    const res = await api.post('/lint/envelope', 'this is not json at all', { ip: ips.next() });
    assert.equal(res.status, 402);
  });

  test('an oversized body is refused BEFORE the envelope is built', async () => {
    // Cheapest reject first: refusing on a declared content-length costs less
    // than constructing an envelope.
    const res = await api.post('/lint/envelope', JSON.stringify({ status: 402, body: 'x'.repeat(400 * 1024) }), {
      ip: ips.next(),
    });
    assert.equal(res.status, 413);
  });
});

describe('the v1 envelope, in the body', () => {
  test('is a complete, conformant v1 accepts entry', async () => {
    const res = await unpaid(ENDPOINTS[0]);
    const accept = res.body.accepts[0];
    assert.equal(accept.scheme, 'exact');
    assert.equal(accept.network, 'base', 'v1 uses the plain name, never CAIP-2');
    assert.equal(accept.maxAmountRequired, '10000', '$0.01 in 6-decimal atomic units');
    assert.equal(typeof accept.resource, 'string', 'v1 resource is a flat string');
    assert.equal(accept.payTo, PAYTO_TEST);
    assert.equal(accept.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    assert.deepEqual(accept.extra, { name: 'USD Coin', version: '2' });
    assert.equal(accept.maxTimeoutSeconds, 60);
    assert.ok(accept.description);
    assert.ok(accept.mimeType);
  });

  test('opts into v1 discovery at the level the flag actually lives', async () => {
    // Inside outputSchema.input, not one level up. It is a check this service
    // sells (V1_DISCOVERABLE), so getting it wrong here would be doubly bad.
    const res = await unpaid(ENDPOINTS[0]);
    assert.equal(res.body.accepts[0].outputSchema.input.discoverable, true);
  });

  test('prices each endpoint differently', async () => {
    const lint = await unpaid(ENDPOINTS.find((e) => e.id === 'lint'));
    const envelope = await unpaid(ENDPOINTS.find((e) => e.id === 'lint-envelope'));
    assert.equal(lint.body.accepts[0].maxAmountRequired, '10000');
    assert.equal(envelope.body.accepts[0].maxAmountRequired, '5000');
  });
});

describe('the v2 envelope, in the PAYMENT-REQUIRED header', () => {
  test('is STANDARD base64, which is the whole bug this service is named after', async () => {
    const res = await unpaid(ENDPOINTS[0]);
    const header = res.headers.get('payment-required');
    assert.match(header, /^[A-Za-z0-9+/]*={0,2}$/);
    assert.ok(!/[-_]/.test(header), 'the envelope is base64url — clients discard it unread');
  });

  test('carries exactly the seven fields a v2 accept may have', async () => {
    const env = decodeV2((await unpaid(ENDPOINTS[0])).headers.get('payment-required'));
    assert.deepEqual(
      Object.keys(env.accepts[0]).sort(),
      ['amount', 'asset', 'extra', 'maxTimeoutSeconds', 'network', 'payTo', 'scheme']
    );
  });

  test('uses the v2 spellings for network and price', async () => {
    const env = decodeV2((await unpaid(ENDPOINTS[0])).headers.get('payment-required'));
    assert.equal(env.x402Version, 2);
    assert.equal(env.accepts[0].network, 'eip155:8453');
    assert.equal(env.accepts[0].amount, '10000');
    assert.equal(env.accepts[0].maxAmountRequired, undefined);
  });

  test('carries the v2 resource OBJECT, with a method', async () => {
    const env = decodeV2((await unpaid(ENDPOINTS[0])).headers.get('payment-required'));
    assert.equal(typeof env.resource, 'object');
    assert.match(env.resource.url, /^https:\/\/10x402\.com\/lint$/);
    assert.equal(env.resource.method, 'POST');
    assert.ok(env.resource.description);
    assert.equal(env.resource.mimeType, 'application/json');
    assert.equal(env.resource.serviceName, '10x402');
    assert.ok(env.resource.tags.includes('x402'));
    assert.ok(env.resource.serviceName.length <= 32, 'serviceName is capped at 32 characters');
    assert.ok(env.resource.tags.length <= 5, 'tags are capped at 5 entries');
  });

  test('carries a bazaar extension whose info validates against its own schema', async () => {
    // The silent-delisting check, applied to ourselves.
    const env = decodeV2((await unpaid(ENDPOINTS[0])).headers.get('payment-required'));
    const { info, schema } = env.extensions.bazaar;
    assert.ok(info.input.body, 'no sample request body');
    assert.ok(info.output.example, 'no computed output example');
    const { validateAgainstSchema } = await import('../worker/json-schema.js');
    assert.deepEqual(validateAgainstSchema(info, schema), []);
  });

  test('publishes an output example that is a real run of the real engine', async () => {
    // Not a hand-written hope. The example is produced by linting a captured
    // production 402 through this service's own code path, so it cannot drift
    // from what the endpoint returns.
    const env = decodeV2((await unpaid(ENDPOINTS[0])).headers.get('payment-required'));
    const example = JSON.parse(env.extensions.bazaar.info.output.example);
    assert.ok(['A', 'B', 'C', 'D', 'F'].includes(example.grade));
    assert.ok(Array.isArray(example.findings));
    assert.equal(typeof example.checks_run, 'number');
  });

  test('the sample body it publishes is one a caller could send verbatim', async () => {
    const env = decodeV2((await unpaid(ENDPOINTS.find((e) => e.id === 'lint-envelope'))).headers.get('payment-required'));
    const sample = JSON.parse(env.extensions.bazaar.info.input.body);
    assert.equal(typeof sample.status, 'number');
    // It is a v1-only envelope on purpose: the published example shows the
    // product doing something, not just returning an A.
    const parsedBody = JSON.parse(sample.body);
    assert.equal(parsedBody.x402Version, 1);
    const example = JSON.parse(env.extensions.bazaar.info.output.example);
    assert.ok(example.findings.length > 0, 'the published example shows no findings at all');
  });

  test('fits in a response header without heroics', async () => {
    // The envelope rides in a header on every unpaid call, and proxies clip
    // very long header values. 8 KB is comfortably under every limit that
    // matters and comfortably above what these envelopes need.
    for (const endpoint of ENDPOINTS) {
      const header = (await unpaid(endpoint)).headers.get('payment-required');
      assert.ok(header.length < 8192, `${endpoint.path} envelope is ${header.length} bytes`);
    }
  });
});

describe('the two envelopes agree', () => {
  for (const endpoint of ENDPOINTS) {
    test(`${endpoint.path}: same payTo, price, chain, asset and resource`, async () => {
      const res = await unpaid(endpoint);
      const v1 = res.body.accepts[0];
      const v2 = decodeV2(res.headers.get('payment-required'));
      assert.equal(v1.payTo, v2.accepts[0].payTo);
      assert.equal(v1.maxAmountRequired, v2.accepts[0].amount);
      assert.equal(v1.asset, v2.accepts[0].asset);
      assert.equal(v1.resource, v2.resource.url);
      assert.equal(v1.description, v2.resource.description);
      assert.equal(v1.mimeType, v2.resource.mimeType);
      // One chain, two legal spellings.
      assert.equal(v1.network, 'base');
      assert.equal(v2.accepts[0].network, 'eip155:8453');
    });
  }
});

describe('an undecodable payment header', () => {
  test('is a rejection with the reason named, not a 500', async () => {
    const res = await api.lintEnvelope(
      { status: 402 },
      { ip: ips.next(), headers: { 'x-payment': 'not base64 json' } }
    );
    assert.equal(res.status, 402);
    assert.equal(res.body.invalidReason, 'malformed_payment_header');
    assert.match(res.body.invalidMessage, /base64-encoded JSON/);
  });

  test('the v2 envelope carries the reason as a CODE, which is what clients branch on', async () => {
    const res = await api.lintEnvelope(
      { status: 402 },
      { ip: ips.next(), headers: { 'payment-signature': 'garbage' } }
    );
    const env = decodeV2(res.headers.get('payment-required'));
    assert.equal(env.error, 'malformed_payment_header');
  });

  test('writes NOTHING to the store — bytes are not an event', async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and called it "recorded in the
    // ledger rather than silently dropped". It was an unauthenticated,
    // unmetered write: `X-PAYMENT: junk` was the whole attack, twenty-five of
    // them were twenty-five rows, and nothing in the request had to be real.
    //
    // The settlements table is the revenue record. It must mean "we talked to a
    // facilitator about this" and never "someone sent us bytes" — otherwise the
    // one query an operator runs to see whether anybody paid is a query over
    // whatever a stranger felt like inserting.
    const before = await storeCounts();
    for (let i = 0; i < 25; i++) {
      const res = await api.lintEnvelope({ status: 402 }, { ip: ips.next(), headers: { 'x-payment': 'junk' } });
      assert.equal(res.status, 402);
    }
    assert.deepEqual(await storeCounts(), before, 'a junk payment header touched the store');
  });

  test('no quota is claimed either, so it cannot spend anyone else out of one', async () => {
    // The other half: a counter a stranger can move for free is a counter that
    // can be used to lock somebody out of a service they are paying for.
    const ip = ips.pinned(2);
    const before = await worker.d1('SELECT COUNT(*) AS n FROM call_quota;');
    for (let i = 0; i < 5; i++) {
      await api.lintEnvelope({ status: 402 }, { ip, headers: { 'x-payment': 'not base64 json' } });
    }
    const after_ = await worker.d1('SELECT COUNT(*) AS n FROM call_quota;');
    assert.equal(Number(after_[0].n), Number(before[0].n), 'a junk payment header claimed quota');
  });

  test('nothing is served for a rejected payment', async () => {
    const rows = await worker.d1('SELECT COUNT(*) AS n FROM lints;');
    await api.lintEnvelope({ status: 402 }, { ip: ips.next(), headers: { 'x-payment': 'junk' } });
    const after_ = await worker.d1('SELECT COUNT(*) AS n FROM lints;');
    assert.equal(Number(after_[0].n), Number(rows[0].n));
  });
});

describe('the free tier is off, and /check says so', () => {
  test('reports zero rather than omitting the field', async () => {
    // Explicit beats absent: a reader that has to tell "no free tier" from
    // "this build forgot to say" will guess wrong.
    const { body } = await api.check({ ip: ips.next() });
    assert.equal(body.free_tier_daily, 0);
  });
});
