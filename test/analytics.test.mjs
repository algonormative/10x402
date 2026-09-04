// What one request turns into, as pure functions. No worker, no network, no
// PostHog.
//
// eventsFor() and outcomeOf() are exported precisely so this file can exist.
// The alternative — asserting analytics through a live worker against a mock
// PostHog — would test the fetch call and not the decisions, and the decisions
// are the part that can be wrong: which status is a quote, which served call
// was actually PAID for, and what never leaves this Worker.
//
// THE LAST OF THOSE IS THE ONE THAT MATTERS. worker.js draws a line at
// recordLintSafely — never the URL, never the envelope, never the report — and
// an analytics pipe is the obvious place for that line to be quietly crossed by
// someone adding "just one more useful property". The leak assertions below run
// over every event this module can emit, so crossing it fails the suite rather
// than shipping.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  EVENTS,
  REFUSAL_REASONS,
  analyticsEnabled,
  eventsFor,
  outcomeOf,
  refusalReason,
  settlementEvent,
} from '../worker/analytics.js';
import { ENDPOINTS, NETWORK_SOLANA_V1, NETWORK_SOLANA_V2 } from '../worker/catalog.js';

const UA = 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)';
const URL_ = new URL('https://10x402.com/lint');

const req = (method = 'POST', ua = UA, ip = '203.0.113.7') =>
  new Request(URL_, { method, headers: { 'user-agent': ua, 'cf-connecting-ip': ip } });

const res = (status, headers = {}) => new Response('{}', { status, headers });

const paid = ENDPOINTS.find((e) => e.path === '/lint') ?? ENDPOINTS[0];

const eventsOf = (response, endpoint = paid, request = req()) =>
  eventsFor({ request, response, endpoint, url: URL_ });

const named = (events, name) => events.filter((e) => e.event === name);

describe('analytics: configuration', () => {
  test('unset is off, and off is a working state', () => {
    assert.equal(analyticsEnabled(undefined), false);
    assert.equal(analyticsEnabled({}), false);
    assert.equal(analyticsEnabled({ POSTHOG_PROJECT_TOKEN: '' }), false);
    // A host without a token is an UNCONFIGURED deployment, not a half-working
    // one — the token is the only authority.
    assert.equal(analyticsEnabled({ POSTHOG_HOST: 'https://us.i.posthog.com' }), false);
    assert.equal(analyticsEnabled({ POSTHOG_PROJECT_TOKEN: 'phc_x' }), true);
  });
});

describe('analytics: every request produces an $http_log', () => {
  // The funnel's denominator. A call that 404s on a path nobody should have
  // tried is still a program that came here and left, and that is worth
  // counting.
  for (const status of [200, 400, 402, 404, 405, 429, 503]) {
    test(`status ${status} is logged`, () => {
      const logs = named(eventsOf(res(status), status === 404 ? null : paid), EVENTS.httpLog);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].properties.status_code, status);
    });
  }

  test('carries the four properties PostHog traffic classification reads', () => {
    // Without $raw_user_agent, isLikelyBot / getBotName / getTrafficType have
    // nothing to classify — which on a service whose entire market is programs
    // would make the graphs worthless rather than merely thinner.
    const [log] = named(eventsOf(res(200)), EVENTS.httpLog);
    assert.equal(log.properties.$raw_user_agent, UA);
    assert.equal(log.properties.$host, '10x402.com');
    assert.equal(log.properties.$pathname, '/lint');
    assert.equal(log.properties.$current_url, 'https://10x402.com/lint');
    assert.equal(log.properties.method, 'POST');
  });

  test('an unrouted path produces the log and nothing else', () => {
    const events = eventsOf(res(404), null);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, EVENTS.httpLog);
  });

  test('a missing user agent is empty, never undefined', () => {
    const request = new Request(URL_, { method: 'POST' });
    const [log] = named(eventsFor({ request, response: res(200), endpoint: paid, url: URL_ }), EVENTS.httpLog);
    assert.equal(log.properties.$raw_user_agent, '');
  });
});

