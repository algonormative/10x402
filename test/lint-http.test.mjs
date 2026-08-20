// POST /lint against mock target servers. The only suite that makes an
// outbound request at all, and the only one with the SSRF guard relaxed.
//
// The targets are http servers this process runs on 127.0.0.1, serving the same
// fixture envelopes the engine phase uses. That gives the one thing a
// constructed-input test cannot: proof that the FETCH half is right — that the
// unauthenticated request really carries no payment header, that redirects are
// not followed, that the byte cap and the timeout actually bound anything, and
// that real response headers survive the trip into the linter.
//
// LINT_UNSAFE_TARGETS is set for this phase and this phase only. It is the
// gate documented in worker/fetch-target.js, and the fact that it takes a
// deliberately alarming var to make this file work is the point.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { callers, client, TIER_ON_VARS, UNSAFE_TARGET_VARS, useWorker } from './harness.mjs';
import { FIXTURES, response, v1Envelope, v2Envelope, RESOURCE_URL } from './fixtures/envelopes.mjs';
import { POSITIVE_CONTROL } from '../worker/positive-control.js';

const ips = callers('lint-http');
let worker;
let api;
let target;

/**
 * A programmable target. `target.next = {…}` decides what the NEXT request gets;
 * every request is recorded, which is what makes the negative assertions
 * possible — "no payment header was sent" is a recorded fact, not an inference.
 */
async function startTarget() {
  const state = { hits: [], next: null, hang: false, dribble: false };
  const dribblers = new Set();

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.hits.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      });

      // A socket that is accepted and then never answered — the only honest way
      // to exercise the timeout path.
      if (state.hang) return;

      // SLOW LORIS. Headers immediately, then one byte at a time, forever. It
      // is the shape that got past the old timeout entirely: the timer was
      // cleared the moment the headers arrived, so everything after this point
      // ran unbounded.
      if (state.dribble) {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.write('{');
        const timer = setInterval(() => res.write(' '), 100);
        dribblers.add({ res, timer });
        res.on('close', () => clearInterval(timer));
        return;
      }

      const canned = state.next || { status: 404, headers: {}, body: '{}' };
      res.writeHead(canned.status, canned.headers || {});
      res.end(canned.body ?? '');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    state,
    base: `http://127.0.0.1:${port}`,
    url: (path = '/api') => `http://127.0.0.1:${port}${path}`,
    serve(fixtureResponse) {
      state.next = {
        status: fixtureResponse.status,
        headers: fixtureResponse.headers,
        body: fixtureResponse.body,
      };
    },
    reset() {
      state.hits.length = 0;
      state.next = null;
      state.hang = false;
      state.dribble = false;
      for (const { res, timer } of dribblers) {
        clearInterval(timer);
        try {
          res.end();
        } catch {
          /* already gone */
        }
      }
      dribblers.clear();
    },
    get hits() {
      return state.hits;
    },
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

before(async () => {
  target = await startTarget();
  worker = await useWorker({ vars: { ...TIER_ON_VARS, ...UNSAFE_TARGET_VARS } });
  api = client(worker);
});
after(async () => {
  await worker?.stop();
  await target?.stop();
});

const lintTarget = (path = '/api', opts = {}) =>
  api.lint({ url: target.url(path), ...opts }, { ip: ips.next() });

