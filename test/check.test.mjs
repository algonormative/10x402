// GET /check — the free machine front door.
//
// It is the only route an agent can call before deciding whether to spend
// anything, so it has to answer three questions completely: what does this cost,
// what will actually be checked, and how is the grade computed. Everything below
// asserts that the answers come from the SAME source the paid routes use — a
// /check that describes a different service from the one that runs is worse than
// no /check at all.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { callers, client, TIER_ON_VARS, useWorker } from './harness.mjs';
import { CHECKS, GRADE_RULES, REGIMES, SOURCE_KINDS } from '../worker/lint.js';
import { ENDPOINTS } from '../worker/catalog.js';

const ips = callers('check');
let worker;
let api;

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker?.stop();
});

describe('GET /check', () => {
  test('is free and needs no payment header', async () => {
    const { status, body } = await api.check({ ip: ips.next() });
    assert.equal(status, 200);
    assert.equal(body.service, '10x402');
  });

  test('says which x402 versions it can be paid in', async () => {
    // The service sells dual-stack conformance. Announcing anything less here
    // would be the shop with the broken sign.
    const { body } = await api.check({ ip: ips.next() });
    assert.deepEqual(body.x402_versions, [1, 2]);
    assert.equal(body.networks.v1, 'base');
    assert.equal(body.networks.v2, 'eip155:8453');
  });

  test('publishes every check by the code a report will carry', async () => {
    // The vocabulary in a report and the vocabulary here are one vocabulary, so
    // a caller can always look up what it received.
    const { body } = await api.check({ ip: ips.next() });
    assert.equal(body.checks_total, CHECKS.length);
    assert.equal(body.checks.length, CHECKS.length);
    const published = new Set(body.checks.map((c) => c.id));
    for (const check of CHECKS) {
      assert.ok(published.has(check.id), `${check.id} is not published`);
    }
  });

  test('each published check carries its severity, area, regime, core flag and summary', async () => {
    const { body } = await api.check({ ip: ips.next() });
    for (const check of body.checks) {
      assert.ok(['error', 'warn', 'info'].includes(check.severity), check.id);
      assert.ok(REGIMES.includes(check.regime), `${check.id} regime ${check.regime}`);
      assert.ok(typeof check.core === 'boolean', check.id);
      assert.ok(check.summary.length > 8, check.id);
    }
  });

  test('every published check cites where its rule comes from', async () => {
    // THE PROVENANCE SHIPS WITH THE RULE, and it ships to the caller rather
    // than living in a comment. A conformance claim a buyer cannot trace is a
    // conformance claim they have to take on faith, and this service's only
    // asset is being right about things like this.
    const { body } = await api.check({ ip: ips.next() });
    for (const check of body.checks) {
      assert.ok(Array.isArray(check.sources) && check.sources.length, `${check.id} has no sources`);
      for (const src of check.sources) {
        assert.ok(SOURCE_KINDS.includes(src.kind), `${check.id} cites kind "${src.kind}"`);
        // Not merely non-empty: a ref has to name a document, a section or a
        // line. "the spec" is not a citation.
        assert.ok(src.ref.length > 12, `${check.id} ref is too vague: ${src.ref}`);
      }
    }
  });

  test('publishes what each regime means, and which one sets the grade', async () => {
    const { body } = await api.check({ ip: ips.next() });
    for (const regime of REGIMES) {
      assert.ok(typeof body.regimes?.[regime] === 'string', `no description for regime ${regime}`);
    }
    assert.match(body.regimes.payment, /grade/i);
    assert.match(body.regimes.bazaar, /bazaar_ready|index/i);
    assert.deepEqual(body.source_kinds, SOURCE_KINDS);
  });

  test('only a payment-regime check is ever core', async () => {
    // Stated here as well as asserted at module load, because /check is where a
    // caller learns the rule and a caller should be able to verify it.
    const { body } = await api.check({ ip: ips.next() });
    for (const check of body.checks.filter((c) => c.core)) {
      assert.equal(check.regime, 'payment', `${check.id} is core outside the payment regime`);
    }
  });

  test('publishes the grade ladder rather than making callers infer it', async () => {
    const { body } = await api.check({ ip: ips.next() });
    assert.deepEqual(body.grades, GRADE_RULES);
    assert.equal(body.grades[0].grade, 'A');
    assert.match(body.grades[4].when, /core/);
  });

  test('prices every endpoint, including the free one', async () => {
    const { body } = await api.check({ ip: ips.next() });
    const byPath = Object.fromEntries(body.endpoints.map((e) => [e.path, e]));
    assert.equal(byPath['/check'].price, 'free');
    // Written out rather than derived: this is the sheet a buyer reads, and a
    // test that computed it from the same constant the Worker did would agree
    // with any re-price, including an accidental one.
    assert.equal(byPath['/lint'].price, '$0.25');
    assert.equal(byPath['/lint/one'].price, '$0.02');
    assert.equal(byPath['/lint/envelope'].price, '$0.10');
    assert.equal(byPath['/lint/envelope/one'].price, '$0.01');
    for (const endpoint of ENDPOINTS) {
      assert.ok(byPath[endpoint.path], `${endpoint.path} is not listed`);
      assert.ok(byPath[endpoint.path].input, `${endpoint.path} does not say what it takes`);
      assert.ok(byPath[endpoint.path].sample, `${endpoint.path} publishes no sample call`);
    }
  });

  test('says which routes need a check id, which fetch, and what each one covers', async () => {
    // A caller decides between four routes from this response alone. Leaving
    // them to infer "the one with /one in the path wants a `check`" is the kind
    // of inference that is right until it is not.
    const { body } = await api.check({ ip: ips.next() });
    const byPath = Object.fromEntries(body.endpoints.map((e) => [e.path, e]));

    assert.equal(byPath['/lint'].check_required, false);
    assert.equal(byPath['/lint/one'].check_required, true);
    assert.equal(byPath['/lint/envelope/one'].check_required, true);

    assert.equal(byPath['/lint'].fetches, true);
    assert.equal(byPath['/lint/one'].fetches, true);
    assert.equal(byPath['/lint/envelope'].fetches, false);
    assert.equal(byPath['/lint/envelope/one'].fetches, false);

    assert.equal(byPath['/lint'].scope, `all ${CHECKS.length} checks`);
    assert.equal(byPath['/lint/one'].scope, 'one named check');
    assert.equal(byPath['/lint/one'].paired_with, '/lint');
    assert.equal(byPath['/lint/envelope'].paired_with, '/lint/envelope/one');

    // The sample a caller is shown must be one they could send verbatim, which
    // for these two means it names a real check id.
    for (const path of ['/lint/one', '/lint/envelope/one']) {
      const named = byPath[path].sample.check;
      assert.ok(named, `${path} publishes a sample with no check`);
      assert.ok(CHECKS.some((c) => c.id === named), `${path} names a check that does not exist: ${named}`);
    }
  });

  test('publishes the arithmetic of the sheet, not just the numbers — per rail', async () => {
    // A caller with a stack of questions should be able to work out, before
    // paying for any of them, exactly where the full report becomes the cheaper
    // buy ON THE RAIL THEY ARE ON. The two rails differ, so one published
    // number would be true for one caller and wrong for the other.
    const { body } = await api.check({ ip: ips.next() });
    assert.deepEqual(body.pricing.batch_multiples, { live: 12.5, pasted: 10 });
    assert.deepEqual(body.pricing.per_check_advantage, {
      live: CHECKS.length / 12.5,
      pasted: CHECKS.length / 10,
    });
    assert.deepEqual(body.pricing.singles_cheaper_through, { live: 12, pasted: 9 });
    assert.match(body.pricing.note, /12\.5x one check on a live URL/);
    assert.match(body.pricing.note, /10x on a pasted response/);
    assert.match(body.pricing.note, new RegExp(`${CHECKS.length}`));
    assert.match(body.pricing.scope_pricing, /incident/i);
    assert.match(body.pricing.per, /served/i);
  });

  test('the published single-check sample is a body a caller could send verbatim', async () => {
    const { body } = await api.check({ ip: ips.next() });
    const sample = body.endpoints.find((e) => e.path === '/lint/envelope/one').sample;
    const res = await api.post('/lint/envelope/one', sample, { ip: ips.next() });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.check, sample.check);
  });

  test('the published sample is a body a caller could send verbatim', async () => {
    // A sample that would 400 is worse than no sample: an agent will send
    // exactly what it is shown.
    const { body } = await api.check({ ip: ips.next() });
    const sample = body.endpoints.find((e) => e.path === '/lint/envelope').sample;
    const res = await api.lintEnvelope(sample, { ip: ips.next() });
    assert.equal(res.status, 200, res.text);
    assert.ok(res.body.grade);
  });

  test('reports the free tier this deployment actually enforces', async () => {
    const { body } = await api.check({ ip: ips.next() });
    assert.equal(body.free_tier_daily, Number(TIER_ON_VARS.FREE_TIER_DAILY));
  });

  test('does not leak the runaway ceiling', async () => {
    // PAID_DAILY is a bound, not a quota. Publishing it would read as a promise.
    const { text } = await api.check({ ip: ips.next() });
    assert.ok(!/2000|paid_daily|PAID_DAILY/i.test(text), 'the paid ceiling appears in /check');
  });

  test('answers 405 to anything but GET', async () => {
    const res = await api.post('/check', {}, { ip: ips.next() });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET');
  });

  test('is CORS-open, because a browser is a legitimate caller of a free route', async () => {
    const { headers } = await api.check({ ip: ips.next() });
    assert.equal(headers.get('access-control-allow-origin'), '*');
  });
});

describe('routing', () => {
  test('an unknown path lists the real routes instead of a bare 404', async () => {
    const res = await api.post('/lintt', {}, { ip: ips.next() });
    assert.equal(res.status, 404);
    assert.ok(res.body.routes.some((r) => r.includes('/lint')));
    assert.ok(res.body.routes.some((r) => r.includes('/check')));
  });

  test('a trailing slash reaches the same endpoint', async () => {
    // 400, not 404: the route was FOUND and the body was then judged on its
    // merits. A 404 here would mean the trailing slash routed nowhere.
    const res = await api.post('/lint/envelope/', {}, { ip: ips.next() });
    assert.equal(res.status, 400, res.text);
    assert.match(res.body.error, /`status` is required/);
  });

  test('GET on a POST endpoint says which verb to use', async () => {
    const res = await api.request('/lint', { method: 'GET', ip: ips.next() });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });

  test('OPTIONS preflight is answered', async () => {
    const res = await api.request('/lint', { method: 'OPTIONS', ip: ips.next() });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-headers'), /x-payment/);
  });
});
