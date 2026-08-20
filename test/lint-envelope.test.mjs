// POST /lint/envelope — the same catalogue over a response you paste.
//
// This is the endpoint that works on staging, on localhost and on an endpoint
// that is not deployed yet, because it fetches nothing. It is also the endpoint
// the SSRF guard sends people to, so its input handling has to be forgiving in
// the ways a human pasting from a terminal actually needs — case-insensitive
// header names, headers or body omitted — and unforgiving about nothing else.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { callers, client, TIER_ON_VARS, useWorker } from './harness.mjs';
import { FIXTURES, response, v1Envelope, v2Envelope, RESOURCE_URL } from './fixtures/envelopes.mjs';
import { POSITIVE_CONTROL } from '../worker/positive-control.js';

const ips = callers('lint-envelope');
let worker;
let api;

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker?.stop();
});

const send = (payload) => api.lintEnvelope(payload, { ip: ips.next() });

describe('the endpoint agrees with the engine', () => {
  // The Worker must not be a second implementation. Every fixture is sent over
  // HTTP and the answer compared against the same expectation the pure phase
  // asserts, so a serialisation bug in the Worker cannot hide behind a green
  // engine suite.
  for (const fixture of FIXTURES) {
    test(fixture.name, async () => {
      const input = fixture.response();
      // `method` goes over the wire too. A pasted response was not fetched with
      // anything, so the route only cross-checks the declared bazaar verb when
      // the caller says which one they used — and the fixture that is ABOUT
      // that comparison has to be able to say it.
      const res = await send({
        status: input.status,
        headers: input.headers,
        body: input.body,
        ...(input.method ? { method: input.method } : {}),
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.grade, fixture.expect.grade);
      assert.deepEqual(
        res.body.findings.map((f) => f.code).sort(),
        [...fixture.expect.codes].sort(),
        JSON.stringify(res.body.findings, null, 2)
      );
    });
  }

  test('a hostile envelope cannot make the Worker answer with megabytes', async () => {
    // THE AMPLIFIER. This endpoint takes a pasted response and returns a report
    // computed from it, so an input whose report is orders of magnitude larger
    // than itself is an out-of-memory for the price of one pasted lint. Measured
    // before the bounds existed: 60 KB in, 56 MB out — 945x — inside an isolate
    // with a 128 MB ceiling.
    //
    // Asserted through the WORKER rather than only in the engine phase, because
    // what is being claimed is that the isolate survives and answers, and only
    // a real workerd can be asked that.
    const entries = Array.from({ length: 5000 }, () => ({}));
    const body = JSON.stringify({ x402Version: 1, accepts: entries });
    const paste = { status: 402, headers: { 'content-type': 'application/json' }, body };
    const inputBytes = JSON.stringify(paste).length;

    const res = await send(paste);
    assert.equal(res.status, 200, res.text.slice(0, 400));
    assert.ok(res.text.length < 256 * 1024, `the answer was ${Math.round(res.text.length / 1024)} KB`);
    assert.ok(
      res.text.length < inputBytes * 20,
      `${(res.text.length / inputBytes).toFixed(1)}x amplification`
    );
    assert.ok(res.body.findings.some((f) => f.code === 'ACCEPTS_TRUNCATED'));

    // And the worker is still there afterwards, which is the half of "survives"
    // that a size assertion cannot make.
    const after_ = await send({ status: 402, body: JSON.stringify(v1Envelope()) });
    assert.equal(after_.status, 200, after_.text);
  });

  test('a real production 402 pasted in still grades A', async () => {
    const res = await send({
      status: POSITIVE_CONTROL.status,
      headers: POSITIVE_CONTROL.headers,
      body: POSITIVE_CONTROL.body,
      url: POSITIVE_CONTROL.url,
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.grade, 'A');
    assert.deepEqual(res.body.findings, []);
  });
});

describe('the report shape', () => {
  test('carries grade, summary, findings and checks_run', async () => {
    const input = response({ v1: v1Envelope(), v2: v2Envelope(), url: RESOURCE_URL });
    const res = await send({ status: input.status, headers: input.headers, body: input.body });
    assert.deepEqual(Object.keys(res.body).sort(), ['checks_run', 'findings', 'grade', 'summary']);
    assert.equal(typeof res.body.checks_run, 'number');
    assert.deepEqual(res.body.summary.versions_detected, [1, 2]);
  });

  test('every finding carries a severity, a code, a message and a fix', async () => {
    const input = response({ v1: v1Envelope() });
    const res = await send({ status: input.status, headers: input.headers, body: input.body });
    for (const finding of res.body.findings) {
      assert.ok(['error', 'warn', 'info'].includes(finding.severity));
      assert.match(finding.code, /^[A-Z0-9_]+$/);
      assert.ok(finding.message.length > 10);
      assert.ok(finding.fix.length > 40);
    }
  });
});

describe('input handling', () => {
  test('header names are matched case-insensitively', async () => {
    const input = response({ v1: v1Envelope(), v2: v2Envelope(), url: RESOURCE_URL });
    const shouty = Object.fromEntries(
      Object.entries(input.headers).map(([k, v]) => [k.toUpperCase(), v])
    );
    const res = await send({ status: 402, headers: shouty, body: input.body });
    assert.equal(res.body.grade, 'A', JSON.stringify(res.body.findings));
  });

  test('headers may be omitted entirely', async () => {
    const res = await send({ status: 402, body: JSON.stringify(v1Envelope()) });
    assert.equal(res.status, 200);
    // No content-type to judge and no v2 header, which is honestly reported.
    assert.ok(res.body.findings.some((f) => f.code === 'V2_HEADER_PRESENT'));
  });

  test('body may be omitted entirely', async () => {
    // A v2 envelope and no body is a v2-only seller, which is a choice rather
    // than a defect: V1_ABSENT, info, and an A. It is V1_BODY_PRESENT — a warn
    // — only when nothing was published in either transport.
    const input = response({ v2: v2Envelope() });
    const res = await send({ status: 402, headers: input.headers });
    assert.equal(res.status, 200);
    assert.ok(res.body.findings.some((f) => f.code === 'V1_ABSENT'));
    assert.equal(res.body.grade, 'A');
  });

  test('a parsed body object is accepted, and the report says what that costs', async () => {
    // Re-serialising is exactly what the caller would otherwise do by hand, so
    // it is accommodated — but the "is the body well-formed JSON" check becomes
    // vacuous, and a report that did not say so would be quietly lying.
    const res = await send({ status: 402, body: v1Envelope() });
    assert.equal(res.status, 200);
    assert.match(res.body.note, /re-serialised/);
    assert.match(res.body.note, /raw response text/);
  });

  test('a raw body string does NOT get the caveat', async () => {
    const res = await send({ status: 402, body: JSON.stringify(v1Envelope()) });
    assert.equal(res.body.note, undefined);
  });
});

describe('refusals', () => {
  const refuses = async (payload, match) => {
    const res = await send(payload);
    assert.equal(res.status, 400, res.text);
    assert.match(res.body.error, match);
    // Every refusal on a paid endpoint has to teach, not just decline.
    assert.ok(res.body.fix && res.body.fix.length > 30, `no usable fix: ${res.text}`);
    return res;
  };

  test('a missing status', () => refuses({ body: '{}' }, /`status` is required/));
  test('a non-numeric status', () => refuses({ status: 'ok' }, /must be an HTTP status code/));
  test('an out-of-range status', () => refuses({ status: 9000 }, /must be an HTTP status code/));
  test('headers as an array', () => refuses({ status: 402, headers: ['a'] }, /must be a JSON object/));
  test('headers as a string', () => refuses({ status: 402, headers: 'x' }, /must be a JSON object/));

  test('an empty request body', async () => {
    const res = await api.post('/lint/envelope', '', { ip: ips.next() });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /empty/);
  });

  test('a request body that is not JSON', async () => {
    const res = await api.post('/lint/envelope', 'status=402', { ip: ips.next() });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not valid JSON/);
  });

  test('a request body that is a JSON array', async () => {
    const res = await api.post('/lint/envelope', '[1,2,3]', { ip: ips.next() });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /must be a JSON object/);
  });

  test('an oversized request body is refused by declared size', async () => {
    const res = await api.post(
      '/lint/envelope',
      JSON.stringify({ status: 402, body: 'x'.repeat(400 * 1024) }),
      { ip: ips.next() }
    );
    assert.equal(res.status, 413);
    assert.match(res.body.fix, /paste only the 402/);
  });
});