describe('a fetched response lints the same as a pasted one', () => {
  // The fetch half must not change the verdict. Every fixture is SERVED over
  // real HTTP and the answer compared against the expectation the pure phase
  // asserts — so a header that gets mangled in transit shows up here.
  //
  // V2_RESOURCE_URL_MATCHES is excluded from the comparison, and only that one.
  // The fixtures advertise a resource.url of https://example.com/api/thing
  // while the mock target answers on 127.0.0.1, so it fires on almost all of
  // them — correctly, and for a reason that is an artefact of the test rig
  // rather than of the fixture. It is asserted on its own further down, where
  // the mismatch is the subject rather than the noise.
  const RIG_ARTEFACT = 'V2_RESOURCE_URL_MATCHES';

  // ONE FIXTURE CANNOT SURVIVE A REAL HTTP HOP, and that is a fact about HTTP
  // rather than a gap in the test. RFC 9110 field parsing strips optional
  // whitespace around a header value, so a PAYMENT-REQUIRED header padded with
  // spaces arrives here already trimmed and the fixture's fault is gone before
  // the linter sees it.
  //
  // It is not a fixture worth dropping: @x402/core tests its base64 regex
  // against the RAW header value it is handed, so a seller whose framework
  // emits a padded value — or whose proxy preserves one — really does publish
  // an envelope some clients discard unread. The place to catch it is
  // /lint/envelope, where the caller supplies the header string directly, and
  // test/lint-envelope.test.mjs asserts it there.
  const NOT_REPRODUCIBLE_OVER_HTTP = new Set(['a v2 header padded with whitespace']);

  for (const fixture of FIXTURES.filter((f) => !NOT_REPRODUCIBLE_OVER_HTTP.has(f.name))) {
    test(fixture.name, async () => {
      target.reset();
      target.serve(fixture.response());
      // No `method` override: this route's default probe verb is POST, which is
      // the verb every fixture is written against. The one fixture that is ABOUT
      // a declared-verb disagreement declares PUT while being probed with POST,
      // so the default is exactly the condition it needs.
      const res = await lintTarget();
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(
        res.body.findings.map((f) => f.code).filter((c) => c !== RIG_ARTEFACT).sort(),
        [...fixture.expect.codes].sort(),
        JSON.stringify(res.body.findings, null, 2)
      );
      // The grade is compared against the fixture's only when the artefact
      // cannot have moved it — and it cannot, because it is info-severity.
      assert.equal(res.body.grade, fixture.expect.grade);
    });
  }

  test('the padded-header fixture is stripped BY HTTP, not by this linter', () => {
    // VERIFY THE EXCUSE. A skipped fixture with a plausible reason is how a
    // real gap gets written down as a known limitation, so the reason is
    // asserted rather than asserted-to-be-true: the fixture is genuinely
    // padded, and the pure engine genuinely catches it.
    const fixture = FIXTURES.find((f) => NOT_REPRODUCIBLE_OVER_HTTP.has(f.name));
    assert.ok(fixture, 'the skipped fixture no longer exists — remove the skip');
    const header = fixture.response().headers['payment-required'];
    assert.notEqual(header, header.trim(), 'the fixture is not actually padded');
    assert.deepEqual(fixture.expect.codes, ['V2_B64_URLSAFE']);
  });

  test('a real production 402, replayed over the wire, still grades A', async () => {
    target.reset();
    target.serve({
      status: POSITIVE_CONTROL.status,
      headers: POSITIVE_CONTROL.headers,
      body: POSITIVE_CONTROL.body,
    });
    const res = await lintTarget();
    assert.equal(res.body.grade, 'A', JSON.stringify(res.body.findings, null, 2));
  });
});

describe('the request this service sends', () => {
  test('carries no payment header of either version', async () => {
    // The whole point of the call is to see what an UNPAID caller sees. A
    // payment header would make the report a description of a different request
    // from the one the buyer is asking about.
    target.reset();
    target.serve(response({ v1: v1Envelope(), v2: v2Envelope() }));
    await lintTarget();
    const sent = target.hits[0].headers;
    assert.equal(sent['x-payment'], undefined);
    assert.equal(sent['payment-signature'], undefined);
    assert.equal(sent.authorization, undefined);
    assert.equal(sent.cookie, undefined);
  });

  test('is exactly ONE request', async () => {
    target.reset();
    target.serve(response({ v1: v1Envelope(), v2: v2Envelope() }));
    await lintTarget();
    assert.equal(target.hits.length, 1);
  });

  test('defaults to POST with an empty JSON body', async () => {
    target.reset();
    target.serve(response({ v1: v1Envelope() }));
    await lintTarget();
    assert.equal(target.hits[0].method, 'POST');
    assert.equal(target.hits[0].body, '{}');
    assert.match(target.hits[0].headers['content-type'], /application\/json/);
  });

  test('sends GET with no body when asked', async () => {
    target.reset();
    target.serve(response({ v1: v1Envelope() }));
    await lintTarget('/api', { method: 'GET' });
    assert.equal(target.hits[0].method, 'GET');
    assert.equal(target.hits[0].body, '');
  });

  test('identifies itself, so a seller reading their logs knows what hit them', async () => {
    target.reset();
    target.serve(response({ v1: v1Envelope() }));
    await lintTarget();
    assert.match(target.hits[0].headers['user-agent'], /10x402/);
  });

  test('preserves the path and query it was given', async () => {
    target.reset();
    target.serve(response({ v1: v1Envelope() }));
    await lintTarget('/deep/path?a=1&b=2');
    assert.equal(target.hits[0].url, '/deep/path?a=1&b=2');
  });
});

