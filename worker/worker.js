// The 10x402 API Worker.
//
//   GET  /check              free. Service info, the whole check catalogue,
//                            prices, the grade ladder, x402 versions. No D1,
//                            no fetch.
//   POST /lint               $0.10. One unauthenticated request to a URL you
//                            name, then the full check catalogue over what came
//                            back.
//   POST /lint/one           $0.02. The same outbound request, reported for ONE
//                            named check.
//   POST /lint/envelope      $0.05. The full catalogue over a response you
//                            paste. No outbound request at all.
//   POST /lint/envelope/one  $0.01. ONE named check over a response you paste.
//
// Prices, paths and which route fetches all come from worker/catalog.js, and the
// routing table is built from it — a new route is a row there, never a branch
// here. THE DEPLOYED ROUTES ALREADY COVER THE SINGLE-CHECK PATHS: wrangler.toml
// publishes `10x402.com/lint` and `10x402.com/lint/*`, and the wildcard matches
// `/lint/one` and `/lint/envelope/one` as it already matched `/lint/envelope`.
// Nothing was added there, and that is checked rather than assumed — see the
// route note in wrangler.toml.
//
// ------------------------------------------------------------------ the shape of it
//
// 402 IS THE FRONT DOOR. An unauthenticated call answers immediately with an
// x402 envelope in BOTH protocol versions, and that answer touches no store: no
// salt read, no quota claim, no D1 write. Two reasons, and they are both
// load-bearing. It is the CPU-minimal reject path, which is what keeps a
// scanned public endpoint cheap. And CDP Bazaar health-probes an
// unauthenticated request expecting a 402, on an interval, forever — a service
// that answers 200 to a fresh caller is not indexed, and one that starts
// answering 200 is DELISTED. There is no free tier by default, and the check
// catalogue this service sells says exactly that about everyone else's endpoint
// too (HTTP_FREE_TIER_200).
//
// THE ORDER OF THE PAID PATH IS THE SECURITY MODEL, and it is worth reading as
// one list because each step is there to bound the one after it:
//
//   1. no payment presented, no free tier   the 402, no store access at all
//   2. a header that does not decode        the same 402, no store access, no
//                                           facilitator call, NO LEDGER ROW —
//                                           bytes are not an event
//   3. the global daily bound               a doomsday day spends nobody's
//                                           personal allowance
//   4. a configured free tier                claimed first, always
//   5. the per-caller VERIFY quota           claimed BEFORE the facilitator is
//                                           called, because the call is what
//                                           costs and a decodable payload is
//                                           free to produce
//   6. verify                                one outbound POST
//   7. the single-use payment claim          one authorization buys one report
//   8. the per-caller call quota             the runaway bound on served work
//   9. the work, then settle in waitUntil
//
// Steps 2, 5 and 7 were all missing. Together they made the paid path an
// unauthenticated amplifier: junk bytes wrote unmetered D1 rows, decodable junk
// forced an Ed25519 signature and an outbound POST per request, and one real
// one real payment replayed concurrently bought as many reports as the per-IP
// ceiling allowed.
//
// TWO RULES INHERITED FROM THE CHASSIS, and they are the ones worth protecting:
//
//   NOTHING IS EVER FAKE-VERIFIED. `x-payment-verified: true` appears only
//   after a facilitator round trip that returned isValid, and no settlement
//   receipt is ever emitted for a settlement that has not happened.
//
//   NOBODY IS CHARGED FOR A LINT THAT WAS NOT SERVED. Settlement is queued only
//   after the report exists. Every exit between the payment check and that
//   point is a 4xx, and a verified-but-unsettled authorization simply goes
//   unused — an EIP-3009 authorization moves nothing until someone submits it,
//   and nobody does. So a bad URL, an unreachable target or a malformed paste
//   costs the caller nothing.

import {
  BATCH_MULTIPLE,
  ENDPOINTS,
  ENDPOINTS_BY_ID,
  ENDPOINTS_BY_PATH,
  FREE_ENDPOINT,
  MAX_BODY_BYTES,
  NETWORK_V1,
  NETWORK_V2,
  SERVICE_NAME,
  SERVICE_TAGLINE,
  SITE_BASE,
  SUPPORT_EMAIL,
  batchAdvantageLine,
  perCheckAdvantage,
  priceLabel,
} from './catalog.js';
import { CHECKS, CHECKS_BY_ID, GRADE_RULES, SOURCE_KINDS, lint, lintOne } from './lint.js';
import {
  build402,
  paymentRequired,
  paymentRequirements,
  requirementsV2,
  resourceInfoV2,
} from './envelope.js';
import { fetchTarget, unsafeTargetsAllowed } from './fetch-target.js';
import { claimQuota, refundQuota } from './quota.js';
import {
  oneLineMessage,
  paymentPresented,
  presentedPayment,
  publicReason,
  settlePayment,
  sha256Hex,
  truncatedHash,
  verifyPayment,
  randomHex,
} from './x402.js';
import { sendPaymentAlert } from './alerts.js';

// A runaway bound on calls we actually serve, per caller per UTC day. NOT a
// quota to advertise — publishing it would read as a promise — so it is
// deliberately absent from /check and from the page. OWNER-TUNABLE.
const PAID_DAILY = 2000;

// A runaway bound on how many payments one caller may have CHECKED in a day,
// which is a different and much smaller number than how many calls it may be
// served. Every verify is an outbound POST to the facilitator carrying a freshly
// signed Ed25519 JWT, so it costs us CPU and a round trip whether or not the
// payment is any good — and a caller who sends garbage that merely DECODES pays
// nothing at all for it. Without this bound that is an unbounded outbound-call
// amplifier reachable by anyone with a socket.
//
// Fifty is far above any honest client. A real one presents a payment, gets its
// report, and moves on; the only way to spend fifty verifies in a day is to be
// failing verification repeatedly, which is not a state to help someone stay in.
const VERIFY_DAILY = 50;

/**
 * The verify ceiling. Env-tunable so the suite can exhaust it in three calls
 * rather than fifty-one, and clamped at both ends: a value below 1 would refuse
 * every payment this deployment was sent, and an unbounded one would put the
 * amplifier back.
 */
