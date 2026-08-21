// 10x402's own x402 sell side: the envelopes it publishes on a 402.
//
// Pure — no fetch, no D1, no env beyond the payTo string it is handed. That is
// what lets test/self-lint.test.mjs build the real thing and run it through the
// real lint engine with no server in the loop, and lets build.mjs render the
// same envelope into .well-known/x402.
//
// ------------------------------------------------------------------ dual-stack
//
// One 402 carries BOTH generations, and they do not share a transport:
//
//   v1  the envelope is the 402's JSON BODY; the payment comes back in an
//       `X-PAYMENT` request header.
//   v2  the envelope is STANDARD base64 in a `PAYMENT-REQUIRED` RESPONSE
//       header; the payment comes back in `PAYMENT-SIGNATURE`.
//
// A v2 client reads the header and never looks at the body; a v1 client reads
// the body and never looks at the header. So the two coexist without either
// noticing the other — and both are needed, because v1 clients are still real
// and CDP Bazaar answers a v1-only seller with "upgrade to x402 v2 to be
// discoverable".
//
// EVERY v2 FIELD IS DERIVED FROM THE v1 OBJECT rather than assembled a second
// time from the catalogue. That is not tidiness: the client signs against what
// the envelope advertised and the facilitator recovers the signature against
// what we send it, so a field that differs between the two makes a perfectly
// good payment verify as invalid. One is a projection of the other, so they
// cannot disagree — which also happens to be the DUAL_* family of checks this
// service sells, applied to itself.

import {
  ENDPOINTS_BY_ID,
  MAX_BODY_BYTES,
  NETWORK_V1,
  NETWORK_V2,
  RESOURCE_TAGS,
  SERVICE_NAME,
  SITE_BASE,
  USDC_BASE,
  USDC_BASE_EIP712,
  USDC_DECIMALS,
  X402_TIMEOUT_SECONDS,
} from './catalog.js';
import { lint, lintOne } from './lint.js';
import { POSITIVE_CONTROL } from './positive-control.js';
import { assemblePresence } from './presence.js';
import { PRESENCE_CONTROL } from './presence-control.js';

export const PAYMENT_HEADER_V1 = 'x-payment';
export const PAYMENT_HEADER_V2 = 'payment-signature';
export const PAYMENT_REQUIRED_HEADER = 'payment-required';

/** Dollars → atomic units of a 6-decimal stablecoin, as the string x402 wants. */
export const atomicAmount = (usd) => String(Math.round(usd * 10 ** USDC_DECIMALS));

// ------------------------------------------------------------------ v1

/**
 * The x402 v1 paymentRequirements for one endpoint — ONE definition, used by
 * the 402 body, by the v2 projection below, and by the facilitator calls.
 *
 * `outputSchema` is v1's discovery block. Two details are easy to get wrong and
 * silent when you do: `discoverable` lives INSIDE outputSchema.input, not at the
 * top level, and these are v1 field names on purpose — v2 does not reuse them,
 * it replaces the whole block with extensions.bazaar.
 */
export function paymentRequirements(endpoint, payTo) {
  return {
    scheme: 'exact',
    network: NETWORK_V1,
    maxAmountRequired: atomicAmount(endpoint.price_usd),
    resource: `${SITE_BASE}${endpoint.path}`,
    description: endpoint.description,
    mimeType: endpoint.mimeType,
    payTo,
    maxTimeoutSeconds: X402_TIMEOUT_SECONDS,
    asset: USDC_BASE,
    extra: USDC_BASE_EIP712,
    outputSchema: {
      input: {
        type: 'http',
        method: endpoint.method,
        discoverable: true,
        bodyType: 'text',
        description: `${endpoint.inputDescription}, up to ${MAX_BODY_BYTES / 1024} KB`,
      },
      output: { type: 'string', description: endpoint.outputDescription },
    },
  };
}

// ------------------------------------------------------------------ v2