describe('redirects are reported, not followed', () => {
  test('a 302 is one request and one finding', async () => {
    target.reset();
    target.state.next = {
      status: 302,
      headers: { location: `${target.base}/elsewhere` },
      body: '',
    };
    const res = await lintTarget('/moved');

    assert.equal(target.hits.length, 1, 'the redirect was followed');
    assert.equal(res.status, 200);
    const redirect = res.body.findings.find((f) => f.code === 'HTTP_REDIRECT');
    assert.ok(redirect, JSON.stringify(res.body.findings));
    assert.match(redirect.message, /302/);
    assert.match(redirect.fix, /drops the header|do not follow redirects/i);
  });

  test('a redirect to a private address is still not followed', async () => {
    // The classic SSRF bypass: a public URL that 302s to the metadata endpoint.
    // `redirect: 'manual'` is what stops it, and this asserts the stop.
    target.reset();
    target.state.next = {
      status: 307,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      body: '',
    };
    const res = await lintTarget('/bounce');
    assert.equal(target.hits.length, 1);
    assert.equal(res.status, 200);
    assert.ok(res.body.findings.some((f) => f.code === 'HTTP_REDIRECT'));
    // Nothing from the metadata service can be in the report, because nothing
    // was fetched from it.
    assert.ok(!res.text.includes('meta-data/iam'), 'the redirect target leaked into the report');
  });
});

describe('bounds', () => {
  test('a body past the cap is read to the cap and the report says so', async () => {
    target.reset();
    target.state.next = {
      status: 402,
      headers: { 'content-type': 'application/json' },
      body: `{"x402Version":1,"pad":"${'a'.repeat(300 * 1024)}"}`,
    };
    const res = await lintTarget();
    assert.equal(res.status, 200);
    assert.match(res.body.truncated, /256 KB/);
    // A truncated body is not valid JSON, and reporting that honestly is
    // better than pretending to have read the whole thing.
    assert.ok(res.body.findings.some((f) => f.code === 'V1_BODY_JSON'));
  });

  test('a target that dribbles its BODY forever is bounded by the same deadline', async () => {
    // THE HALF THE TIMEOUT DID NOT COVER. clearTimeout ran the moment `fetch`
    // resolved — which is when the response HEADERS arrive — so the body read
    // that follows had no bound at all. A target that answered instantly and
    // then sent one byte every so often held a Worker open far past the
    // timeout; measured at 17x it. The guard was on the wrong half of the
    // request.
    //
    // LINT_TIMEOUT_MS is 700 in this phase, so the deadline is the only thing
    // that can end this: the target never stops writing.
    target.reset();
    target.state.dribble = true;
    const started = Date.now();
    const res = await lintTarget();
    const elapsed = Date.now() - started;

    assert.equal(res.status, 400, res.text);
    assert.match(res.body.error, /did not finish sending its response within/);
    assert.ok(elapsed < 5000, `took ${elapsed}ms — the read ran past the deadline`);
    // And it is reported as a timeout rather than as a lint of the two bytes
    // that did arrive: we never saw the response, so we have nothing to say
    // about the envelope.
    assert.equal(res.body.grade, undefined);
    target.reset();
  });

  test('a target that never answers times out instead of hanging the request', async () => {
    // LINT_TIMEOUT_MS is 700 in this phase, so this proves the PATH in under a
    // second rather than making the suite wait the production ten.
    target.reset();
    target.state.hang = true;
    const started = Date.now();
    const res = await lintTarget();
    const elapsed = Date.now() - started;

    assert.equal(res.status, 400, res.text);
    assert.match(res.body.error, /did not answer within/);
    assert.match(res.body.fix, /BEFORE checking for payment/);
    assert.ok(elapsed < 5000, `took ${elapsed}ms — the timeout did not fire`);
    target.state.hang = false;
  });
});

describe('the report describes the call that was made', () => {
  test('echoes the URL, method and status it saw', async () => {
    target.reset();
    target.serve(response({ v1: v1Envelope(), v2: v2Envelope() }));
    const res = await lintTarget('/api/thing');
    assert.equal(res.body.target.url, target.url('/api/thing'));
    assert.equal(res.body.target.method, 'POST');
    assert.equal(res.body.target.status, 402);
  });

  test('a resource.url that disagrees with the URL called is an info finding', async () => {
    // Only reachable on this endpoint — /lint/envelope has no URL to compare
    // against — so it is asserted here rather than in the engine phase.
    target.reset();
    target.serve(response({ v1: v1Envelope(), v2: v2Envelope(), url: RESOURCE_URL }));
    const res = await lintTarget();
    const mismatch = res.body.findings.find((f) => f.code === 'V2_RESOURCE_URL_MATCHES');
    assert.ok(mismatch, JSON.stringify(res.body.findings));
    assert.equal(mismatch.severity, 'info');
    assert.match(mismatch.message, /example\.com/);
    // Info never moves the grade, so a URL mismatch cannot fail an otherwise
    // conformant endpoint.
    assert.equal(res.body.grade, 'A');
  });
});