function verifyDaily(env) {
  const raw = Number(env?.VERIFY_DAILY ?? VERIFY_DAILY);
  if (!Number.isFinite(raw)) return VERIFY_DAILY;
  return Math.min(500, Math.max(1, Math.floor(raw)));
}

const SECONDS_PER_DAY = 86_400;

/**
 * Seconds until the counters reset, for Retry-After. Never zero and never
 * negative: a Retry-After of 0 tells a client to hammer immediately, which is
 * the opposite of what a rate limit is asking for. Falls back to a whole day
 * when the caller had no clock to pass (the 402 fast path, which never reaches
 * a branch that needs one).
 */
const secondsToReset = (now, dayStart) =>
  Number.isFinite(now) && Number.isFinite(dayStart)
    ? Math.max(1, dayStart + SECONDS_PER_DAY - now)
    : SECONDS_PER_DAY;

// The request body cap. Generous for /lint (a URL) and sized for /lint/envelope,
// where the pasted body IS a whole HTTP response.
const MAX_REQUEST_BODY = MAX_BODY_BYTES + 64 * 1024;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, x-payment, payment-signature',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const json = (body, status = 200, headers = {}) =>
  new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...headers },
  });

/**
 * The free tier, per caller per UTC day. 0 (the default) means there is none.
 *
 * THE ENV VAR IS THE ONLY AUTHORITY, AND UNSET IS OFF. Anything unparseable,
 * negative or fractional-below-one reads as 0: a misconfigured var must fail
 * towards "charge for it", never towards "give it away". A typo in a dashboard
 * field should not become an unbounded free service — and, on this particular
 * product, a free tier would also make the endpoint fail its own
 * HTTP_FREE_TIER_200 check, which would be embarrassing in a way that is
 * difficult to explain away.
 */
function freeTierDaily(env) {
  const raw = Number(env?.FREE_TIER_DAILY ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (path === '/check') return handleCheck(request, env);

    const endpoint = ENDPOINTS_BY_PATH.get(path);
    if (endpoint) return handlePaid(request, env, ctx, endpoint);

    return json(
      {
        error: `no route ${path}`,
        service: SERVICE_NAME,
        routes: [
          `GET ${FREE_ENDPOINT.path} — free`,
          ...ENDPOINTS.map((e) => `${e.method} ${e.path} — ${priceLabel(e.price_usd)}`),
        ],
      },
      404
    );
  },
};

// ------------------------------------------------------------------ GET /check
//
// The free machine front door. Everything a caller needs to decide whether to
// pay: what the endpoints cost, what the checks are, and how the grade is
// computed. The check catalogue is published in full and by CODE, so a report's
// `code` field can always be looked up without guessing — and so a seller can
// read what will be checked before spending a cent.

function handleCheck(request, env) {
  if (request.method !== 'GET') {
    return json({ error: 'GET only' }, 405, { allow: 'GET' });
  }

  const tier = freeTierDaily(env);

  return json({
    service: SERVICE_NAME,
    tagline: SERVICE_TAGLINE,
    home: SITE_BASE,
    support: SUPPORT_EMAIL,
    // Which x402 versions a caller can PAY in. Both, so a client of either
    // generation can buy — and this service lints for exactly that property in
    // other people's endpoints, so it had better hold here.
    x402_versions: [1, 2],
    networks: { v1: NETWORK_V1, v2: NETWORK_V2 },
    endpoints: [
      {
        method: FREE_ENDPOINT.method,
        path: FREE_ENDPOINT.path,
        price: priceLabel(FREE_ENDPOINT.price_usd),
        description: FREE_ENDPOINT.description,
      },
      ...ENDPOINTS.map((e) => ({
        method: e.method,
        path: e.path,
        price: priceLabel(e.price_usd),
        description: e.description,
        input: e.inputDescription,
        output: e.outputDescription,
        // Stated as data, not left for a reader to infer from the path: which
        // routes need a `check`, which ones make an outbound request on the
        // caller's behalf, and which fuller or cheaper route is the sibling of
        // this one.
        scope: e.single ? 'one named check' : `all ${CHECKS.length} checks`,
        check_required: e.single === true,
        fetches: e.fetches === true,
        paired_with: ENDPOINTS_BY_ID.get(e.pairedWith)?.path ?? null,
        sample: e.sample,
      })),
    ],
    // THE ARITHMETIC OF THE SHEET, published rather than implied. A caller with
    // three questions should be able to work out — before paying for any of
    // them — that the full report is the cheaper buy.
    pricing: {
      batch_multiple: BATCH_MULTIPLE,
      per_check_advantage: perCheckAdvantage(CHECKS.length),
      note: batchAdvantageLine(CHECKS.length),
      envelope_discount:
        'the pasted-response routes are half the price of the ones that fetch, because they make ' +
        'no outbound request on your behalf.',
      per: 'every price is per SERVED report — a bad URL, an unreachable target, a malformed paste ' +
        'or an unknown check id settles nothing, even when the payment verified.',
    },
    // The field stays present at 0 rather than disappearing: a reader that has
    // to tell "no free tier" from "this build forgot to say" will guess wrong.
    free_tier_daily: tier,
    grades: GRADE_RULES,
    // WHAT EACH REGIME MEANS, published beside the checks rather than left for
    // a reader to infer from the field. Two verdicts on one report is a shape
    // nobody expects until it is explained.
    regimes: {
      payment: 'the specs\' MUSTs and what shipping clients parse, throw on, or refuse to sign. These findings, and only these, set the grade.',
      bazaar: 'CDP\'s validator, prober and seller docs — what it takes to be INDEXED. These set summary.bazaar_ready and never the grade.',
      hygiene: 'house opinions and client-quirk defenses that break no payment and block no indexing. Info only, always.',
    },
    source_kinds: SOURCE_KINDS,
    checks_total: CHECKS.length,
    checks: CHECKS.map((c) => ({
      id: c.id,
      area: c.area,
      regime: c.regime,
      severity: c.severity,
      core: c.core === true,
      summary: c.summary,
      // THE PROVENANCE SHIPS WITH THE RULE. When a source of truth moves — a
      // client's schema, a CDP requirement, a spec section — the affected
      // checks are greppable by ref rather than re-derivable by argument.
      sources: c.sources,
    })),
    notes: [
      'A 402 from a paid endpoint here is a price quote, not an error.',
      'checks_run in a report is how many checks APPLIED — a v1-only endpoint legitimately skips every v2 check.',
      'A report carries TWO verdicts. `grade` answers "can I be paid" from payment-regime findings only; `summary.bazaar_ready` answers "can I be found" from bazaar-regime errors, and names its blockers. An endpoint can be grade A and bazaar_ready false — that is the commonest interesting report this service produces.',
      'Every check publishes its `sources`. A rule with no citation is a rule this service will not sell you.',
      'POST /lint sends exactly one unauthenticated request to the URL you name, follows no redirects, and reads at most 256 KB.',
      'POST /lint/envelope fetches nothing, so it works on staging, on localhost and on an endpoint that is not deployed yet.',
      'The two /one routes answer about exactly ONE check you name in a required `check` field, taken from checks[] below. An unknown id is a 400 that lints nothing and charges nothing.',
      'A single-check answer distinguishes THREE outcomes: passed true, passed false with the finding and its fix, and applied false — the named check did not run against this response, which is not a pass and is never reported as one.',
    ],
  });
}