describe('the free tier, while one is configured', () => {
  test('counts down per caller and says how much is left', async () => {
    const ip = ips.pinned(1);
    const seen = [];
    for (let i = 0; i < Number(TIER_ON_VARS.FREE_TIER_DAILY); i++) {
      const res = await api.lintEnvelope({ status: 402, body: JSON.stringify(v1Envelope()) }, { ip });
      assert.equal(res.status, 200);
      seen.push(res.headers.get('x-free-tier-remaining'));
    }
    assert.deepEqual(seen, ['2', '1', '0']);
  });

  test('the call after the tier is spent answers 429 and says waiting will work', async () => {
    // This worker has no payTo, so there is no 402 to fall through to. The
    // answer splits on WHY there is nothing left, because the two cases want
    // opposite advice: a SPENT allowance is fixed by waiting, so Retry-After
    // points at the next UTC midnight. (The no-payTo-and-no-tier case gets no
    // Retry-After at all — see the production-default phase — because a header
    // promising that midnight fixes a misconfiguration is a lie a client obeys.)
    const ip = ips.pinned(2);
    for (let i = 0; i < Number(TIER_ON_VARS.FREE_TIER_DAILY); i++) {
      await api.lintEnvelope({ status: 402, body: '{}' }, { ip });
    }
    const res = await api.lintEnvelope({ status: 402, body: '{}' }, { ip });
    assert.equal(res.status, 429);
    assert.match(res.body.error, /free tier is 3 calls per day/);
    assert.equal(res.body.free_tier_daily, 3);
    const retryAfter = Number(res.headers.get('retry-after'));
    assert.ok(retryAfter > 0 && retryAfter <= 86_400, `retry-after was ${retryAfter}`);
  });

  test('the tier is per caller, not per endpoint', async () => {
    const ip = ips.pinned(3);
    await api.lintEnvelope({ status: 402, body: '{}' }, { ip });
    await api.lintEnvelope({ status: 402, body: '{}' }, { ip });
    const third = await api.lintEnvelope({ status: 402, body: '{}' }, { ip });
    assert.equal(third.headers.get('x-free-tier-remaining'), '0');
    // A different endpoint shares the same spent allowance.
    const other = await api.lint({ url: 'https://example.com/x' }, { ip });
    assert.equal(other.status, 429);
  });
});

