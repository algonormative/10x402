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

/**
 * The paid surface. `id` is the routing key, `path` the URL, `price_usd` the
 * only place a price is written down.
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
    price_usd: 0.01,
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
    id: 'lint-envelope',
    path: '/lint/envelope',
    method: 'POST',
    price_usd: 0.005,
    mimeType: 'application/json',
    description: 'Check a captured x402 402 for indexing and payment blockers — no fetch',
    long:
      'Runs the same check catalogue against a response you already have: paste the status, ' +
      'headers and body. Nothing is fetched, so it works for v1/v2 migration work, on staging, ' +
      'on localhost and on an endpoint that is not deployed yet.',
    inputDescription:
      'a JSON object: { "status": 402, "headers": { "payment-required": "…", … }, "body": "…" }',
    outputDescription: 'a JSON lint report: grade, summary, findings[] and checks_run',
    sample: ENVELOPE_SAMPLE_INPUT,
  },
];

export const ENDPOINTS_BY_ID = new Map(ENDPOINTS.map((e) => [e.id, e]));
export const ENDPOINTS_BY_PATH = new Map(ENDPOINTS.map((e) => [e.path, e]));

/** The free route. Listed here so the page and /check itself describe it identically. */
export const FREE_ENDPOINT = {
  path: '/check',
  method: 'GET',
  price_usd: 0,
  description: 'Start here: service info, the full 64-check catalogue, prices and grades. Free.',
};

export const priceLabel = (usd) =>
  usd === 0 ? 'free' : `$${usd.toFixed(USDC_DECIMALS).replace(/0+$/, '').replace(/\.$/, '')}`;