describe('analytics: the funnel', () => {
  test('402 is a quote, not an error', () => {
    // The single most important classification in this file. A 402 from a paid
    // endpoint here is the product's front door — counting it as a failure
    // would make the healthiest possible day look like an outage.
    const [quote] = named(eventsOf(res(402)), EVENTS.quoteIssued);
    assert.ok(quote, 'a 402 must produce a quote event');
    assert.equal(quote.properties.endpoint, paid.id);
    assert.equal(quote.properties.price_usd, paid.price_usd);
    assert.equal(named(eventsOf(res(402)), EVENTS.callRefused).length, 0);
  });

  test('a quote says whether the caller tried to pay', () => {
    // A client that IS trying and failing to pay is a different customer from
    // one that has not tried, and only one of them is a bug report.
    const plain = named(eventsOf(res(402)), EVENTS.quoteIssued)[0];
    assert.equal(plain.properties.reason, 'no-payment-presented');

    const withPayment = new Request(URL_, {
      method: 'POST',
      headers: { 'user-agent': UA, 'x-payment': 'not-base64-json' },
    });
    const declined = named(eventsOf(res(402), paid, withPayment), EVENTS.quoteIssued)[0];
    assert.equal(declined.properties.reason, 'payment-rejected');

    // v2 renamed the header, and a v2 client that cannot pay must not read as
    // one that never tried.
    const v2 = new Request(URL_, {
      method: 'POST',
      headers: { 'user-agent': UA, 'payment-signature': 'not-base64-json' },
    });
    assert.equal(
      named(eventsOf(res(402), paid, v2), EVENTS.quoteIssued)[0].properties.reason,
      'payment-rejected'
    );
  });

  test('REGRESSION: a quote is classified from the request, never from x-payment-error', () => {
    // THE BUG THIS FILE EXISTS TO PREVENT A SECOND TIME. The first version read
    // `reason` from the response's x-payment-error header, and passed a test
    // that hand-built a 402 carrying one. No 402 this Worker produces carries
    // it — servedHeaders() sets it only on the unverified-serve path, which is
    // a 200 — so in production every quote read 'no-payment-presented',
    // including the ones from callers who had presented a payment and had it
    // refused. A live probe against `wrangler dev` found it; this test is what
    // makes finding it again unnecessary.
    //
    // Asserted as an INVERSION: a response header must not be able to change
    // the answer, and the request must be able to.
    const noPayment = req();
    const withPayment = new Request(URL_, {
      method: 'POST',
      headers: { 'user-agent': UA, 'x-payment': 'anything' },
    });
    const reasonOf = (response, request) =>
      named(eventsOf(response, paid, request), EVENTS.quoteIssued)[0].properties.reason;

    // A misleading response header changes nothing.
    assert.equal(reasonOf(res(402, { 'x-payment-error': 'malformed_payment_header' }), noPayment), 'no-payment-presented');
    // The request alone decides.
    assert.equal(reasonOf(res(402), withPayment), 'payment-rejected');
  });

  test('200 is a served report, tiered by what the caller was already told', () => {
    const tierOf = (headers) =>
      named(eventsOf(res(200, headers)), EVENTS.reportServed)[0].properties.tier;

    assert.equal(tierOf({ 'x-payment-verified': 'true' }), 'paid');
    assert.equal(tierOf({ 'x-free-tier-remaining': '2' }), 'free');
    // Served, payment presented, facilitator could not confirm it: the
    // revenue-leaking state. It must never be countable as a sale.
    assert.equal(
      tierOf({ 'x-payment-verified': 'false', 'x-payment-error': 'facilitator-unconfigured' }),
      'unverified'
    );
  });

  test('a free-tier serve with a payment presented is free, not paid', () => {
    // servedHeaders() sets x-payment-verified:false alongside the remaining
    // count in exactly this case. Reading the headers in the wrong order would
    // book it as unverified revenue leakage on a call that was never charged.
    assert.equal(
      outcomeOf(res(200, { 'x-free-tier-remaining': '1', 'x-payment-verified': 'false' })),
      'free'
    );
  });

  test('everything else on a paid path is a refusal, carrying its status', () => {
    for (const status of [400, 405, 429, 503]) {
      const [refused] = named(eventsOf(res(status)), EVENTS.callRefused);
      assert.ok(refused, `status ${status} must be counted as a refusal`);
      assert.equal(refused.properties.status_code, status);
      assert.equal(named(eventsOf(res(status)), EVENTS.reportServed).length, 0);
    }
  });

  test('every refusal names its CLASS, from a closed vocabulary', () => {
    // THE HOLE THIS CLOSES. 517 of 538 `x402 call refused` events in the
    // 2026-09-02 readout carried no reason at all — the largest single class of
    // traffic this service sees was a status_code bar with nothing to say about
    // it. A missing reason must now be impossible, not merely discouraged.
    for (const status of [400, 405, 413, 429, 500, 503, 418]) {
      const [refused] = named(eventsOf(res(status)), EVENTS.callRefused);
      assert.ok(refused, `status ${status} must be counted as a refusal`);
      assert.ok(
        REFUSAL_REASONS.includes(refused.properties.reason),
        `"${refused.properties.reason}" @ ${status} is not one of ${REFUSAL_REASONS.join(', ')}`
      );
    }
  });

  test('refusalReason is TOTAL: no status can produce an undefined or free-form reason', () => {
    // Exhaustive over every status a Response can legally carry, so a new exit
    // added to handlePaid tomorrow cannot ship a refusal with nothing on it.
    for (let status = 200; status <= 599; status++) {
      for (const request of [req(), new Request(URL_, { method: 'GET', headers: { 'x-payment': 'x' } })]) {
        const reason = refusalReason(status, request);
        assert.ok(REFUSAL_REASONS.includes(reason), `status ${status} produced "${reason}"`);
      }
    }
  });

  test('the 405 class is named, and a paid 405 is a different customer from a crawler', () => {
    // The bulk of the 405s are discovery crawlers GETting the POST-only routes
    // — /lint/envelope/one, /lint/one, /lint, /lint/envelope, /presence. That
    // is a real, nameable, harmless class.
    const crawler = named(eventsOf(res(405), paid, req('GET')), EVENTS.callRefused)[0];
    assert.equal(crawler.properties.reason, 'method-not-allowed');

    // But a 405 with a payment on it is paidWrongVerb(): someone with money
    // out, refused before anything was verified or settled. Same status, same
    // `allow` header — only the REQUEST tells them apart, which is why the
    // classification reads the request and not the response.
    const withPayment = new Request(URL_, {
      method: 'GET',
      headers: { 'user-agent': UA, 'x-payment': 'a-real-looking-payment' },
    });
    assert.equal(
      named(eventsOf(res(405), paid, withPayment), EVENTS.callRefused)[0].properties.reason,
      'payment-invalid'
    );

    // v2 renamed the header, and a v2 client must not read as a crawler.
    const v2 = new Request(URL_, { method: 'GET', headers: { 'payment-signature': 'x' } });
    assert.equal(
      named(eventsOf(res(405), paid, v2), EVENTS.callRefused)[0].properties.reason,
      'payment-invalid'
    );
  });

  test('each named refusal class maps to the status this Worker answers with', () => {
    const plain = req();
    assert.equal(refusalReason(429, plain), 'rate-limited'); // every ceiling
    assert.equal(refusalReason(413, plain), 'body-too-large'); // tooLarge()
    assert.equal(refusalReason(400, plain), 'bad-request'); // badRequest()
    assert.equal(refusalReason(503, plain), 'store-unavailable'); // no DB / fail-closed
    assert.equal(refusalReason(500, plain), 'other'); // the total fallback
  });

  test('every event carries $host, so a shared project can tell properties apart', () => {
    // These land in a PostHog project shared with the other house properties.
    // An event with no $host cannot be attributed to anything, and the failure
    // is silent: an estate-wide breakdown just shows a smaller number.
    for (const status of [200, 402, 400, 404]) {
      for (const event of eventsOf(res(status), status === 404 ? null : paid)) {
        assert.equal(event.properties.$host, '10x402.com', `${event.event} @ ${status}`);
      }
    }
  });

  test('a paid call produces exactly two events, never more', () => {
    for (const status of [200, 400, 402, 429]) {
      assert.equal(eventsOf(res(status)).length, 2, `status ${status}`);
    }
  });

  test('every endpoint in the catalogue is countable', () => {
    // A new paid route must not be able to ship invisible.
    for (const endpoint of ENDPOINTS) {
      const events = eventsOf(res(402), endpoint);
      const [quote] = named(events, EVENTS.quoteIssued);
      assert.equal(quote.properties.endpoint, endpoint.id);
      assert.equal(quote.properties.path, endpoint.path);
    }
  });
});