describe('telemetry', () => {
  test('records the grade and nothing about what was linted', async () => {
    const before = await worker.d1('SELECT COUNT(*) AS n FROM lints;');
    await api.lintEnvelope(
      { status: 402, headers: { 'x-secret-host': 'unreleased.example.com' }, body: '{}' },
      { ip: ips.next() }
    );
    const rows = await worker.d1('SELECT ts, endpoint, grade, errors, warns FROM lints ORDER BY ts DESC LIMIT 1;');
    const after = await worker.d1('SELECT COUNT(*) AS n FROM lints;');
    assert.equal(Number(after[0].n), Number(before[0].n) + 1);
    assert.equal(rows[0].endpoint, 'lint-envelope');
    assert.ok(['A', 'B', 'C', 'D', 'F'].includes(rows[0].grade));

    // The table has no column that could hold it, and this asserts the schema
    // stays that way: what someone lints is their business.
    const columns = await worker.d1('PRAGMA table_info(lints);');
    const names = columns.map((c) => c.name);
    assert.deepEqual(names.sort(), ['endpoint', 'errors', 'grade', 'ts', 'warns']);
  });

  test('the single-use payment table keeps a hash and a timestamp, and nothing else', async () => {
    // It is keyed on SHA-256 of the presented payment header, which is a
    // ONE-WAY function of a payload containing a payer address. Storing the
    // payload itself — or anything else "for debugging" — would put a caller's
    // signed authorization in a table that exists to hold a boolean.
    const columns = await worker.d1('PRAGMA table_info(payment_seen);');
    assert.deepEqual(columns.map((c) => c.name).sort(), ['created_at', 'hash']);
  });
});
