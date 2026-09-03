// What 10x402 sells, in one place.
//
// The Worker, build.mjs, the MCP server and the suite all read this file, so
// there is exactly one definition of a price, a path or a description. A price
// that appears in the page, the OpenAPI document, the x402 envelope and the
// /check response has four chances to drift; here it has none.
//
// DOMAIN NOTE. 10x402.com is not registered yet. Every use of it in this repo is
// a string in generated copy and in envelope metadata — nothing resolves it, no
// test fetches it, and the Worker never calls out to it. Point SITE_HOST
// somewhere else and everything still builds.

export const SERVICE_NAME = '10x402';
export const SERVICE_TAGLINE = 'x402 conformance linting, sold per call over x402';

// A PLAIN CONSTANT, deliberately — this module is imported by the Worker, where
// `process` does not exist and touching it is a ReferenceError, not a fallback.
// build.mjs takes its own SITE_HOST override from the environment and rewrites
// the generated copy; the envelope the Worker publishes always names production.
export const SITE_HOST = '10x402.com';
export const SITE_BASE = `https://${SITE_HOST}`;

export const SUPPORT_EMAIL = 'support@10x402.com';

// ResourceInfoSchema caps serviceName at 32 printable ASCII and tags at 5
// entries of 32 characters (@x402/core 2.23.0).
export const RESOURCE_TAGS = ['x402', 'lint', 'conformance', 'developer-tools'];

// USDC on Base, 6 decimals. Every price below is quoted in dollars and rendered
// into atomic units in exactly one place (atomicAmount, worker/envelope.js).
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDC_DECIMALS = 6;

// The EIP-712 domain of that contract, carried in the envelope's `extra`.
//
// NOT decoration, and getting it wrong fails silently: the client builds the
// typed-data domain from extra.name / extra.version with NO fallback, while the
// facilitator falls back to its own per-chain table. Omit it and every genuine
// payment comes back invalid_exact_evm_payload_signature. "USD Coin" is the
// token's on-chain name(), which is not its ticker.
export const USDC_BASE_EIP712 = { name: 'USD Coin', version: '2' };

// One chain, two spellings. The version decides which is legal — and that fact
// is itself one of the things this service lints for.
export const NETWORK_V1 = 'base';
export const NETWORK_V2 = 'eip155:8453';

// ------------------------------------------------------------------ the second rail
//
// SOLANA, added 2026-09-01 and ENV-GATED ON `PAYTO_SOLANA`. With that var unset
// this service behaves exactly as it did before — one accepts entry, Base — and
// the suite pins that byte for byte, because a second rail that quietly changed
// the rail with settlements on it would be the expensive kind of regression.
//
// USDC on Solana is ALSO 6 decimals, so one price serves both rails and the
// atomic amount is identical in both entries. That is not a coincidence to lean
// on silently: a third rail with different decimals would have to compute the
// amount per rail rather than share it. (The price sheet's pairwise-uniqueness
// invariant is per-ENDPOINT and is unaffected — the same figure appearing on two
// rails of the same endpoint is the point, not a collision.)
//
// Two spellings again, same rule as Base: `solana` in v1, the CAIP-2
// `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet-beta genesis hash,
// truncated per CAIP-30) in v2. Confirmed first-party against CDP's
// authenticated /supported, 2026-08-31, and settled live on the sibling
// property the same day.
export const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const NETWORK_SOLANA_V1 = 'solana';
export const NETWORK_SOLANA_V2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

// v1 network name → v2 CAIP-2 name. requirementsV2() reads this rather than a
// constant, which is what lets ONE projection serve both rails.
export const NETWORK_V2_OF = {
  [NETWORK_V1]: NETWORK_V2,
  [NETWORK_SOLANA_V1]: NETWORK_SOLANA_V2,
};

export const X402_TIMEOUT_SECONDS = 60;

// The cap on a linted response body AND on a pasted envelope. 256 KB is far
// past any real 402 (a fat one is 4 KB) and small enough that a hostile target
// cannot make the Worker read a stream forever.
export const MAX_BODY_BYTES = 256 * 1024;

// ------------------------------------------------------------------ samples
//
// Each paid endpoint publishes a WORKED example in its v2 envelope: a real
// request body, and the response that body actually produces. The output half
// is computed at envelope-build time by running the sample through the real
// code path (see sampleOutput() in worker/envelope.js), never typed by hand —
// a hand-written example drifts the first time the report shape changes and
// nothing tells you.