describe('analytics: the sale', () => {
  // `x402 payment settled` had NEVER fired with $host=10x402.com while D1 held
  // 30 settled rows: revenue on this property existed in the ledger and on
  // chain and nowhere else. It cannot come out of eventsFor — settlement runs
  // after the response, so at the moment the headers are read there is no
  // transaction to name — which is why it is its own function and its own test.
  const settled = (over = {}) =>
    settlementEvent({
      endpoint: paid,
      host: '10x402.com',
      ua: UA,
      payer: '0x00000000000000000000000000000000000000f1',
      amountAtomic: '100000',
      network: 'base',
      txHash: `0x${'ab'.repeat(32)}`,
      house: false,
      ...over,
    });

  test('carries every property a revenue readout needs', () => {
    const { event, properties } = settled();
    assert.equal(event, EVENTS.paymentSettled);
    assert.equal(properties.payer, '0x00000000000000000000000000000000000000f1');
    assert.equal(properties.amount_atomic, 100000);
    assert.equal(properties.rail, 'base');
    assert.equal(properties.tx_hash, `0x${'ab'.repeat(32)}`);
    assert.equal(properties.house, false);
    assert.equal(properties.price_usd, paid.price_usd);
    // Without $host the sale lands in an unattributed bucket in the shared
    // estate project — which is exactly the failure being fixed.
    assert.equal(properties.$host, '10x402.com');
    assert.equal(properties.endpoint, paid.id);
  });

  test('the rail is derived the same way the owner alert derives it', () => {
    // A settled event and the Telegram ping must not tell two different stories
    // about which chain the same money moved on — both go through railOf().
    assert.equal(settled({ network: 'base' }).properties.rail, 'base');
    assert.equal(settled({ network: NETWORK_SOLANA_V1 }).properties.rail, 'solana');
    assert.equal(settled({ network: NETWORK_SOLANA_V2 }).properties.rail, 'solana');
    // Pre-second-rail rows carry no network at all: Base is the rail that has
    // always been here.
    assert.equal(settled({ network: undefined }).properties.rail, 'base');
  });

  test('the house marker is on the event, so a drill is not third-party revenue', () => {
    assert.equal(settled({ house: true }).properties.house, true);
  });

  test('the amount is a NUMBER a graph can sum, and never a guess', () => {
    // The atomic string off the requirements the 402 quoted. Anything that is
    // not a digit string is null rather than NaN — a graph summing NaN reports
    // nothing at all, silently.
    assert.equal(settled({ amountAtomic: '4000' }).properties.amount_atomic, 4000);
    assert.equal(settled({ amountAtomic: undefined }).properties.amount_atomic, null);
    assert.equal(settled({ amountAtomic: 'lots' }).properties.amount_atomic, null);
  });

  test('every endpoint in the catalogue can produce a sale', () => {
    for (const endpoint of ENDPOINTS) {
      const { properties } = settled({ endpoint });
      assert.equal(properties.endpoint, endpoint.id);
      assert.equal(properties.path, endpoint.path);
      assert.equal(properties.price_usd, endpoint.price_usd);
    }
  });
});

