// POST /lint/envelope/one — one named check, served.
//
// The engine's three outcomes are asserted in the pure phase. What this file is
// about is the CONTRACT AT THE DOOR: the `check` field, what happens to a caller
// who gets it wrong, and the two things that must be true of a mistake — it
// costs nothing, and it says how to fix itself.
//
// The free tier is what makes a served report reachable without a wallet, and
// it doubles here as the meter: a request that was refunded leaves the caller's
// remaining allowance exactly where it was, which is a number this route
// publishes in a header. "Nothing was charged" is therefore an assertion rather
// than a claim.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { callers, client, FREE_TIER_ENABLED, TIER_ON_VARS, useWorker } from './harness.mjs';
import { response, v1Envelope, v2Envelope } from './fixtures/envelopes.mjs';
import { CHECKS } from '../worker/lint.js';

const ips = callers('lint-one');
let worker;
let api;

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker?.stop();
});

const one = (payload, opts = {}) => api.post('/lint/envelope/one', payload, { ip: ips.next(), ...opts });

/** A correct dual-stack 402, and a v1-only one. */
const dual = () => response({ v1: v1Envelope(), v2: v2Envelope() });
const v1Only = () => response({ v1: v1Envelope() });
const asPayload = (r, check) => ({ status: r.status, headers: r.headers, body: r.body, check });

describe('the served single-check answer', () => {
  test('a check that passes', async () => {
    const res = await one(asPayload(dual(), 'V2_B64_URLSAFE'));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.check, 'V2_B64_URLSAFE');
    assert.equal(res.body.applied, true);
    assert.equal(res.body.passed, true);
    assert.equal(res.body.finding, null);
    assert.equal(res.body.checks_run, 1);
    assert.ok(Array.isArray(res.body.sources) && res.body.sources.length, 'the rule arrived with no citation');
  });

  test('the receipt names the fuller product, with a free sample of it', async () => {
    // Every sale to date was a single check; the full report never sold once —
    // and no buyer had ever been TOLD, on the receipt, what it costs or looks
    // like. This asserts that sentence exists and is honest: the paired
    // route's real path, a price string, the total check count, and a sample
    // URL a buyer can read for free before deciding.
    const res = await one(asPayload(dual(), 'V2_B64_URLSAFE'));
    assert.equal(res.status, 200, res.text);
    const up = res.body.full_report;
    assert.ok(up, 'the single-check receipt carries no full_report');
    assert.equal(up.path, '/lint/envelope');
    assert.match(up.price, /^\$0\.\d+$/);
    assert.ok(up.checks_total > 50, 'checks_total is not the real catalogue size');
    assert.ok(up.sample.endsWith('/samples/lint-envelope.json'), up.sample);
    assert.match(up.note, /one check/);
  });

  test('a check that fails, with the fix attached', async () => {
    const res = await one(asPayload(v1Only(), 'V2_HEADER_PRESENT'));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.passed, false);
    assert.equal(res.body.finding.code, 'V2_HEADER_PRESENT');
    assert.ok(res.body.finding.fix, 'a finding with no fix is the silence this service exists to break');
    assert.equal(res.body.regime, 'bazaar');
  });

  test('a check that DID NOT APPLY says so, and does not report a pass', async () => {
    // The whole reason this route is not a filter over a report's findings.
    const res = await one(asPayload(v1Only(), 'V2_B64_URLSAFE'));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.applied, false);
    assert.equal(res.body.passed, null);
    assert.equal(res.body.checks_run, 0);
    assert.match(res.body.note, /NOT a pass/);
    // And the wire form must carry the null rather than dropping the key —
    // JSON.stringify keeps nulls, and a missing `passed` would read as false.
    assert.match(res.text, /"passed":\s*null/);
  });

  test('it carries no grade and no bazaar_ready — those are whole-report verdicts', async () => {
    const res = await one(asPayload(dual(), 'V2_PAYTO'));
    assert.equal(res.body.grade, undefined);
    assert.equal(res.body.findings, undefined);
    assert.equal('bazaar_ready' in res.body.summary, false);
    assert.ok(res.body.summary.payTo, 'the envelope description is context and should stay');
  });

  test('the full-report route on the same input still answers with the full report', async () => {
    // The cheap route must not have replaced the product.
    const input = v1Only();
    const full = await api.lintEnvelope({ status: input.status, headers: input.headers, body: input.body }, { ip: ips.next() });
    assert.equal(full.status, 200, full.text);
    assert.ok(full.body.grade);
    assert.ok(full.body.findings.length >= 1);
    assert.equal(full.body.check, undefined);
  });
});