/**
 * The sample call for POST /lint.
 *
 * It points at a live third-party seller, which is what the endpoint is for.
 * The computed output comes from linting the CAPTURED copy of that seller's
 * 402 (worker/positive-control.js) rather than from a fetch at build time —
 * so the example is a genuine run of the engine, and constructing an envelope
 * never makes a network call.
 */
export const LINT_SAMPLE_INPUT = {
  url: 'https://toolshed.lemon-agent.dev/convert/md-html',
  method: 'POST',
};

/**
 * The check the single-check samples name.
 *
 * V2_B64_URLSAFE for the live rail because it is the one-character bug this
 * whole service exists around: a base64url v2 header is thrown out UNREAD by
 * the client, so the seller sees silence rather than an error. It is the
 * question someone asks when they already suspect the answer, which is exactly
 * what a single-check call is for. Against the captured positive control it
 * PASSES, and a published example of a check passing is worth having: the
 * answer to "is this my problem?" is often no, and $0.015 is what that costs.
 */
export const LINT_ONE_SAMPLE_CHECK = 'V2_B64_URLSAFE';

/**
 * And the one the pasted-envelope sample names.
 *
 * The published /lint/envelope sample is a v1-only 402, so V2_HEADER_PRESENT is
 * the check that fires on it — the other half of the worked pair above: a
 * finding, with the fix attached, in the space of one field.
 */
export const ENVELOPE_ONE_SAMPLE_CHECK = 'V2_HEADER_PRESENT';

/**
 * The sample call for POST /lint/envelope: a pasted v1-only 402.
 *
 * Chosen because it is the report worth showing. Everything about this envelope
 * is right except that it publishes no v2 half, so the example output is one
 * warning with the fix attached — which is what the product does, in miniature,
 * in the space of a response header.
 */
export const ENVELOPE_SAMPLE_INPUT = {
  status: 402,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: '1000',
        resource: 'https://example.com/api/thing',
        description: 'an example paid endpoint',
        mimeType: 'application/json',
        payTo: '0x0000000000000000000000000000000000000001',
        maxTimeoutSeconds: 60,
        asset: USDC_BASE,
        extra: USDC_BASE_EIP712,
        outputSchema: {
          input: { type: 'http', method: 'POST', discoverable: true, bodyType: 'text', description: 'the request body' },
          output: { type: 'string', description: 'the response body' },
        },
      },
    ],
  }),
};