/**
 * The v2 `accepts[0]` entry: EXACTLY the seven fields PaymentRequirementsV2Schema
 * defines, and nothing else.
 *
 * A stray field is not harmless — the client echoes this entry back as
 * `accepted`, the server deep-equals the two, and the facilitator validates the
 * shape it is handed. (V2_ACCEPTS_V1_FIELDS is the check that catches it in
 * somebody else's envelope.)
 */
export function requirementsV2(requirements) {
  return {
    scheme: requirements.scheme,
    network: NETWORK_V2,
    amount: requirements.maxAmountRequired,
    asset: requirements.asset,
    payTo: requirements.payTo,
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    extra: requirements.extra,
  };
}

/** The v2 top-level `resource` block — what is sold, as opposed to the terms. */
export function resourceInfoV2(requirements, endpoint) {
  return {
    url: requirements.resource,
    method: endpoint.method,
    description: requirements.description,
    mimeType: requirements.mimeType,
    tags: RESOURCE_TAGS,
    serviceName: SERVICE_NAME,
  };
}

/**
 * The sample body run through the REAL code path, memoised per isolate.
 *
 * This is the dogfood made visible: the output example published in /lint's
 * envelope is this engine linting a captured production 402, and the one in
 * /lint/envelope's is this engine linting the pasted v1-only sample. The two
 * single-check routes publish the same two runs reported for one named check —
 * a pass on the live rail, a finding with its fix on the pasted one. None is
 * typed by hand, so none can drift from what the endpoint actually returns.
 */
const sampleOutputCache = new Map();
export function sampleOutput(endpoint) {
  let out = sampleOutputCache.get(endpoint.id);
  if (out === undefined) {
    out = JSON.stringify(runSample(endpoint));
    sampleOutputCache.set(endpoint.id, out);
  }
  return out;
}

/**
 * What the endpoint's published sample input really returns.
 *
 * The branch is on what the endpoint IS — does it fetch, does it answer about
 * one check — rather than on its id, so a fifth route is a row in the catalogue
 * and not another string comparison here.
 */
export function runSample(endpoint) {
  // The presence sample is the real assembly code over the frozen
  // PRESENCE_CONTROL capture — three registry observations of this service's
  // own /lint/one resource, recorded on the capture date. Same discipline as
  // the lint samples below: real code path, frozen input, no network.
  if (endpoint.kind === 'presence') {
    return assemblePresence({
      target: { url: PRESENCE_CONTROL.target.url, method: 'POST', status: 402 },
      identity: { payTo: PRESENCE_CONTROL.target.payTo, declaredUrl: PRESENCE_CONTROL.target.url },
      bazaar: PRESENCE_CONTROL.bazaar,
      scan: PRESENCE_CONTROL.scan,
      chain: PRESENCE_CONTROL.chain,
    });
  }

  // A fetching endpoint's sample points at the positive control's URL, and
  // POST /lint on it fetches that URL and lints what comes back. The captured
  // copy IS what comes back, so linting it here is the same computation with no
  // network call — which is what lets an envelope be built anywhere.
  const input = endpoint.fetches
    ? {
        status: POSITIVE_CONTROL.status,
        headers: POSITIVE_CONTROL.headers,
        body: POSITIVE_CONTROL.body,
        url: POSITIVE_CONTROL.url,
        method: POSITIVE_CONTROL.method,
      }
    : {
        status: endpoint.sample.status,
        headers: endpoint.sample.headers,
        body: endpoint.sample.body,
      };

  return endpoint.single ? lintOne(input, endpoint.sample.check) : lint(input);
}

/** The published sample REQUEST body, as the text an agent would actually POST. */
export const sampleInputBody = (endpoint) => JSON.stringify(endpoint.sample);