// ------------------------------------------------------------------ the paid routes
//
// Order of checks is the reject discipline, cheapest first: method, declared
// size, then — for the unpaid call, which is the common one — the 402. All of
// that happens before the rate-limit round trip, the body read and the work.

async function handlePaid(request, env, ctx, endpoint) {
  if (request.method !== endpoint.method) {
    return json({ error: `${endpoint.method} only` }, 405, { allow: endpoint.method });
  }

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY) return tooLarge();

  const payTo = env.PAYTO || '';
  const presented = paymentPresented(request);
  const tier = freeTierDaily(env);

  // THE 402 FAST PATH. With no free tier configured and no payment presented
  // there is nothing to meter — no allowance to claim, no identity to derive —
  // so the envelope goes out with no store access at all.
  if (tier === 0 && !presented) return unpaid(endpoint, { payTo, tier });

  // A HEADER THAT DOES NOT DECODE IS NOT A PAYMENT, AND IS NOT AN EVENT.
  //
  // It used to be treated as a rejected payment: a `settlements` row written
  // before any quota was claimed, and the row went in whether or not the bytes
  // could even be base64-decoded. Twenty-five junk requests were twenty-five
  // unauthenticated, unmetered D1 writes, and nothing in the request had to be
  // real — `X-PAYMENT: junk` was enough. The ledger is the revenue record, and
  // the revenue record must mean "we talked to a facilitator about this", never
  // "someone sent us bytes".
  //
  // So it is answered exactly like the fast path above: the same 402, the same
  // envelope, no store access, no facilitator call, no row. The reason travels
  // in the response, where the caller can act on it, rather than in a table
  // nobody will read. With a free tier configured the claim below still comes
  // first — that ordering is its own rule and this must not jump it.
  const payment = presented ? presentedPayment(request) : null;
  if (tier === 0 && payment && !payment.decoded) {
    return payTo ? malformedPayment(endpoint, payTo) : unpaid(endpoint, { payTo, tier });
  }

  const db = env.DB;
  if (!db) return json({ error: 'this endpoint is unavailable' }, 503);

  const now = Math.floor(Date.now() / 1000);
  const day = new Date(now * 1000).toISOString().slice(0, 10); // UTC
  const dayStart = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

  let outcome = { kind: 'free', remaining: 0, presented };
  let settle = null;
  let alert = null;

  // The single-use claim taken on a verified payment, held so it can be given
  // back if the report is never served. Null means there is nothing to give back
  // — no payment, an unverified one, or a claim that belonged to another request.
  let paymentHash = null;

  // The free-tier unit claimed for this request, held for the same reason and
  // refunded on the same exits. Before this existed, a typo in the URL or an
  // unreachable target burned a free call silently — the exact free-trial
  // failure this service's own market research mocked in a competitor: the
  // allowance was spent before the work was possible, and nothing said so.
  let freeClaim = null;

  /**
   * Hand back whatever this request claimed, then answer.
   *
   * Wraps every 4xx between the claims and the served report — payment claim
   * and free-tier unit alike: a request that gets no report must leave the
   * caller exactly as able to get one as they were before they asked.
   * Best-effort by construction: if a compensating write fails the caller
   * loses one unit or must re-sign, which is an inconvenience, where the
   * alternative — refusing to answer a request we already declined for
   * another reason — helps nobody. Nothing is ever charged either way:
   * settlement is queued only after a report exists.
   *
   * The ATTEMPT counter is deliberately NOT refunded here — it bounds what a
   * request costs US (an outbound fetch, a facilitator round trip), and that
   * cost was paid whether or not a report came back.
   */
  const abandon = async (response) => {
    if (paymentHash) {
      const hash = paymentHash;
      paymentHash = null;
      await releasePaymentSafely(db, hash);
    }
    if (freeClaim) {
      const key = freeClaim;
      freeClaim = null;
      await refundQuota(db, day, key);
    }
    return response;
  };

  try {
    const salt = await currentSalt(db, day);
    const ip = request.headers.get('cf-connecting-ip') || '';

    // The quota key is salt + IP with NO user-agent, on purpose: rotating a UA
    // string must not mint a fresh identity. A second identity costs a second
    // IP, which is the cheapest spoof-resistance available here.
    const ipHash = await truncatedHash(salt + ip);

    // The global bound is read first: a doomsday day should not spend anyone's
    // daily allowance.
    if (await globalExceeded(db, day)) {
      return json({ error: 'daily call limit reached', retry: 'tomorrow UTC' }, 429, {
        'retry-after': String(secondsToReset(now, dayStart)),
      });
    }

    // A CONFIGURED FREE TIER IS CLAIMED FIRST, ALWAYS — that ordering IS the
    // "never bill inside the free tier" rule, expressed as control flow rather
    // than as a promise. The payment path below is only reachable once the free
    // claim has actually failed.
    const free = tier > 0 ? await claimQuota(db, day, ipHash, tier) : null;

    if (free !== null) {
      freeClaim = ipHash;
      // THE ATTEMPT BOUND, on the free FETCHING routes. The free unit above is
      // refunded when no report is served (see `abandon`) — which, alone, would
      // hand an attacker unlimited free outbound fetches: name an unreachable
      // target, eat the 10s timeout, get the unit back, repeat. So the ATTEMPT
      // is metered separately and never refunded, on the same ceiling and the
      // same reasoning as the verify bound below: the bound has to be on what
      // the request costs US, not on whether it produced anything.
      //
      // GATED ON `fetches`, NOT ON THE ID. /lint and /lint/one make the same one
      // outbound request and cost us the same thing, so they claim from the same
      // counter; the two pasted-envelope routes fetch nothing and claim nothing.
      // The paid path's outbound work is already bounded by the verify claim it
      // must pass first.
      if (endpoint.fetches) {
        const attempt = await claimQuota(db, day, `attempt:${ipHash}`, verifyDaily(env));
        if (attempt === null) {
          return abandon(
            json(
              {
                error: 'daily lint-attempt limit reached',
                detail:
                  'free attempts at the routes that fetch — served or failed — are bounded per ' +
                  'caller per UTC day, because each one costs this service an outbound request ' +
                  'whether or not it produced a report. POST /lint/envelope and ' +
                  'POST /lint/envelope/one run the same checks on a pasted response with no ' +
                  'fetch, and are not bounded this way.',
                retry: 'tomorrow UTC',
              },
              429,
              { 'retry-after': String(secondsToReset(now, dayStart)) }
            )
          );
        }
      }
      outcome = { kind: 'free', remaining: tier - free, presented };
    } else {
      if (!payTo || !presented) return unpaid(endpoint, { payTo, tier, now, dayStart });
      // The free tier is spent and the header still does not decode. Same
      // answer as the fast path above, and for the same reasons.
      if (!payment.decoded) return malformedPayment(endpoint, payTo);

      // THE VERIFY QUOTA, CLAIMED BEFORE THE FACILITATOR IS CALLED AND NOT
      // AFTER. Everything past this line costs an outbound POST and an Ed25519
      // signature, and a payload that merely decodes is free to produce — so
      // the bound has to be on the ATTEMPT, not on the outcome. Over quota is a
      // 429 with no facilitator call and no ledger row: nothing happened, so
      // nothing is recorded.
      const verifyUsed = await claimQuota(db, day, `verify:${ipHash}`, verifyDaily(env));
      if (verifyUsed === null) return verifyCeilingReached({ now, dayStart });

      const requirements = paymentRequirements(endpoint, payTo);
      // VERSION IS DECIDED ONCE, HERE, and everything downstream follows it:
      // which shape the facilitator sees on verify and on settle, and which
      // `resource` a settle body is completed with. It is read out of the
      // PAYLOAD rather than out of the header it arrived in.
      const facRequirements = payment.version === 2 ? requirementsV2(requirements) : requirements;
      const verdict = await verifyPayment(env, payment, facRequirements);

      if (verdict.rejected) {
        // The facilitator was asked and said no, so there IS something to
        // record. No work is served, so no call quota is claimed — and the 402
        // names why, so the caller can fix it rather than retrying the same bad
        // payload.
        await recordSettlementSafely(db, {
          now,
          endpoint: endpoint.id,
          payer: verdict.payer,
          amount: requirements.maxAmountRequired,
          verifyOk: 0,
          settleOk: 0,
          txHash: null,
          error: verdict.reason,
        });
        return paymentRequired(endpoint.id, payTo, {
          error: 'the payment presented was not accepted',
          invalidReason: verdict.reason,
          invalidMessage: verdict.message ?? null,
          // v2 carries one `error` and it is a CODE, not prose — x402's own
          // client branches on it — so the facilitator's reason is the honest
          // value to put there.
          v2Error: verdict.reason,
        });
      }

      // ONE PAYMENT BUYS ONE REPORT.
      //
      // Verifying a payment is a READ — the facilitator says the signature is
      // good and the funds are there, and says it again every time it is asked.
      // Nothing is spent until settle, and settle runs after the response. So
      // the same paid header presented concurrently verified every time and
      // bought a report every time; the only thing bounding it was the
      // per-caller ceiling, which is per IP and therefore not a bound at all
      // for anyone with more than one.
      //
      // The claim goes HERE: after verify, so an unverified payload cannot burn
      // a real payment's hash, and before the call quota and the work, so the
      // first request through owns the payment and the rest are turned away
      // having cost nothing. The loser writes no settlements row — the original
      // request owns that too.
      //
      // AND IT IS RELEASED IF THE REPORT IS NEVER SERVED. Claiming here means
      // claiming BEFORE the request body has even been read, and every 4xx
      // between here and the response — an empty body, a typo in the JSON, a
      // missing `url`, an SSRF-refused target, an unreachable one — would
      // otherwise leave the caller's authorization permanently spent on nothing,
      // and answer their retry with "this payment has already bought a report",
      // which would be false. That is the exact rule stated at the top of this
      // file: NOBODY IS CHARGED FOR A LINT THAT WAS NOT SERVED, and a payment
      // consumed is a charge whether or not a settlement followed it. So the
      // claim is compensated on every one of those exits — see `abandon` below.
      if (verdict.verified) {
        paymentHash = await sha256Hex(payment.raw);
        const fresh = await claimPaymentOnce(db, paymentHash, now);
        if (!fresh) {
          // Not ours to release: the request that owns it is the one that
          // claimed it, and releasing here would hand a live payment back to
          // whoever replayed it.
          paymentHash = null;
          return paymentAlreadyUsed(endpoint, payTo);
        }
      }

      // The runaway bound on served work. A request that 4xxs after this point
      // has still cost us a facilitator round trip, so it is not free to us
      // either — but it did not get a report, so the payment goes back.
      const used = await claimQuota(db, day, ipHash, PAID_DAILY);
      if (used === null) return abandon(paidCeilingReached({ now, dayStart }));

      if (verdict.verified) {
        outcome = { kind: 'paid', presented };
        settle = {
          requirements,
          facRequirements,
          version: payment.version,
          payload: verdict.payload,
          payer: verdict.payer,
          endpoint,
        };
      } else {
        // UNREACHABLE / UNCONFIGURED FACILITATOR. Availability-first: at these
        // prices the number is a signal, and turning paying callers away for OUR
        // dependency's outage is the worse failure. The response says plainly
        // that nothing was checked, and every one of these is recorded.
        outcome = { kind: 'unverified', presented, error: publicReason(verdict.unavailable) };
        await recordSettlementSafely(db, {
          now,
          endpoint: endpoint.id,
          payer: verdict.payer,
          amount: requirements.maxAmountRequired,
          verifyOk: 0,
          settleOk: 0,
          txHash: null,
          error: verdict.unavailable,
        });
        // REVENUE LEAKING, and the owner wants to hear about it while it is
        // happening. Queued rather than sent here, alongside the settle block
        // below, so a call that then 400s does not alarm about work never served.
        alert = {
          kind: 'unverified',
          tool: endpoint.id,
          payer: verdict.payer,
          amount: requirements.maxAmountRequired,
          error: publicReason(verdict.unavailable),
        };
      }
    }
  } catch {
    // Fail CLOSED on a metered endpoint: an unreachable limiter means no lints,
    // not unlimited ones. Failing open here is the runaway-cost scenario.
    return json({ error: 'this endpoint is unavailable' }, 503);
  }

  // --- read the request -------------------------------------------------
  //
  // PAYMENT FAIRNESS. Every exit from here to the settle block is a 4xx, and
  // `settle` is only ever queued after a report actually exists. Each one also
  // goes through `abandon`, which gives back the single-use claim taken on the
  // payment: a request that gets no report must leave the caller exactly as
  // able to buy one as they were before they asked.
  let body;
  try {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_REQUEST_BODY) return abandon(tooLarge());
    const raw = new TextDecoder().decode(buf).trim();
    if (!raw) return abandon(badRequest('the request body is empty', usageFor(endpoint)));
    body = JSON.parse(raw);
  } catch (err) {
    return abandon(
      badRequest(`the request body is not valid JSON: ${oneLineMessage(err)}`, usageFor(endpoint))
    );
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return abandon(badRequest('the request body must be a JSON object', usageFor(endpoint)));
  }

  // --- do the work ------------------------------------------------------
  //
  // THE NAMED CHECK IS VALIDATED FIRST, before any work at all. On /lint/one
  // that means before the outbound fetch: a typo in a check id must not spend
  // our network position, and — since every no-report exit refunds — must not
  // cost the caller anything either. It is a 400 carrying the fix, which is a
  // pointer at the free route that lists every id.
  let named = null;
  if (endpoint.single) {
    named = namedCheck(body);
    if (named.error) return abandon(badRequest(named.error, named.fix));
  }

  let report;
  try {
    report = endpoint.fetches
      ? await runUrlLint(body, env, named?.check)
      : runEnvelopeLint(body, named?.check);
  } catch (err) {
    return abandon(badRequest(`could not lint: ${oneLineMessage(err)}`, usageFor(endpoint)));
  }
  if (report.error) return abandon(badRequest(report.error, report.fix || usageFor(endpoint)));

  // Telemetry, and deliberately thin: WHICH endpoint, WHAT grade, how many
  // findings. Never the URL, never the envelope, never the report. What was
  // linted is the caller's business; what this service is good at is ours.
  await recordLintSafely(env.DB, { now: Math.floor(Date.now() / 1000), endpoint: endpoint.id, report });

  // --- settle AFTER responding -----------------------------------------
  //
  // The caller paid for a report, not for a chain confirmation, so the
  // settlement runs in ctx.waitUntil and its outcome lands in `settlements`
  // rather than in this response. The owner's alert rides in the same deferred
  // slot, for the same reason and one more: a notification must never be able
  // to slow, fail or change a response the buyer already paid for.
  const deferred = [];
  if (settle) deferred.push(settleAndRecord(env, env.DB, settle));
  if (alert) deferred.push(sendPaymentAlert(env, alert));
  if (deferred.length) {
    const work = Promise.all(deferred);
    if (ctx?.waitUntil) ctx.waitUntil(work);
    else await work; // no ctx (direct invocation): correctness over latency
  }

  return json(report, 200, servedHeaders(outcome));
}