describe('analytics: nothing the caller owns leaves this worker', () => {
  // The line worker.js already draws at recordLintSafely, asserted here because
  // an analytics pipe is where it would be crossed by accident.
  const SECRETS = [
    'https://victim.example.com/paid', // a linted target URL
    '0xdeadbeef', // a payment payload
    'GRADE_F_FINDING', // a report body
    '203.0.113.7', // the caller's raw IP
  ];

  test('no event property contains a URL under test, an envelope, a report or an IP', () => {
    const request = new Request(URL_, {
      method: 'POST',
      headers: { 'user-agent': UA, 'cf-connecting-ip': '203.0.113.7' },
    });
    const responses = [
      res(200, { 'x-payment-verified': 'true' }),
      res(402, { 'x-payment-error': 'malformed_payment_header' }),
      res(400),
      res(404),
    ];
    for (const response of responses) {
      for (const endpoint of [...ENDPOINTS, null]) {
        const blob = JSON.stringify(eventsFor({ request, response, endpoint, url: URL_ }));
        for (const secret of SECRETS) {
          assert.ok(!blob.includes(secret), `"${secret}" leaked into an analytics event`);
        }
      }
    }
  });

  test('the linted URL is not reachable from what eventsFor is given', () => {
    // Structural, not a string match: eventsFor never receives the request
    // BODY, so there is no route by which a target URL could reach an event
    // even if someone added a property tomorrow.
    const request = new Request(URL_, { method: 'POST', body: JSON.stringify({ url: SECRETS[0] }) });
    const blob = JSON.stringify(eventsFor({ request, response: res(200), endpoint: paid, url: URL_ }));
    assert.ok(!blob.includes(SECRETS[0]));
  });
});