// ------------------------------------------------------------------ endpoints
//
// THE LINT IS FOUR ROUTES, TWO QUESTIONS, TWO RAILS.
//
// The two questions are "what is wrong with this 402" (the full catalogue) and
// "is THIS one thing wrong with it" (one named check). The two rails are a live
// URL we probe and a response you paste. Every combination is a real thing
// someone wants, so all four exist rather than making a caller filter a report
// they overpaid for or run a whole suite to settle one argument.
//
// THE OTHER FOUR ARE A DIFFERENT QUESTION, AND THEY ARE NOT ON EITHER RAIL.
// /presence and the three /monitor routes answer "can the world see you", not
// "is your envelope right" — the first by reading three registries live, the
// last three by re-serving what the Parallax crons stored (MONITOR.md). They
// carry `kind`, and everything that branches on the rails (BATCH_MULTIPLES,
// the single/full pairing) is keyed on `single` and `pairedWith`, which they do
// not have. A route that answers a different question does not belong in an
// arithmetic about check counts.
//
// THE PRICE SHEET, and the arithmetic in it is deliberate:
//
//   /lint               $0.10   full catalogue, live URL
//   /lint/one           $0.015  ONE named check, live URL
//   /lint/envelope      $0.04   full catalogue, pasted response
//   /lint/envelope/one  $0.004  ONE named check, pasted response
//   /presence           $0.06   where a live resource stands with the registries
//   /monitor/verdict    $0.005  one host today, across three rating instruments
//   /monitor/history    $0.03   every day held for one host
//   /monitor/receipt    $0.12   the dispute pack, digested and attested
//
//   EVERY AMOUNT ON IT IS UNIQUE, and that is a operational property rather
//   than a tidy one: the amount is the only field a bare chain explorer shows,
//   so a settlement is attributable to the endpoint that earned it with no
//   other data. test/single-check.test.mjs asserts it on every build.
//
//   THE TWO SCOPES ARE TWO PRODUCTS, bought at two different moments, and they
//   are priced for the moment rather than for the CPU.
//
//   A full report is bought during an incident. A seller whose 402 passes
//   validate and still is not indexed is looking at the class of problem that
//   eats weeks, because nothing in the stack says which of seventy-five things
//   is wrong. $0.10 is priced against that, and it is still a fraction of the
//   nearest signed conformance report, which is $25.
//
//   A single check is bought in a test, and then again on every commit. It
//   stays micro because that is the regression product, and a regression
//   product that is not cheap does not get run.
//
//   The multiples fall OUT of those two decisions rather than being designed:
//   12.5x on the live rail, 10x on the pasted one (see BATCH_MULTIPLES). They
//   differ because the rails do, which is why the copy computes one per rail
//   instead of averaging them into a number true of neither.
//
//   the pasted rail is cheaper than the live rail at both scopes, and the
//   reason is a cost we actually incur rather than a discount we invented:
//   /lint makes an outbound request on the caller's behalf — a bounded fetch, a
//   10s deadline, our network position — and /lint/envelope makes none.
//
// Everything is priced per SERVED report. A bad URL, an unreachable target, a
// malformed paste or an unknown check id settles nothing, even when the payment
// verified.
//
/**
 * The paid surface. `id` is the routing key, `path` the URL, `price_usd` the
 * only place a price is written down.
 *
 * `fetches` and `single` are what the Worker branches on — never the id, which
 * would make adding a fifth route a hunt for string comparisons. `fetches`
 * means this route makes an outbound request, which is what costs us and what
 * the attempt quota bounds; `single` means it answers about ONE named check and
 * takes a required `check` field.
 *
 * `bodyType: 'text'` in the published bazaar sample is deliberate even though
 * these bodies are JSON: it is the value CDP's validator is known to accept for
 * a body-carrying POST (verified in production on the sibling service), and an
 * HTTP body is text on the wire. The JSON-ness is stated where a reader will
 * act on it — in the description, the schema and the OpenAPI document.
 */