// ------------------------------------------------------------------ the work

/**
 * The `check` field the two single-check routes require, validated.
 *
 * MISSING AND UNKNOWN ARE DIFFERENT MISTAKES and get different fixes: one
 * caller forgot a field, the other believes in a check that does not exist —
 * usually a code they remembered from a report, mistyped, or invented. Both are
 * answered with the free route that lists every id, because that is the answer
 * to both questions, and both are answered BEFORE any work is done. Neither
 * costs anything: the 400 goes through `abandon`, which hands back the payment
 * claim, and settlement is queued only after a report exists.
 */
function namedCheck(body) {
  const catalogue = `GET ${FREE_ENDPOINT.path} lists all ${CHECKS.length} check ids with what each one inspects.`;

  if (body.check === undefined || body.check === null || body.check === '') {
    return {
      error: '`check` is required — this endpoint answers about exactly one named check',
      fix: `Add {"check": "V2_B64_URLSAFE"}, naming one check id. ${catalogue} For the whole ` +
        'catalogue in one report instead, use the full-report endpoint.',
    };
  }
  if (typeof body.check !== 'string') {
    return {
      error: `\`check\` must be a single check id as a string, not ${JSON.stringify(body.check)}`,
      fix: `Exactly one id, e.g. {"check": "V2_B64_URLSAFE"}. ${catalogue}`,
    };
  }

  // Case-insensitive because the ids are shouted constants and a caller
  // copying one out of prose will sometimes lower-case it; nothing else is
  // normalised, because a near-miss should be told it is a near-miss.
  const id = body.check.trim().toUpperCase();
  if (!CHECKS_BY_ID.has(id)) {
    return {
      error: `no check "${clipId(body.check)}" — nothing was linted and nothing was charged`,
      fix: `${catalogue} Check ids are exact, e.g. V2_B64_URLSAFE, V1_PAYTO, HTTP_STATUS_402.` +
        suggestion(id),
    };
  }
  return { check: id };
}