describe('naming the check', () => {
  test('a missing check is a 400 pointing at the free catalogue', async () => {
    const res = await one({ status: 402 });
    assert.equal(res.status, 400, res.text);
    assert.match(res.body.error, /`check` is required/);
    assert.match(res.body.fix, /GET \/check/);
    assert.match(res.body.fix, new RegExp(`${CHECKS.length} check ids`));
  });

  test('an unknown check is a 400 that names what was asked for and suggests near misses', async () => {
    const res = await one({ status: 402, check: 'V2_B64_URLSAF' });
    assert.equal(res.status, 400, res.text);
    assert.match(res.body.error, /no check "V2_B64_URLSAF"/);
    assert.match(res.body.error, /nothing was charged/);
    assert.match(res.body.fix, /V2_B64_URLSAFE/, 'the near miss was not suggested');
  });

  test('a check id that is not a string is refused as such', async () => {
    const res = await one({ status: 402, check: ['V2_PAYTO'] });
    assert.equal(res.status, 400, res.text);
    assert.match(res.body.error, /must be a single check id as a string/);
  });

  test('an absurd check id is bounded before it is echoed back', async () => {
    // The error message quotes what the caller sent, and what the caller sent
    // is caller-controlled. 200 KB in, 200 KB back out is the amplifier this
    // repo keeps finding in its own surfaces.
    const res = await one({ status: 402, check: 'V2_'.padEnd(4000, 'X') });
    assert.equal(res.status, 400);
    assert.ok(res.text.length < 4000, `the 400 was ${res.text.length} bytes`);
  });

  test('a lower-cased id still finds its check', async () => {
    // The ids are shouted constants and a caller copying one out of prose will
    // sometimes lower-case it. Nothing else is normalised — a near miss should
    // be told it is a near miss.
    const res = await one(asPayload(dual(), 'v2_b64_urlsafe'));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.check, 'V2_B64_URLSAFE');
  });
});

describe('a mistake costs nothing', () => {
  test('three refused calls leave the free-tier allowance untouched', async () => {
    // NOBODY IS CHARGED FOR A REPORT THAT WAS NOT SERVED, measured rather than
    // asserted: with a free tier of 3, three 400s followed by a real call must
    // still leave two units — which is only true if every refusal handed its
    // claim back.
    const ip = ips.pinned(1);
    for (const bad of [{ status: 402 }, { status: 402, check: 'NOPE' }, { status: 402, check: 7 }]) {
      const res = await api.post('/lint/envelope/one', bad, { ip });
      assert.equal(res.status, 400, res.text);
    }

    const served = await api.post('/lint/envelope/one', asPayload(dual(), 'V2_PAYTO'), { ip });
    assert.equal(served.status, 200, served.text);
    assert.equal(
      served.headers.get('x-free-tier-remaining'),
      String(FREE_TIER_ENABLED - 1),
      'a refused call spent part of the allowance'
    );
  });

  test('a bad body is refused the same way, and also for free', async () => {
    const ip = ips.pinned(2);
    const bad = await api.post('/lint/envelope/one', { check: 'V2_PAYTO' }, { ip });
    assert.equal(bad.status, 400, bad.text);
    assert.match(bad.body.error, /`status` is required/);

    const served = await api.post('/lint/envelope/one', asPayload(dual(), 'V2_PAYTO'), { ip });
    assert.equal(served.headers.get('x-free-tier-remaining'), String(FREE_TIER_ENABLED - 1));
  });
});

describe('the telemetry a single check leaves behind', () => {
  test('the lints row carries the endpoint and a pass/fail/n-a verdict, never a fabricated grade', async () => {
    // The `lints` table's grade column now holds two vocabularies, told apart
    // by `endpoint`. A single-check row grading itself "A" would poison the one
    // query this table exists for: is the catalogue finding anything.
    await api.post('/lint/envelope/one', asPayload(dual(), 'V2_PAYTO'), { ip: ips.next() });
    await api.post('/lint/envelope/one', asPayload(v1Only(), 'V2_HEADER_PRESENT'), { ip: ips.next() });
    await api.post('/lint/envelope/one', asPayload(v1Only(), 'V2_B64_URLSAFE'), { ip: ips.next() });

    const rows = await worker.d1(
      "SELECT endpoint, grade, errors, warns FROM lints WHERE endpoint = 'lint-envelope-one' ORDER BY rowid DESC LIMIT 3;"
    );
    const grades = rows.map((r) => r.grade).sort();
    assert.deepEqual(grades, ['fail', 'n/a', 'pass'].sort(), JSON.stringify(rows));
    for (const row of rows) {
      assert.ok(!/^[A-F]$/.test(row.grade), `a single-check row graded itself ${row.grade}`);
    }
    const failed = rows.find((r) => r.grade === 'fail');
    assert.equal(Number(failed.errors), 1, 'the error-severity finding was not counted');
  });

  test('it records no URL, no envelope and no report — the schema has nowhere to put them', async () => {
    const columns = await worker.d1('PRAGMA table_info(lints);');
    assert.deepEqual(
      columns.map((c) => c.name).sort(),
      ['endpoint', 'errors', 'grade', 'ts', 'warns'],
      'the telemetry table grew a column that could hold what somebody linted'
    );
  });
});

describe('the route itself', () => {
  test('answers 405 to a GET, naming the verb', async () => {
    const res = await api.request('/lint/envelope/one', { method: 'GET', ip: ips.next() });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });

  test('a trailing slash reaches the same endpoint', async () => {
    const res = await api.post('/lint/envelope/one/', { status: 402 }, { ip: ips.next() });
    assert.equal(res.status, 400, res.text);
    assert.match(res.body.error, /`check` is required/);
  });

  test('the 404 listing names all four paid routes with their prices', async () => {
    const res = await api.post('/lint/envelop', {}, { ip: ips.next() });
    assert.equal(res.status, 404);
    const listed = res.body.routes.join('\n');
    for (const [path, price] of [
      ['/lint', '$0.25'],
      ['/lint/one', '$0.02'],
      ['/lint/envelope', '$0.10'],
      ['/lint/envelope/one', '$0.01'],
    ]) {
      assert.match(listed, new RegExp(`POST ${path.replace(/\//g, '\\/')} — \\${price}`), `${path} is not listed`);
    }
  });
});
