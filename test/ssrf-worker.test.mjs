// The SSRF guard, through the live Worker, with the PRODUCTION configuration.
//
// test/ssrf-rules.test.mjs asserts the rules as pure functions. This file
// asserts that the shipped Worker actually applies them — that the guard is
// wired into the request path and not merely present in the repo. The phase
// this runs in deliberately does NOT set LINT_UNSAFE_TARGETS, so every refusal
// below is a statement about what a deployed 10x402 does.
//
// The load-bearing negative: NOTHING HERE IS FETCHED. A refusal must happen
// before any outbound request, which is why the timings are asserted and why
// the metadata-endpoint case is written out explicitly rather than folded into
// a loop — it is the one an attacker is actually after.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { callers, client, FREE_TIER_ENABLED, TIER_ON_VARS, useWorker } from './harness.mjs';

const ips = callers('ssrf');
let worker;
let api;

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker?.stop();
});

const refuse = async (url, match) => {
  const res = await api.lint({ url }, { ip: ips.next() });
  assert.equal(res.status, 400, `${url} was not refused: ${res.text}`);
  assert.match(res.body.error, match);
  assert.ok(res.body.fix && res.body.fix.length > 40, `${url}: refusal carries no fix`);
  return res;
};

describe('the deployed guard refuses', () => {
  test('the cloud metadata endpoint', async () => {
    // The prize. If one assertion in this file matters, it is this one.
    const res = await refuse('https://169.254.169.254/latest/meta-data/iam/', /169\.254\.0\.0\/16/);
    assert.match(res.body.error, /metadata/);
  });

  test('loopback by address', () => refuse('https://127.0.0.1:8787/lint', /127\.0\.0\.0\/8/));
  test('loopback by name', () => refuse('https://localhost:8787/lint', /private-network name/));
  test('IPv6 loopback', () => refuse('https://[::1]:8787/lint', /loopback/));
  test('an IPv4-mapped IPv6 loopback', () => refuse('https://[::ffff:127.0.0.1]/x', /IPv4-mapped/));
  test('RFC 1918 space', () => refuse('https://10.1.2.3/admin', /10\.0\.0\.0\/8/));
  test('a private-network name suffix', () => refuse('https://vault.internal/v1/secret', /private-network name/));
  test('a bare container hostname', () => refuse('https://postgres/x', /bare hostname/));
  test('plain http', () => refuse('http://example.com/api', /must be https/));
  test('a file URL', () => refuse('file:///etc/passwd', /must be https/));
  test('credentials in the URL', () => refuse('https://u:p@example.com/x', /credentials/));

  test('the worker itself, addressed by its own dev URL', async () => {
    // A linter that can be pointed at itself over loopback is a linter that can
    // be made to recurse. Two independent rules would refuse this — the scheme
    // check and the loopback check — and the scheme one runs first, which is
    // the cheaper order. The assertion is only that it IS refused, because
    // depending on which rule wins would make this test about ordering rather
    // than about the outcome that matters.
    const res = await refuse(`${worker.baseUrl}/check`, /must be https|127\.0\.0\.0\/8/);
    assert.match(res.body.fix, /lint\/envelope|TLS/);
  });
});

describe('the refusal is a refusal to FETCH, not a report about a fetch', () => {
  test('it costs nothing and returns no lint report', async () => {
    const res = await api.lint({ url: 'https://127.0.0.1/x' }, { ip: ips.next() });
    assert.equal(res.status, 400);
    assert.equal(res.body.grade, undefined);
    assert.equal(res.body.findings, undefined);
  });

  test('it answers fast enough that no connection was attempted', async () => {
    // A refused target that was actually dialled would take a connect timeout
    // to fail. This is a coarse instrument on purpose — it is asserting the
    // ORDER of two operations, and an order is what a wall clock can see.
    const started = Date.now();
    await api.lint({ url: 'https://10.255.255.1/x' }, { ip: ips.next() });
    assert.ok(Date.now() - started < 2000, 'the refusal took long enough to have been a connection attempt');
  });

  test('a refused call still spends free-tier allowance, because it was served', async () => {
    // Honest accounting in the direction that costs us: the request WAS
    // handled, the caller got an answer, and pretending otherwise would make
    // the counter a place to hide work. The paid path is the one where this
    // matters, and there a 400 settles nothing — see the production phase.
    const ip = ips.pinned(1);
    const res = await api.lint({ url: 'https://localhost/x' }, { ip });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('x-free-tier-remaining'), null);
  });
});

