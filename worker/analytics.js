// PostHog capture from the edge, over plain fetch.
//
// WHY THIS FILE EXISTS AT ALL. The `settlements` and `lints` tables are the
// ledger — exact, private, and the source of truth for anything about money.
// They answer "what did we earn". They do not answer "who is knocking, and
// where do they stop", because the interesting failures on this service are all
// things that never reach a table: a 402 that nobody ever pays, an AI crawler
// that reads /check every hour and never buys, an indexer prober that quietly
// stopped calling. This file is the shape of the funnel, and only that.
//
// WHY NOT posthog-node. wrangler.toml states an invariant at the top of the
// file: this Worker has NO production npm dependencies, because the one thing
// this service sells is a correct reading of a spec, and a supply chain is a
// place for that reading to change without anyone deciding to change it.
// Analytics is the least good reason in the world to break that. The capture
// API is a single POST of a JSON object, so it is a single POST of a JSON
// object.
//
// THE FIVE RULES ARE alerts.js's RULES, for the same reasons. They are restated
// rather than referenced because the next person to edit this file should not
// have to go and find them.
//
//   ANALYTICS NEVER TOUCHES THE CALLER. Every send runs inside ctx.waitUntil,
//   after the response has shipped, wrapped in its own try/catch. A dead
//   PostHog, a revoked token, a rate limit or a network partition costs a
//   graph and NOTHING ELSE. There is no path from this file to a status code.
//
//   NO RETRIES. ANALYTICS IS NOT A LEDGER. `settlements` is the source of
//   truth for revenue and `lints` for volume; both are written on the request
//   path and both survive PostHog being down for a week. A retry loop here
//   would buy duplicate points on a flaky network and still lose the event in
//   a real outage. Fire once, drop it, move on.
//
//   NO CONFIG IS SKIPPED BEFORE ANY NETWORK CALL. Unset is a working state — a
//   deployment that never sets POSTHOG_PROJECT_TOKEN must behave exactly as if
//   this file did not exist, and must not pay a DNS lookup to find that out.
//
//   NOTHING THE CALLER OWNS LEAVES THIS WORKER. Not the linted URL, not the
//   pasted envelope, not the report, not the raw IP. That is the same line
//   recordLintSafely already draws in worker.js — what was linted is the
//   caller's business; what this service is good at is ours — and it is drawn
//   here in the same place. What ships is: which endpoint, what happened, and
//   the user agent, which is the one field that makes agent traffic legible
//   and which every server on the internet already logs.
//
//   EVENTS ARE ANONYMOUS. `$process_person_profile: false` on every send. There
//   are no accounts on this service, nobody logs in, and there is nothing a
//   person profile could usefully hold. It is also roughly 4x cheaper to
//   ingest, which matters on a service whose whole point is that a single call
//   costs a cent.
//
// WHY $http_log AND NOT $pageview. PostHog classifies traffic by user agent —
// isLikelyBot, getBotName, getTrafficType — and splits AI traffic into
// ai_crawler (training), ai_search (indexing) and ai_assistant (a person asked
// an assistant about you just now). That classification runs over `$http_log`
// events, which is the event PostHog defines for exactly this: server and edge
// logs for traffic that never runs JavaScript. On a service whose entire market
// is programs, every single call is that traffic. The static page's browser
// snippet sees the humans; this sees the customers.

import { paymentPresented } from './x402.js';

const DEFAULT_HOST = 'https://us.i.posthog.com';

// Generous, because nobody is waiting: the response shipped before this ran. It
// exists only so a hung socket cannot pin a waitUntil open indefinitely.
const CAPTURE_TIMEOUT_MS = 5_000;

/** The event names, in one place so a rename is one edit and greppable. */
export const EVENTS = {
  httpLog: '$http_log',
  quoteIssued: 'x402 quote issued',
  reportServed: 'x402 report served',
  callRefused: 'x402 call refused',
};

/**
 * Is analytics configured?
 *
 * The ONLY authority is the token. A host with no token is not a half-working
 * deployment, it is an unconfigured one — see the third rule.
 */