/** A caller-supplied id, bounded before it is echoed back into a message. */
const clipId = (value) => {
  const text = String(value);
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
};

/**
 * The nearest real ids, when a typo is close to one.
 *
 * Prefix and substring only — no edit distance, because the value here is
 * turning "I meant one of the bazaar ones" into a list, and a caller who is
 * one character out is served just as well by seeing the family.
 */
function suggestion(id) {
  const stem = id.replace(/[^A-Z0-9]+/g, '_').split('_').filter(Boolean)[0] || '';
  if (!stem) return '';
  const near = CHECKS.filter((c) => c.id.startsWith(stem) || c.id.includes(id)).slice(0, 6).map((c) => c.id);
  return near.length ? ` Did you mean one of: ${near.join(', ')}?` : '';
}

/**
 * The outbound rail: fetch what the caller named, then lint it — whole, or for
 * one named check when `check` is set.
 */
async function runUrlLint(body, env, check) {
  if (body.url === undefined) {
    return {
      error: '`url` is required',
      fix:
        'POST {"url": "https://your-endpoint.example.com/path"} — and optionally ' +
        '{"method": "GET"} if the endpoint is a GET. To lint a response you already have ' +
        'instead, POST it to /lint/envelope.',
    };
  }

  const fetched = await fetchTarget(body.url, body.method, env);
  if (!fetched.ok) return { error: fetched.error, fix: fetched.fix };

  const report = check ? lintOne(fetched.input, check) : lint(fetched.input);
  return {
    ...report,
    target: { url: fetched.input.url, method: fetched.input.method, status: fetched.input.status },
    ...(fetched.input.truncated
      ? {
          truncated: `the response body was longer than ${MAX_BODY_BYTES / 1024} KB and was read to that point`,
        }
      : {}),
  };
}