/**
 * `extensions.bazaar` — the v2 successor to v1's outputSchema, and the thing
 * that makes the resource INDEXABLE rather than merely payable.
 *
 * Two halves, both required: `info` is one concrete example of the call, and
 * `schema` is the JSON Schema `info` is validated against. The bazaar spec says
 * a facilitator MUST validate one against the other before cataloguing, so a
 * schema that does not admit its own info is a SILENT delisting — the endpoint
 * keeps taking payments and simply never appears. They are written next to each
 * other here for exactly that reason, and V2_BAZAAR_INFO_VALIDATES re-checks
 * the pair on every self-lint.
 */
export function bazaarExtension(requirements, endpoint) {
  const input = requirements.outputSchema.input;
  return {
    bazaar: {
      info: {
        input: {
          type: 'http',
          method: input.method,
          bodyType: input.bodyType,
          body: sampleInputBody(endpoint),
        },
        output: { type: 'text', format: requirements.mimeType, example: sampleOutput(endpoint) },
      },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          input: {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'http' },
              method: { type: 'string', const: endpoint.method },
              bodyType: { type: 'string', const: 'text' },
              body: { type: 'string', description: input.description, maxLength: MAX_BODY_BYTES },
            },
            required: ['type', 'method', 'bodyType', 'body'],
            additionalProperties: false,
          },
          output: {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'text' },
              format: {
                type: 'string',
                const: requirements.mimeType,
                description: requirements.outputSchema.output.description,
              },
              example: {
                type: 'string',
                description: 'the sample request body above, actually run through this endpoint',
              },
            },
            required: ['type', 'format'],
            additionalProperties: false,
          },
        },
        required: ['input'],
      },
    },
  };
}

/** The whole v2 PaymentRequired envelope, ready to base64 into the header. */
export function paymentRequiredV2(requirements, endpoint, error) {
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: resourceInfoV2(requirements, endpoint),
    accepts: [requirementsV2(requirements)],
    extensions: bazaarExtension(requirements, endpoint),
  };
}

// ------------------------------------------------------------------ the 402

/**
 * The 402's two halves, as plain data: the JSON body object and the header map.
 *
 * Separated from Response construction so the self-lint test can build the
 * exact bytes this service publishes and hand them to the linter, with no
 * Worker and no server anywhere in the loop.
 */
export function build402(endpointId, payTo, { v2Error, ...body } = {}) {
  const endpoint = ENDPOINTS_BY_ID.get(endpointId);
  if (!endpoint) throw new Error(`no endpoint "${endpointId}"`);
  const requirements = paymentRequirements(endpoint, payTo);

  return {
    status: 402,
    requirements,
    body: { x402Version: 1, ...body, accepts: [requirements] },
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // `no-store` because an envelope is per-request: a cached 402 hands the
      // next caller someone else's terms.
      'cache-control': 'no-store',
      [PAYMENT_REQUIRED_HEADER]: base64Json(paymentRequiredV2(requirements, endpoint, v2Error)),
    },
  };
}

/** build402 as a real Response. The Worker's only 402 constructor. */
export function paymentRequired(endpointId, payTo, options = {}) {
  const { body, headers } = build402(endpointId, payTo, options);
  return new Response(`${JSON.stringify(body)}\n`, { status: 402, headers });
}

// ------------------------------------------------------------------ base64
//
// STANDARD base64 with padding, NOT the url-safe form. x402 v2 headers are
// validated against /^[A-Za-z0-9+/]*={0,2}$/ before they are decoded, so a
// url-safe envelope is thrown out UNREAD — which reads, from the client side,
// as a seller that published no envelope at all. It is the single most
// expensive one-character bug in this space, it is V2_B64_URLSAFE in the check
// catalogue, and this is the one line in this repo that must not get clever.

export function base64Encode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export const base64Json = (value) => base64Encode(new TextEncoder().encode(JSON.stringify(value)));

/** The url-safe form, for JWT segments only. Never for an x402 envelope. */
export const base64url = (bytes) =>
  base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const base64urlJson = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));

export function base64Bytes(b64) {
  const binary = atob(String(b64).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export const base64Text = (b64) => new TextDecoder().decode(base64Bytes(b64));