export function analyticsEnabled(env) {
  return typeof env?.POSTHOG_PROJECT_TOKEN === 'string' && env.POSTHOG_PROJECT_TOKEN !== '';
}

/**
 * What a served response says happened, read off the headers the Worker
 * already set.
 *
 * DERIVED, NOT PLUMBED, and that is the whole design of this file. servedHeaders()
 * in worker.js publishes the outcome of every paid call to the caller already —
 * x-payment-verified, x-payment-error, x-free-tier-remaining. Reading them back
 * out here means handlePaid() needs ZERO edits: no analytics call threaded
 * through the claim/abandon/settle control flow, no new failure mode inside the
 * money path, and no second copy of "what tier was this" that can drift from the
 * one the caller was told. If the headers are ever wrong, the caller and the
 * graph are wrong in exactly the same way, which is the only kind of drift worth
 * having.
 */
export function outcomeOf(response) {
  const verified = response.headers.get('x-payment-verified');
  const freeRemaining = response.headers.get('x-free-tier-remaining');
  if (verified === 'true') return 'paid';
  if (freeRemaining !== null) return 'free';
  // Served, payment presented, facilitator could not confirm it. This is the
  // revenue-leaking state alerts.js pages the owner about, and it must be
  // separable in a graph from an honest sale.
  if (response.headers.get('x-payment-error')) return 'unverified';
  return 'unknown';
}

/**
 * The events one request produces.
 *
 * PURE, and separated from the sending for one reason: this is the part with
 * decisions in it, and decisions are worth testing without a network, a worker
 * or a PostHog. `test/analytics.test.mjs` runs it in Phase 1 against a hundred
 * synthetic request/response pairs in a few milliseconds.
 *
 * ALWAYS an $http_log, because the funnel's denominator is every call that
 * arrived, including the ones that 404 on a path nobody should have tried.
 * PLUS at most one business event, and only for the paid endpoints — /check is
 * the free front door and a call to it is already fully described by its
 * $http_log.
 */
export function eventsFor({ request, response, endpoint, url }) {
  const ua = request.headers.get('user-agent') || '';
  const status = response.status;
  const pathname = url.pathname;

  const events = [
    {
      event: EVENTS.httpLog,
      properties: {
        // The four properties PostHog's traffic classification reads. Without
        // $raw_user_agent none of the bot/AI functions can say anything.
        $raw_user_agent: ua,
        $host: url.host,
        $current_url: `${url.origin}${pathname}`,
        $pathname: pathname,
        status_code: status,
        method: request.method,
      },
    },
  ];

  if (!endpoint) return events;

  const base = {
    endpoint: endpoint.id,
    path: endpoint.path,
    price_usd: endpoint.price_usd,
    $raw_user_agent: ua,
    // $host ON THE BUSINESS EVENTS TOO, not just the $http_log. These land in a
    // PostHog project shared with every other house property, and $host is what
    // separates them — without it a estate-wide "which property is doing
    // anything" breakdown silently drops every sale this service makes into an
    // unattributed bucket. The browser SDK sets this automatically on the
    // static page's events; a raw capture-API call sets nothing it is not told
    // to, which is exactly the kind of asymmetry that goes unnoticed until a
    // graph is quietly wrong.
    $host: url.host,
  };

  // A 402 IS THE PRODUCT'S FRONT DOOR, NOT AN ERROR, and it is the top of the
  // only funnel that matters here: quotes issued -> reports paid for. It is
  // counted first so that ordering is visible in the code as well as in the
  // graph.
  if (status === 402) {
    return [
      ...events,
      {
        event: EVENTS.quoteIssued,
        properties: {
          ...base,
          // Why this caller got a quote rather than a report: they presented no
          // payment at all, or they presented one and this Worker declined it.
          // Both are quotes; only the second is a client that is TRYING to pay
          // and failing, which is the most valuable row in this whole file — a
          // buyer with money out, stopped by something on our side.
          //
          // READ OFF THE REQUEST, NOT THE RESPONSE, and that correction cost a
          // live probe to find. The obvious implementation reads
          // `x-payment-error` off the 402, and it is wrong: that header is set
          // by servedHeaders() only on the UNVERIFIED SERVE path, which is a
          // 200. A 402 never carries it — malformedPayment() and
          // paymentAlreadyUsed() put their reason in the envelope BODY, where
          // the client can act on it. So every quote read as
          // 'no-payment-presented', including the ones from callers who had
          // very much presented a payment.
          //
          // The request headers cannot drift like that: paymentPresented() is
          // the same function handlePaid() branches on twenty lines into the
          // paid path, so this classification is the Worker's own, not a second
          // guess at it.
          reason: paymentPresented(request) ? 'payment-rejected' : 'no-payment-presented',
        },
      },
    ];
  }

  if (status === 200) {
    return [
      ...events,
      { event: EVENTS.reportServed, properties: { ...base, tier: outcomeOf(response) } },
    ];
  }

  // Everything else on a paid path: a 405, a 400 for a body that would not
  // parse, a 429 at a ceiling, a 503 with no store. None of them settle
  // anything and none of them are quotes, but a client stuck in a loop of them
  // is a client that wanted to buy and could not, which is the most expensive
  // thing that can happen on this service and the least visible.
  return [
    ...events,
    { event: EVENTS.callRefused, properties: { ...base, status_code: status } },
  ];
}