/**
 * The pasted rail: lint what the caller sent — whole, or for one named check
 * when `check` is set. Nothing is fetched.
 */
function runEnvelopeLint(body, check) {
  if (body.status === undefined) {
    return {
      error: '`status` is required',
      fix:
        'POST {"status": 402, "headers": {"payment-required": "<base64>"}, "body": "<the 402 body>"} — ' +
        'the three parts of the response you want checked. `headers` and `body` may be omitted ' +
        'if the response genuinely had none, and that absence is itself a finding. Add ' +
        '{"url": "…", "method": "GET"} to have resource.url and the declared bazaar method ' +
        'cross-checked against the request that produced this response.',
    };
  }
  const status = Number(body.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return {
      error: `\`status\` must be an HTTP status code, not ${JSON.stringify(body.status)}`,
      fix: 'Send the numeric status the endpoint answered with, e.g. 402.',
    };
  }

  const headers = body.headers;
  if (headers !== undefined && (headers === null || typeof headers !== 'object' || Array.isArray(headers))) {
    return {
      error: '`headers` must be a JSON object of header name to value',
      fix: 'Send {"headers": {"content-type": "application/json", "payment-required": "<base64>"}}. ' +
        'Names are matched case-insensitively, so copy them however your client printed them.',
    };
  }

  // The body arrives as text because that is what it is on the wire. A caller
  // that hands over the PARSED object is accommodated rather than rejected —
  // re-serialising is exactly what they would otherwise do by hand — but the
  // check that the body is valid JSON then becomes vacuous, so it is said out loud.
  let text = body.body;
  let reserialised = false;
  if (text !== undefined && typeof text !== 'string') {
    try {
      text = JSON.stringify(text);
      reserialised = true;
    } catch {
      return {
        error: '`body` must be the response body as a string',
        fix: 'Send the raw body text, exactly as the endpoint returned it — not a parsed object.',
      };
    }
  }

  const flat = {};
  for (const [key, value] of Object.entries(headers || {})) {
    flat[String(key).toLowerCase()] = Array.isArray(value) ? value[0] : String(value);
  }

  const input = {
    status,
    headers: flat,
    body: typeof text === 'string' ? text : '',
    url: typeof body.url === 'string' ? body.url : null,
    // OPTIONAL, AND ITS ABSENCE IS NOT A DEFAULT. One check compares the verb
    // the response was fetched with against the one the envelope declares in
    // extensions.bazaar.info.input.method — which is a REQUIRED CDP preflight —
    // and a pasted response was not fetched with anything. Assuming POST would
    // manufacture a disagreement out of this route's own ignorance, so with no
    // method given the comparison simply does not run.
    method: typeof body.method === 'string' ? body.method : null,
  };

  const report = check ? lintOne(input, check) : lint(input);

  if (!reserialised) return report;

  const reserialisedNote =
    '`body` arrived as a JSON object rather than as text, so it was re-serialised. ' +
    'Checks about the body being well-formed JSON cannot fail on a re-serialised body ' +
    '— send the raw response text to have those mean something.';

  // A single-check report may ALREADY carry a `note` — the one that says the
  // named check did not apply — and that sentence is the answer the caller
  // bought. Appending rather than assigning: overwriting it would turn "nothing
  // was asserted about your v2 header" into a remark about serialisation.
  return {
    ...report,
    note: report.note ? `${report.note} Also: ${reserialisedNote}` : reserialisedNote,
  };
}

const usageFor = (endpoint) =>
  `${endpoint.method} ${endpoint.path} takes ${endpoint.inputDescription}. GET /check for the full contract.`;

const badRequest = (error, fix) => json({ error, fix }, 400);

const tooLarge = () =>
  json(
    {
      error: `the request body is larger than the ${Math.round(MAX_REQUEST_BODY / 1024)} KB limit`,
      fix: 'A 402 envelope is a few kilobytes. If you are pasting a whole page, paste only the 402.',
    },
    413
  );

// ------------------------------------------------------------------ payment answers

