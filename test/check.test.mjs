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
import { CHECKS, GRADE_RULES } from '../worker/lint.js';
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

  test('each published check carries its severity, area, core flag and summary', async () => {
    const { body } = await api.check({ ip: ips.next() });
    for (const check of body.checks) {
      assert.ok(['error', 'warn', 'info'].includes(check.severity), check.id);
      assert.ok(typeof check.core === 'boolean', check.id);
      assert.ok(check.summary.length > 8, check.id);
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
    assert.equal(byPath['/lint'].price, '$0.01');
    assert.equal(byPath['/lint/envelope'].price, '$0.005');
    for (const endpoint of ENDPOINTS) {
      assert.ok(byPath[endpoint.path], `${endpoint.path} is not listed`);
      assert.ok(byPath[endpoint.path].input, `${endpoint.path} does not say what it takes`);
      assert.ok(byPath[endpoint.path].sample, `${endpoint.path} publishes no sample call`);
    }
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