/**
 * A stable, non-reversible caller id.
 *
 * NOT the IP, and never stored anywhere: SHA-256 over the project token and the
 * address, truncated. The token is the salt purely so the same address on a
 * different project is a different id — there is nothing secret being protected
 * here, an IP is not a secret, but an analytics store is the wrong place to
 * accumulate a list of them and this costs one hash to avoid.
 *
 * Stable across days ON PURPOSE, unlike the quota identity in worker.js, which
 * rotates its salt daily precisely so an allowance cannot be tracked across
 * days. These want opposite things: the quota key must forget, and "is the same
 * crawler still coming back in a week" must not. Neither can answer the other's
 * question, which is why this is a second function and not a shared one.
 */
async function callerId(token, request) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!ip) return 'edge-anonymous';
  const bytes = new TextEncoder().encode(`${token}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `edge-${[...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Send this request's events. Call it ONLY from inside ctx.waitUntil.
 *
 * Returns the number of events accepted for sending — 0 when analytics is off —
 * so a test can assert the no-config path made no network call at all rather
 * than inferring it from a mock that was never hit.
 */
export async function captureRequest(env, { request, response, endpoint, url }) {
  if (!analyticsEnabled(env)) return 0;

  const token = env.POSTHOG_PROJECT_TOKEN;
  const host = (env.POSTHOG_HOST || DEFAULT_HOST).replace(/\/+$/, '');
  const events = eventsFor({ request, response, endpoint, url });

  let distinctId;
  try {
    distinctId = await callerId(token, request);
  } catch {
    // crypto.subtle unavailable or failing: the events are still worth having
    // without a caller grouping. There is no path from here to the response.
    distinctId = 'edge-anonymous';
  }

  const timestamp = new Date().toISOString();
  const country = request.headers.get('cf-ipcountry') || null;

  await Promise.all(
    events.map((e) =>
      send(host, {
        api_key: token,
        event: e.event,
        distinct_id: distinctId,
        timestamp,
        properties: {
          ...e.properties,
          // No accounts, no logins, nothing a person profile could hold — and
          // ~4x cheaper to ingest. See the fifth rule.
          $process_person_profile: false,
          ...(country ? { $geoip_country_code: country } : {}),
        },
      })
    )
  );

  return events.length;
}

/** One POST. Fire once, never retried, never allowed to throw. */
async function send(host, payload) {
  const timer = AbortSignal.timeout
    ? AbortSignal.timeout(CAPTURE_TIMEOUT_MS)
    : undefined;
  try {
    await fetch(`${host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: timer,
    });
  } catch {
    // Third rule. A graph, and nothing else.
  }
}