export const ENDPOINTS = [
  {
    id: 'lint',
    path: '/lint',
    method: 'POST',
    price_usd: 0.1,
    fetches: true,
    single: false,
    pairedWith: 'lint-one',
    mimeType: 'application/json',
    description: 'Find conformance blockers to x402 indexing and payment on a live endpoint',
    long:
      'Sends ONE unauthenticated request to the URL you name and lints the response: HTTP ' +
      'status, the v1 body envelope, the v2 PAYMENT-REQUIRED header envelope, dual-stack ' +
      'consistency, and CDP Bazaar discovery requirements. Returns a grade and a specific fix ' +
      'for each finding. It identifies technical blockers; it does not verify a listing or payment.',
    inputDescription:
      'a JSON object: { "url": "https://…" } and optionally { "method": "POST" | "GET" }, ' +
      'default POST',
    outputDescription: 'a JSON lint report: grade, summary, findings[] and checks_run',
    sample: LINT_SAMPLE_INPUT,
  },
  {
    id: 'lint-one',
    path: '/lint/one',
    method: 'POST',
    price_usd: 0.015,
    fetches: true,
    single: true,
    pairedWith: 'lint',
    mimeType: 'application/json',
    description: 'Run ONE named check against a live endpoint',
    long:
      'The same outbound probe as /lint, reported for exactly one check you name. For settling ' +
      'a single question — "is my v2 header base64url", "does my bazaar info validate against ' +
      'its own schema" — without buying the whole catalogue. The answer says whether the check ' +
      'PASSED, and when the check did not apply to this response it says that instead of ' +
      'quietly passing. GET /check lists every check id, and publishes the batch arithmetic — so ' +
      'you can work out where the full report becomes the cheaper buy before paying for any of it.',
    inputDescription:
      'a JSON object: { "url": "https://…", "check": "V2_B64_URLSAFE" } — exactly one check id ' +
      'from GET /check, plus optionally { "method": "POST" | "GET" }',
    outputDescription:
      'a JSON single-check report: check, applied, passed, the finding with its fix (or null), ' +
      'regime, sources and the envelope summary',
    sample: { ...LINT_SAMPLE_INPUT, check: LINT_ONE_SAMPLE_CHECK },
  },
  {
    id: 'presence',
    path: '/presence',
    method: 'POST',
    // $0.06 and DELIBERATELY DISTINCT from every other price on the sheet:
    // amounts are the one field a bare chain explorer shows, so unique prices
    // make every settlement attributable to its endpoint with no other data.
    // Costlier than the pasted rail because it is the most outbound work this
    // service does — the target fetch plus a full catalog scan.
    price_usd: 0.06,
    fetches: true,
    single: false,
    kind: 'presence',
    mimeType: 'application/json',
    description: 'Where a live x402 resource stands with the registries — Bazaar, x402scan, and on-chain',
    long:
      'The question the stuck-seller threads open with: "I settle payments — why can nobody find ' +
      'me?" Fetches your 402, reads the payTo and resource it declares, then checks three public ' +
      'surfaces: the full CDP Bazaar discovery catalog (scanned end to end — its payTo filter is ' +
      'documented but inert, so the honest read is the whole catalog), the x402scan explorer, and ' +
      'USDC transfer activity to your payTo on Base. Per-registry verdict with the evidence and a ' +
      'specific way in for each miss. A surface that cannot be read reports `unknown`, never a ' +
      'guessed `not_found`. /lint answers whether your declaration is right; this answers whether ' +
      'the world can see it.',
    inputDescription:
      'a JSON object: { "url": "https://…" } — the live x402 resource to look up — and optionally ' +
      '{ "method": "POST" | "GET" }, default POST',
    outputDescription:
      'a JSON presence report: per-registry verdicts (listed | not_found | unknown) with evidence, ' +
      'on-chain settlement activity, and a summary',
    sample: LINT_SAMPLE_INPUT,
  },
  // ---------------------------------------------------------------- the monitoring wing
  //
  // Parallax (MONITOR.md). Three rows, one subject: a host this service has been
  // watching daily. They are `kind: 'monitor'` and `fetches: false` for the same
  // reason — THE REQUEST PATH READS D1 AND NOTHING ELSE. A verdict that went and
  // asked the endpoint at buy time would be selling a fresh reading under a
  // stored day's `as_of` stamp, and the stamp is what makes it evidence.
  //
  // THE PRICES ARE THE INCUMBENT'S OWN, DELIBERATELY. agenteconomy.report
  // publishes its price card inside the ratings file this wing captures:
  // $0.005 a rating read, $0.02 a history. /monitor/verdict matches the rating
  // read exactly — the same question, at the same price, with the probe half
  // they do not take. /monitor/history is $0.03 rather than $0.02 because ours
  // carries both instruments AND the daily declared-verb probe, and pricing it
  // under theirs would be the claim that it is less. Every amount on the sheet
  // stays UNIQUE, which is what makes a settlement attributable to its endpoint
  // from a bare chain explorer with no other data.
  {
    id: 'monitor-verdict',
    path: '/monitor/verdict',
    method: 'POST',
    price_usd: 0.005,
    fetches: false,
    single: false,
    kind: 'monitor',
    mimeType: 'application/json',
    description: 'The latest stored reading for a host: three rating instruments plus what it answered when asked — dated, never live, and it says how old it is',
    long:
      'The latest stored day for one host: agenteconomy.report, apistrust.com and the CDP Bazaar ' +
      'quality block side by side, plus what the endpoint itself answered to an unpaid request on ' +
      'the verb its own catalogue row declares and on GET. Read-time flags name the two findings ' +
      'that matter — a liveness contradiction between the instruments, and `wrongly-dead`: rated ' +
      'at uptime 0.0 while answering 402 on its declared verb. Stamped with the day it was ' +
      'measured, and if the stored probe is more than 36 hours old the answer says so instead of ' +
      'pretending to be current. Nothing is fetched to serve it.',
    inputDescription:
      'a JSON object: { "host": "socialx402.com" } — one hostname, or the https URL of an endpoint ' +
      '(its host is taken). A bare 0x… wallet address is accepted too, because the rating ' +
      'instrument files some of its rows under one',
    outputDescription:
      'a JSON verdict: as_of, freshness, the three instruments, the two-verb probe, and the ' +
      'read-time flags. NULL and 0 are different claims throughout: NULL means no row or never ' +
      'asked; 0 means a real zero, or asked with no HTTP answer',
    sample: { host: '10x402.com' },
  },
  {
    id: 'monitor-history',
    path: '/monitor/history',
    method: 'POST',
    price_usd: 0.03,
    fetches: false,
    single: false,
    kind: 'monitor',
    mimeType: 'application/json',
    description: 'Every day this wing has held for one host — instrument readings and probes',
    long:
      'The full daily series for one host, oldest first: what each instrument reported that day and ' +
      'what the declared-verb probe found, with the flags computed per day. This is the half the ' +
      'free page deliberately does not give away — a single day says what a rating is, and the ' +
      'series says whether it is drifting, whether a correction stuck, and how long a wrong ' +
      'liveness reading has been costing you. A day the capture did not run is simply absent, and ' +
      'a day that was captured but not probed says so rather than reading as a silent endpoint.',
    inputDescription:
      'a JSON object: { "host": "socialx402.com" } — the same subject form as /monitor/verdict. ' +
      'A bare 0x… wallet subject holds readings but can never hold probes, so its series carries ' +
      'no probe rows',
    outputDescription:
      'a JSON series: days_held, first_day, last_day, probed_days, and one entry per UTC day with ' +
      'instruments, probe and flags. NULL and 0 are different claims throughout: NULL means no ' +
      'row or never asked; 0 means a real zero, or asked with no HTTP answer',
    sample: { host: '10x402.com' },
  },
  {
    id: 'monitor-receipt',
    path: '/monitor/receipt',
    method: 'POST',
    price_usd: 0.12,
    fetches: false,
    single: false,
    kind: 'monitor',
    mimeType: 'application/json',
    description: 'The dispute pack: the series, the contradiction stated, a SHA-256 digest and an attestation',
    long:
      'The artefact to attach to a corrections request. It carries the whole daily series, a ' +
      'CONTRADICTION STATEMENT in plain numbers — how many days two instruments disagreed about ' +
      'whether this host was alive, and on how many of them the endpoint answered 402 to an unpaid ' +
      'request on its declared verb — a SHA-256 digest over the canonical JSON of the document so ' +
      'two copies can be compared in one line, and an attestation naming the probe method, the ' +
      'exact User-Agent every request carried (searchable verbatim in the rater\'s own access log), ' +
      'and the fact that NO PAYMENT WAS EVER SENT. The digest is an integrity check, not a ' +
      'signature: it proves two copies are the same document, not who issued it.',
    inputDescription:
      'a JSON object: { "host": "socialx402.com" } — the same subject form as /monitor/verdict. ' +
      'A bare 0x… wallet subject holds readings but can never hold probes, so its pack carries ' +
      'no probe evidence',
    outputDescription:
      'a JSON dispute pack: issued_at, the contradiction statement, the full series, the ' +
      'attestation, and a SHA-256 digest with the canonicalisation rule to recompute it. NULL ' +
      'and 0 are different claims throughout: NULL means no row or never asked; 0 means a real ' +
      'zero, or asked with no HTTP answer',
    sample: { host: '10x402.com' },
  },
  {
    id: 'lint-envelope',
    path: '/lint/envelope',
    method: 'POST',
    price_usd: 0.04,
    fetches: false,
    single: false,
    pairedWith: 'lint-envelope-one',
    mimeType: 'application/json',
    description: 'Check a captured x402 402 for indexing and payment blockers — no fetch',
    long:
      'Runs the same check catalogue against a response you already have: paste the status, ' +
      'headers and body. Nothing is fetched, so it works for v1/v2 migration work, on staging, ' +
      'on localhost and on an endpoint that is not deployed yet. Cheaper than /lint for that ' +
      'reason: there is no outbound request to make on your behalf.',
    inputDescription:
      'a JSON object: { "status": 402, "headers": { "payment-required": "…", … }, "body": "…" }',
    outputDescription: 'a JSON lint report: grade, summary, findings[] and checks_run',
    sample: ENVELOPE_SAMPLE_INPUT,
  },
  {
    id: 'lint-envelope-one',
    path: '/lint/envelope/one',
    method: 'POST',
    price_usd: 0.004,
    fetches: false,
    single: true,
    pairedWith: 'lint-envelope',
    mimeType: 'application/json',
    description: 'Run ONE named check against a response you paste',
    long:
      'One named check over a response you already have — the cheapest answer this service ' +
      'sells, and the one to reach for in a test or a CI step that asserts a single property of ' +
      'a 402 it just built. Nothing is fetched. The answer says whether the check PASSED, and ' +
      'when the check did not apply to this response it says that instead of quietly passing. ' +
      'GET /check lists every check id.',
    inputDescription:
      'a JSON object: { "status": 402, "headers": { … }, "body": "…", "check": "V2_B64_URLSAFE" } ' +
      '— exactly one check id from GET /check',
    outputDescription:
      'a JSON single-check report: check, applied, passed, the finding with its fix (or null), ' +
      'regime, sources and the envelope summary',
    sample: { ...ENVELOPE_SAMPLE_INPUT, check: ENVELOPE_ONE_SAMPLE_CHECK },
  },
];