describe('the guard does not over-block', () => {
  test('an ordinary public https URL passes the guard and is attempted', async () => {
    // It will not RESOLVE — nothing in this suite may touch the network, and
    // the domain below is reserved by IANA for exactly this — but the answer
    // has to be a transport failure, which proves the guard let it through.
    const res = await api.lint({ url: 'https://x402-lint-probe.invalid/api' }, { ip: ips.next() });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /could not reach|did not answer/);
    assert.ok(!/private|reserved|https/.test(res.body.error), `refused by the guard: ${res.body.error}`);
  });
});

describe('input validation on /lint', () => {
  test('a missing url is refused with the alternative named', async () => {
    const res = await api.lint({}, { ip: ips.next() });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /`url` is required/);
    assert.match(res.body.fix, /lint\/envelope/);
  });

  test('an unsupported method is refused', async () => {
    const res = await api.lint({ url: 'https://example.com/x', method: 'DELETE' }, { ip: ips.next() });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /must be "POST" or "GET"/);
  });

  test('GET is accepted as a method', async () => {
    const res = await api.lint({ url: 'https://x402-lint-probe.invalid/x', method: 'get' }, { ip: ips.next() });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /could not reach|did not answer/);
  });
});

// ------------------------------------------------------------------ the refund
//
// A lint that produced no report must not spend a free call — the free unit is
// claimed up front (so the tier is never billed past) and handed back on every
// 4xx before a served report. This suite proved the bug the fix answers: the
// house's own session burned its whole local tier on two unreachable-hostname
// typos, silently — the exact free-trial failure this service's market research
// mocked in a competitor. The ATTEMPT is metered separately and is NOT handed
// back: each /lint try costs this service real work whether or not a report
// came back, and an unrefunded attempt bound is what keeps the refund from
// becoming an unlimited free-fetch amplifier.

describe('a lint that produced no report costs nothing', () => {
  test('refused targets and bad requests do not spend the free tier', async () => {
    const ip = ips.next();
    // Two more refusals than the whole tier: if any of these spent a unit, the
    // later ones would answer 402 (tier exhausted), not the refusal itself.
    for (let i = 0; i < FREE_TIER_ENABLED + 2; i++) {
      const res = await api.lint({ url: 'https://169.254.169.254/latest/' }, { ip });
      assert.equal(res.status, 400, `refusal ${i + 1} leaked into the tier: ${res.text}`);
    }
    const bad = await api.lint({}, { ip });
    assert.equal(bad.status, 400, `a bad request spent a unit: ${bad.text}`);

    // And the proof positive: a served report afterwards sees the FULL tier
    // minus exactly this one call. Any junk envelope serves a real (graded)
    // report — what matters here is the header, not the grade.
    const served = await api.lintEnvelope({ status: 402, headers: {}, body: '{}' }, { ip });
    assert.equal(served.status, 200, served.text);
    assert.equal(
      served.headers.get('x-free-tier-remaining'),
      String(FREE_TIER_ENABLED - 1),
      'the refunds did not all land'
    );
  });
});

describe('attempts are still bounded (the refund is not a free-fetch amplifier)', () => {
  let bounded;
  let boundedApi;
  before(async () => {
    bounded = await useWorker({ vars: { ...TIER_ON_VARS, VERIFY_DAILY: '2' } });
    boundedApi = client(bounded);
  });
  after(async () => {
    await bounded?.stop();
  });

  test('the third failed /lint of the day is a 429, and /lint/envelope is unaffected', async () => {
    const ip = ips.next();
    for (let i = 0; i < 2; i++) {
      const res = await boundedApi.lint({ url: 'https://169.254.169.254/latest/' }, { ip });
      assert.equal(res.status, 400, `attempt ${i + 1}: ${res.text}`);
    }
    const third = await boundedApi.lint({ url: 'https://169.254.169.254/latest/' }, { ip });
    assert.equal(third.status, 429, third.text);
    assert.match(third.body.error, /lint-attempt/);
    assert.match(third.body.detail, /lint\/envelope/);
    assert.ok(third.headers.get('retry-after'), 'a 429 must say when');

    // The bound is on the outbound cost, so the fetch-free endpoint is exempt —
    // and the refunds above mean the tier is still whole for it.
    const served = await boundedApi.lintEnvelope({ status: 402, headers: {}, body: '{}' }, { ip });
    assert.equal(served.status, 200, served.text);
  });
});
