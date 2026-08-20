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

export const SUPPORT_EMAIL = 'support@lemon-agent.dev';

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
 * answer to "is this my problem?" is often no, and $0.02 is what that costs.
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
// FOUR ROUTES, TWO QUESTIONS, TWO RAILS.
//
// The two questions are "what is wrong with this 402" (the full catalogue) and
// "is THIS one thing wrong with it" (one named check). The two rails are a live
// URL we probe and a response you paste. Every combination is a real thing
// someone wants, so all four exist rather than making a caller filter a report
// they overpaid for or run a whole suite to settle one argument.
//
// THE PRICE SHEET, and the arithmetic in it is deliberate:
//
//   /lint               $0.10   full catalogue, live URL
//   /lint/one           $0.02   ONE named check, live URL
//   /lint/envelope      $0.05   full catalogue, pasted response
//   /lint/envelope/one  $0.01   ONE named check, pasted response
//
//   the full suite is 5x the single-check price and runs 75 checks, so buying
//   the batch is a 15x per-check advantage. A caller who genuinely has one
//   question pays a fifth; a caller who has three has already overpaid, and the
//   price sheet says so rather than letting them find out.
//
//   the pasted rail is HALF the live rail at both scopes, and the reason is a
//   cost we actually incur rather than a discount we invented: /lint makes an
//   outbound request on the caller's behalf — a bounded fetch, a 10s deadline,
//   our network position — and /lint/envelope makes none.
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
    price_usd: 0.02,
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
      'quietly passing. GET /check lists every check id. Three questions cost more this way ' +
      'than the full report does; the full report is the better buy above two.',
    inputDescription:
      'a JSON object: { "url": "https://…", "check": "V2_B64_URLSAFE" } — exactly one check id ' +
      'from GET /check, plus optionally { "method": "POST" | "GET" }',
    outputDescription:
      'a JSON single-check report: check, applied, passed, the finding with its fix (or null), ' +
      'regime, sources and the envelope summary',
    sample: { ...LINT_SAMPLE_INPUT, check: LINT_ONE_SAMPLE_CHECK },
  },
  {
    id: 'lint-envelope',
    path: '/lint/envelope',
    method: 'POST',
    price_usd: 0.05,
    fetches: false,
    single: false,
    pairedWith: 'lint-envelope-one',
    mimeType: 'application/json',
    description: 'Check a captured x402 402 for indexing and payment blockers — no fetch',
    long:
      'Runs the same check catalogue against a response you already have: paste the status, ' +
      'headers and body. Nothing is fetched, so it works for v1/v2 migration work, on staging, ' +
      'on localhost and on an endpoint that is not deployed yet. Half the price of /lint for ' +
      'that reason: there is no outbound request to make on your behalf.',
    inputDescription:
      'a JSON object: { "status": 402, "headers": { "payment-required": "…", … }, "body": "…" }',
    outputDescription: 'a JSON lint report: grade, summary, findings[] and checks_run',
    sample: ENVELOPE_SAMPLE_INPUT,
  },
  {
    id: 'lint-envelope-one',
    path: '/lint/envelope/one',
    method: 'POST',
    price_usd: 0.01,
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
// The one number the pricing copy makes an argument out of, computed from the
// prices above so the copy cannot drift from the sheet. Stated as a function of
// the catalogue size rather than importing worker/lint.js, which would drag the
// whole engine into every module that only wanted a price.

/**
 * Full-report price ÷ single-check price.
 *
 * ONE number for both rails, and the module refuses to load if the two rails
 * disagree — a price sheet whose own copy needs two multiples to describe it is
 * a sheet somebody edited half of. (Float division: 0.1/0.02 is
 * 5.000000000000001, so it is rounded before it is compared or printed.)
 */
export const BATCH_MULTIPLE = (() => {
  const multiples = ENDPOINTS.filter((e) => e.single).map((one) => {
    const full = ENDPOINTS.find((e) => e.id === one.pairedWith);
    if (!full) throw new Error(`${one.id} is paired with "${one.pairedWith}", which is not an endpoint`);
    return Math.round((full.price_usd / one.price_usd) * 1000) / 1000;
  });
  if (!multiples.length) throw new Error('no single-check endpoint to derive a batch multiple from');
  if (new Set(multiples).size !== 1) {
    throw new Error(`the rails disagree on the batch multiple: ${multiples.join(' vs ')}`);
  }
  return multiples[0];
})();

/**
 * How much cheaper a check is inside the batch than bought alone.
 *
 * 75 checks for 5x the price of one is 15x per check. `checksTotal` is passed
 * in by the caller that has it, so this module stays free of the engine.
 */
export const perCheckAdvantage = (checksTotal) =>
  Math.round((checksTotal / BATCH_MULTIPLE) * 10) / 10;

/** The sentence every surface prints, so all of them print the same one. */
export const batchAdvantageLine = (checksTotal) =>
  `The full suite costs ${BATCH_MULTIPLE}x a single check and runs ${checksTotal} of them — a ` +
  `${perCheckAdvantage(checksTotal)}x per-check advantage. One question is worth buying alone; ` +
  'three are not.';