export const ENDPOINTS_BY_ID = new Map(ENDPOINTS.map((e) => [e.id, e]));
export const ENDPOINTS_BY_PATH = new Map(ENDPOINTS.map((e) => [e.path, e]));

/** The free route. Listed here so the page and /check itself describe it identically. */
export const FREE_ENDPOINT = {
  path: '/check',
  method: 'GET',
  price_usd: 0,
  description: 'Start here: service info, the full check catalogue with sources, prices and grades. Free.',
};

/**
 * A price as money, and NEVER shorter than cents.
 *
 * Trailing zeros go, but not past two decimal places: `$0.1` on a sheet that
 * also says `$0.02` is a 10x misread waiting to happen, and it is the kind of
 * misread a buyer only notices after paying. `$0.005` keeps its third decimal
 * because it needs it.
 */
export const priceLabel = (usd) =>
  usd === 0 ? 'free' : `$${usd.toFixed(USDC_DECIMALS).replace(/(\.\d\d\d*?)0+$/, '$1')}`;

// ------------------------------------------------------------------ the batch advantage
//
// The argument the pricing copy makes out of the sheet, computed from the prices
// above so the copy cannot drift from them. Stated as a function of the
// catalogue size rather than importing worker/lint.js, which would drag the
// whole engine into every module that only wanted a price.
//
// ONE MULTIPLE PER RAIL, and that is not a compromise. The live and pasted rails
// carry different full-report prices against the same two single-check prices,
// so they have genuinely different multiples. A single published number could
// only ever be true of one rail, and a sheet that averages two rails into a
// number true of neither is worse than a sheet with two numbers on it.