/**
 * The answer to a call with nothing free left and no payment presented.
 *
 * The 402 is the normal path. The 429 is the fallback for a deployment with
 * nowhere to take money, and it splits on WHY, because the two cases want
 * opposite advice: a spent allowance is fixed by waiting, and a missing payTo
 * is not — so there is deliberately no Retry-After on the second, since a
 * header promising that midnight fixes it would be a lie a client would obey.
 */
function unpaid(endpoint, { payTo, tier, now, dayStart }) {
  if (payTo) {
    return paymentRequired(endpoint.id, payTo, {
      error: 'X-PAYMENT header is required',
      // v2 renamed the header, so the v1 sentence would name the wrong thing.
      v2Error: 'Payment required',
    });
  }
  if (tier > 0) {
    return json(
      {
        error: `free tier is ${tier} calls per day per caller`,
        free_tier_daily: tier,
        paid_tier: 'per-call USDC via x402 — no payTo configured on this deployment',
        retry: 'tomorrow UTC',
      },
      429,
      // Seconds to the next UTC midnight, which is when the counter resets.
      { 'retry-after': String(secondsToReset(now, dayStart)) }
    );
  }
  return json(
    {
      error: 'this is a paid call, and this deployment has no receiving address configured',
      free_tier_daily: 0,
      paid_tier: 'per-call USDC via x402 — no payTo configured on this deployment',
      retry: 'not until this deployment configures a receiving address',
    },
    429
  );
}

// The paid ceiling is a runaway bound, not a price gate. A caller that already
// paid cannot buy its way past it, so answering 402 "pay to continue" would be
// a lie; it gets the plain rate-limit answer instead.
function paidCeilingReached({ now, dayStart }) {
  return json({ error: 'the daily ceiling for this caller is reached', retry: 'tomorrow UTC' }, 429, {
    'retry-after': String(secondsToReset(now, dayStart)),
    'x-payment-verified': 'false',
  });
}

/**
 * The verify ceiling, and it is deliberately NOT a 402.
 *
 * A 402 means "pay and try again", and this caller's next payment will not be
 * checked either — so a 402 here would be an invitation to spend money on a
 * call that cannot succeed. The honest answer is the rate limit, with the
 * header saying plainly that nothing was verified.
 */
function verifyCeilingReached({ now, dayStart }) {
  return json(
    {
      error: 'the daily payment-verification limit for this caller is reached',
      fix:
        'Each presented payment costs a round trip to the facilitator whether or not it is ' +
        'good, so the number of them per caller per day is bounded. A run of failed ' +
        'verifications is usually one fixable thing — check the EIP-712 domain in `extra`, ' +
        'and that the accepts entry you signed against is the one this endpoint published.',
      retry: 'tomorrow UTC',
    },
    429,
    { 'retry-after': String(secondsToReset(now, dayStart)), 'x-payment-verified': 'false' }
  );
}

/**
 * A payment header that could not be decoded.
 *
 * The same 402 an unpaid caller gets — a complete, payable envelope — with the
 * reason named. It writes nothing and calls nothing: see the note at the top of
 * handlePaid.
 */
function malformedPayment(endpoint, payTo) {
  return paymentRequired(endpoint.id, payTo, {
    error: 'the payment presented was not accepted',
    invalidReason: 'malformed_payment_header',
    invalidMessage:
      'X-PAYMENT (x402 v1) or PAYMENT-SIGNATURE (x402 v2) must be base64-encoded JSON — an x402 payment payload',
    v2Error: 'malformed_payment_header',
  });
}

/**
 * A payment that verified, and has already bought a report.
 *
 * A 402 rather than a 429, and that is the right shape: this IS a payment
 * problem and the answer carries the terms to sign a fresh one against. The
 * fix says what a client actually has to change, which is the nonce.
 */
function paymentAlreadyUsed(endpoint, payTo) {
  return paymentRequired(endpoint.id, payTo, {
    error: 'this payment has already been used',
    invalidReason: 'payment_already_used',
    invalidMessage:
      'this exact payment payload has already bought a report. One authorization buys one call — ' +
      'sign a new one, with a fresh nonce, against the terms in this 402.',
    v2Error: 'payment_already_used',
  });
}

/**
 * The payment headers on a SERVED response.
 *
 * THERE IS NO `PAYMENT-RESPONSE` HEADER, and its absence is honest. In v2 that
 * header is a settlement RECEIPT, and this Worker does not have one at the
 * moment it answers: settlement is deliberately queued behind the response. The
 * alternative is to emit one anyway with success: true and an empty
 * transaction, which is a receipt for a payment that has not happened — the
 * first fake thing this service would say. A real v2 client reads the receipt
 * inside a try/catch and carries on without one.
 */
function servedHeaders({ kind, presented, remaining, error }) {
  const headers = {};
  if (kind === 'free') {
    headers['x-free-tier-remaining'] = String(Math.max(0, remaining));
    // The free tier is not a payment path: a payment presented inside it is
    // neither checked nor charged, and the response says so rather than
    // implying the header did something.
    if (presented) headers['x-payment-verified'] = 'false';
  } else if (kind === 'paid') {
    headers['x-payment-verified'] = 'true';
  } else {
    headers['x-payment-verified'] = 'false';
    headers['x-payment-error'] = error;
    headers['x-pricing'] = 'pending';
  }
  return headers;
}

// ------------------------------------------------------------------ settlement

async function settleAndRecord(env, db, { requirements, facRequirements, version, payload, payer, endpoint }) {
  const ownResource = version === 2 ? resourceInfoV2(requirements, endpoint) : requirements.resource;
  const { settleOk, txHash, error } = await settlePayment(env, { facRequirements, payload, ownResource });

  try {
    await recordSettlement(db, {
      now: Math.floor(Date.now() / 1000),
      endpoint: endpoint.id,
      payer,
      amount: requirements.maxAmountRequired,
      verifyOk: 1, // it got here, so verify said yes
      settleOk,
      txHash,
      error,
    });
  } catch {
    // The response shipped a long time ago. A lost ledger row is bad, but
    // throwing into waitUntil helps nobody.
  }

  // The owner's ping, LAST — after the ledger write, never instead of it. The
  // table is the source of truth for money; this is a courtesy that tells a
  // human to go look. Ordering it this way means a channel outage can never
  // cost a row.
  await sendPaymentAlert(env, {
    kind: 'settled',
    tool: endpoint.id,
    payer,
    amount: requirements.maxAmountRequired,
    settleOk,
    txHash,
    error,
  });
}