/** Which of the two rails an endpoint sits on. Read off `fetches`, never the id. */
export const railOf = (endpoint) => (endpoint.fetches ? 'live' : 'pasted');

export const RAILS = ['live', 'pasted'];

/**
 * Full-report price ÷ single-check price, one entry per rail.
 *
 * Derived from the sheet above and asserted at module load. Each rail must have
 * a full/single pair; the pair must be ON that rail; and the full report must
 * cost MORE than one check on it — a rail where it did not would make every
 * batch-advantage sentence below an anti-recommendation, printed confidently.
 *
 * The multiples are NOT required to agree with each other. They are required to
 * be true. (Float division is not exact — 0.25/0.02 is 12.499999999999998 — so
 * each is rounded before it is compared or printed.)
 */
export const BATCH_MULTIPLES = (() => {
  const multiples = {};
  for (const one of ENDPOINTS.filter((e) => e.single)) {
    const full = ENDPOINTS.find((e) => e.id === one.pairedWith);
    if (!full) throw new Error(`${one.id} is paired with "${one.pairedWith}", which is not an endpoint`);
    if (railOf(full) !== railOf(one)) {
      throw new Error(`${one.id} and ${full.id} are paired ACROSS rails; a multiple over them means nothing`);
    }
    if (!(full.price_usd > one.price_usd)) {
      throw new Error(
        `${full.id} (${full.price_usd}) must cost MORE than ${one.id} (${one.price_usd}) — ` +
          'there is no batch advantage to publish otherwise'
      );
    }
    const rail = railOf(one);
    const multiple = Math.round((full.price_usd / one.price_usd) * 1000) / 1000;
    if (rail in multiples && multiples[rail] !== multiple) {
      throw new Error(`the ${rail} rail disagrees with itself: ${multiples[rail]} vs ${multiple}`);
    }
    multiples[rail] = multiple;
  }
  for (const rail of RAILS) {
    if (!(rail in multiples)) throw new Error(`the ${rail} rail has no full/single pair to derive a multiple from`);
  }
  return multiples;
})();