// ------------------------------------------------------------------ store

async function globalExceeded(db, day) {
  const counter = await db.prepare('SELECT total FROM counters WHERE day = ?1').bind(day).first();
  return (counter?.total ?? 0) >= 200_000;
}

/**
 * Claim a payment as spent, atomically. True means this request owns it.
 *
 * The insert IS the claim: two isolates racing the same header both attempt the
 * INSERT, the primary key admits exactly one, and `RETURNING` comes back empty
 * for the loser. A read-then-write would be a race with a window the size of a
 * D1 round trip, which is the window the replay was using.
 */
async function claimPaymentOnce(db, hash, now) {
  const row = await db
    .prepare('INSERT INTO payment_seen (hash, created_at) VALUES (?1, ?2) ON CONFLICT(hash) DO NOTHING RETURNING hash')
    .bind(hash, now)
    .first();
  return row?.hash === hash;
}

/**
 * Give a claimed payment back, because the report it bought never existed.
 *
 * Best-effort on purpose: this runs on a path that is already answering 4xx for
 * some other reason, and turning a failed DELETE into a different failure would
 * replace an inconvenience (the caller re-signs) with an outage. Nothing is
 * charged either way — settlement is queued only after a report exists.
 */
async function releasePaymentSafely(db, hash) {
  try {
    await db.prepare('DELETE FROM payment_seen WHERE hash = ?1').bind(hash).run();
  } catch {
    /* see above */
  }
}

async function recordSettlement(db, { now, endpoint, payer, amount, verifyOk, settleOk, txHash, error }) {
  await db
    .prepare(
      'INSERT INTO settlements (ts, endpoint, payer, amount, verify_ok, settle_ok, tx_hash, error) ' +
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
    )
    .bind(now, endpoint, payer ?? null, amount, verifyOk, settleOk, txHash ?? null, error ?? null)
    .run();
}

/**
 * Best-effort ledger write for the IN-REQUEST paths.
 *
 * The audit row must never decide the response. The unverified-serve path
 * exists precisely to keep serving when payment infrastructure is failing, and
 * turning that into a 503 because an INSERT failed would invert the rule it
 * implements.
 */
async function recordSettlementSafely(db, row) {
  try {
    await recordSettlement(db, row);
  } catch {
    /* see above */
  }
}

/**
 * The telemetry row for one served report, for both report shapes.
 *
 * A single-check report has no grade — a letter computed from one check would
 * be a fabricated verdict, and 'A' for "the one check you asked about passed"
 * is exactly the sentence this service refuses to say. So the `grade` column
 * carries the honest small vocabulary for those rows instead: `pass`, `fail`,
 * or `n/a` when the named check did not apply. The `endpoint` column already
 * says which shape a row is, so the two vocabularies cannot be confused, and
 * `SELECT grade, COUNT(*) FROM lints GROUP BY grade` still answers the question
 * it was written for.
 */
const lintTelemetry = (report) =>
  report.check
    ? {
        grade: report.applied ? (report.passed ? 'pass' : 'fail') : 'n/a',
        errors: report.finding?.severity === 'error' ? 1 : 0,
        warns: report.finding?.severity === 'warn' ? 1 : 0,
      }
    : {
        grade: report.grade,
        errors: report.findings.filter((f) => f.severity === 'error').length,
        warns: report.findings.filter((f) => f.severity === 'warn').length,
      };

async function recordLintSafely(db, { now, endpoint, report }) {
  if (!db) return;
  const { grade, errors, warns } = lintTelemetry(report);
  try {
    await db.batch([
      db
        .prepare('INSERT INTO lints (ts, endpoint, grade, errors, warns) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(now, endpoint, grade, errors, warns),
      db
        .prepare(
          'INSERT INTO counters (day, total) VALUES (?1, 1) ON CONFLICT(day) DO UPDATE SET total = total + 1'
        )
        .bind(new Date(now * 1000).toISOString().slice(0, 10)),
    ]);
  } catch {
    // Telemetry loss is the acceptable failure. The report is the product and
    // it has already been computed.
  }
}

/**
 * The day's salt, rotated lazily on the first request of a new UTC day. The
 * overwrite IS the discard — no derived or HMAC salt, because a recomputable
 * salt is the negation of discarded-at-rotation.
 */
async function currentSalt(db, day) {
  const row = await db.prepare("SELECT day, value FROM salt WHERE key = 'current'").first();
  if (row && row.day === day && row.value) return row.value;

  const fresh = randomHex(32);
  // The guarded upsert makes rotation atomic: a racing isolate that finds the
  // day already rotated updates nothing and gets no row back, so it re-reads
  // the winner's salt rather than minting a second identity space for the day.
  const written = await db
    .prepare(
      "INSERT INTO salt (key, day, value) VALUES ('current', ?1, ?2) " +
        'ON CONFLICT(key) DO UPDATE SET day = excluded.day, value = excluded.value ' +
        'WHERE salt.day <> excluded.day ' +
        'RETURNING value'
    )
    .bind(day, fresh)
    .first();
  if (written?.value) return written.value;

  const after = await db.prepare("SELECT value FROM salt WHERE key = 'current'").first();
  return after?.value || fresh;
}

// NOTHING ELSE IS EXPORTED FROM THIS FILE, and that is a runtime constraint
// rather than a style choice: workerd requires every named export of the entry
// module to be a handler, and a stray `export const PAID_DAILY` fails the
// Worker at STARTUP with "Incorrect type for map entry" — a total outage from
// what looks like a convenience for the test suite. Constants the suite needs
// live in the modules that own them (worker/catalog.js, worker/lint.js) or are
// mirrored in test/harness.mjs with a comment saying so.