/**
 * How much cheaper a check is inside the batch than bought alone, on one rail.
 *
 * `checksTotal` is passed in by the caller that has it, so this module stays
 * free of the engine.
 */
export const perCheckAdvantage = (checksTotal, rail) => {
  if (!(rail in BATCH_MULTIPLES)) throw new Error(`no such rail: ${rail}`);
  return Math.round((checksTotal / BATCH_MULTIPLES[rail]) * 10) / 10;
};

/**
 * The last question count at which buying singles still beats the full report.
 *
 * At exactly `multiple` singles the two cost the SAME, so the last count where
 * singles are strictly cheaper is ceil(multiple) − 1: 12 on a 12.5x rail, 9 on a
 * 10x one. The published number is the one a buyer can check with a calculator
 * and find true, not the one that flatters the report.
 */
export const singlesEdge = (rail) => {
  if (!(rail in BATCH_MULTIPLES)) throw new Error(`no such rail: ${rail}`);
  return Math.ceil(BATCH_MULTIPLES[rail]) - 1;
};

/**
 * "a" or "an" in front of a NUMBER written as digits.
 *
 * WHY THIS EXISTS. The hero lede rendered `A ${CHECKS.length}-check catalogue`,
 * which with 82 checks printed "A 82-check catalogue" — a typo in the second
 * sentence a buyer reads, on a page whose whole argument is that this service
 * is careful about details. Hardcoding "An" would fix it until the catalogue
 * grew to 90 checks and broke it again silently, so the article is computed
 * from the number instead.
 *
 * THE RULE IS ABOUT THE SOUND, NOT THE SPELLING. "an" goes before a number
 * whose SPOKEN form opens with a vowel: eleven, eighteen, and anything that
 * starts with "eight" — 8, 82, 800, 8,000. Every other digit reads as a
 * consonant, including the ones that merely LOOK like a vowel case: 110 is "one
 * hundred ten" and 180 is "one hundred eighty", so the eleven/eighteen test is
 * an equality and not a prefix. A leading 8 IS a prefix test, because every
 * number that begins with one is read "eight…" all the way up.
 *
 * Exact over 0–999, which is the only range a check catalogue will ever be in.
 * Past that it errs toward "a" (11,000 is "eleven thousand" and would want
 * "an"), and anything that is not a whole non-negative number gets "a" too —
 * never worse than the bug this replaces.
 */
export const indefiniteArticle = (n) => {
  if (!Number.isInteger(n) || n < 0) return 'a';
  if (n === 11 || n === 18) return 'an';
  return String(n).startsWith('8') ? 'an' : 'a';
};

/** The sentence every surface prints, so all of them print the same one. */
export const batchAdvantageLine = (checksTotal) =>
  `A full ${checksTotal}-check report costs ${BATCH_MULTIPLES.live}x one check on a live URL and ` +
  `${BATCH_MULTIPLES.pasted}x on a pasted response — a ${perCheckAdvantage(checksTotal, 'live')}x and ` +
  `${perCheckAdvantage(checksTotal, 'pasted')}x per-check advantage. Singles stay the cheaper buy ` +
  `through ${singlesEdge('live')} questions live and ${singlesEdge('pasted')} pasted; past that, buy the report.`;

// THE COPY IS DERIVED, and the module refuses to load if it stops being. Every
// number the sentence shows has to be one the arithmetic above produced — a
// hand-typed ratio pasted over a computed one is exactly the drift this whole
// file exists to prevent, and it is invisible in review because it reads right.
// The probe count is arbitrary: what is asserted is provenance, not size.
(() => {
  const PROBE = 37;
  const line = batchAdvantageLine(PROBE);
  const shows = (n) => new RegExp(`(^|[^\\d.])${String(n).replace('.', '\\.')}(?![\\d.])`).test(line);
  for (const rail of RAILS) {
    for (const n of [BATCH_MULTIPLES[rail], perCheckAdvantage(PROBE, rail), singlesEdge(rail)]) {
      if (!shows(n)) {
        throw new Error(`the batch-advantage copy does not render its own computed ${rail} figure ${n}: ${line}`);
      }
    }
  }
})();
