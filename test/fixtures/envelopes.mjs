// The fixture envelopes — one per failure this service exists to catch.
//
// Every fixture is CONSTRUCTED here rather than captured, for one reason: a
// captured broken envelope is broken in several ways at once, and a test that
// asserts on the whole report cannot then say which check did the work. Each
// fixture below is a perfect dual-stack 402 with exactly ONE thing changed, so
// the assertion "this fixture produces this code and this grade" is a statement
// about one check.
//
// The one exception is the positive control, which is a real captured
// production response and lives in worker/positive-control.js. It is the other
// half of the same argument: constructed fixtures prove the checks fire,
// captured reality proves they do not fire when they should not.

import { base64Encode } from '../../worker/envelope.js';

export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const EIP712 = { name: 'USD Coin', version: '2' };
export const PAYTO = '0x0000000000000000000000000000000000000001';
export const RESOURCE_URL = 'https://example.com/api/thing';

const b64 = (value) => base64Encode(new TextEncoder().encode(JSON.stringify(value)));

/** A deep clone that keeps the fixtures independent of each other. */
const clone = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------------ the reference

/** A conformant v1 accepts entry. */
export const v1Accept = () => ({
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '1000',
  resource: RESOURCE_URL,
  description: 'an example paid endpoint',
  mimeType: 'application/json',
  payTo: PAYTO,
  maxTimeoutSeconds: 60,
  asset: USDC_BASE,
  extra: EIP712,
  outputSchema: {
    input: {
      type: 'http',
      method: 'POST',
      discoverable: true,
      bodyType: 'text',
      description: 'the request body',
    },
    output: { type: 'string', description: 'the response body' },
  },
});

export const v1Envelope = () => ({ x402Version: 1, accepts: [v1Accept()] });

/** A conformant v2 accepts entry: exactly the seven fields, and nothing else. */
export const v2Accept = () => ({
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '1000',
  asset: USDC_BASE,
  payTo: PAYTO,
  maxTimeoutSeconds: 60,
  extra: EIP712,
});

export const v2Resource = () => ({
  url: RESOURCE_URL,
  method: 'POST',
  description: 'an example paid endpoint',
  mimeType: 'application/json',
  tags: ['x402', 'example'],
  serviceName: 'Example',
});

/**
 * A conformant extensions.bazaar: an `info` and the `schema` that admits it.
 *
 * Written as a matched pair on purpose — the mismatch fixture below is made by
 * breaking exactly one side of it, which is how the real failure happens too
 * (someone renames a field on one side and not the other).
 */
export const bazaar = () => ({
  bazaar: {
    info: {
      input: { type: 'http', method: 'POST', bodyType: 'text', body: '{"hello":"world"}' },
      output: { type: 'text', format: 'application/json', example: '{"ok":true}' },
    },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        input: {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'http' },
            method: { type: 'string', const: 'POST' },
            bodyType: { type: 'string', const: 'text' },
            body: { type: 'string', maxLength: 262144 },
          },
          required: ['type', 'method', 'bodyType', 'body'],
          additionalProperties: false,
        },
        output: {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'text' },
            format: { type: 'string', const: 'application/json' },
            example: { type: 'string' },
          },
          required: ['type', 'format'],
          additionalProperties: false,
        },
      },
      required: ['input'],
    },
  },
});

export const v2Envelope = () => ({
  x402Version: 2,
  resource: v2Resource(),
  accepts: [v2Accept()],
  extensions: bazaar(),
});

/**
 * Assemble a response from whichever halves are given.
 *
 * `v2Raw` bypasses the encoder so the base64-encoding fixtures can put an
 * arbitrary string in the header — which is the whole point of two of them.
 */
export function response({ status = 402, v1 = null, v2 = null, v2Raw = null, headers = {}, url = null } = {}) {
  const h = { ...headers };
  if (!('content-type' in h) && v1) h['content-type'] = 'application/json; charset=utf-8';
  if (v2Raw !== null) h['payment-required'] = v2Raw;
  else if (v2) h['payment-required'] = b64(v2);
  return { status, headers: h, body: v1 ? JSON.stringify(v1) : '', url };
}

/**
 * A genuinely url-safe encoding of the reference v2 envelope.
 *
 * The naive version of this fixture — `b64(env).replace(/\+/g,'-')` — was a
 * silent no-op, because the reference envelope's base64 happened to contain
 * neither `+` nor `/`, so the "broken" fixture was byte-identical to the good
 * one and the test passed while proving nothing. It is exactly the class of
 * green-but-empty test this repo's whole premise is about, so it is fixed by
 * CONSTRUCTION and then ASSERTED rather than by hoping: filler is appended to
 * the description until the standard encoding actually contains a character
 * that base64url would rewrite, and the result is checked before it is used.
 *
 * The filler is `?` rather than something innocuous like `.`, and that detail
 * is the whole reason the first attempt failed. In base64 of pure ASCII, only
 * the FOURTH character of a group can reach index 62 or 63 — it is `b2 & 63` —
 * so `+` and `/` appear only when a byte of 0x3E/0x7E or 0x3F/0x7F lands at a
 * position that is 2 mod 3. `?` is 0x3F; varying the filler length walks it
 * into alignment. A `.` (0x2E) can never produce either character no matter
 * how many you add, which is exactly why the naive fixture was a no-op.
 *
 * Deterministic: the same envelope always yields the same header.
 */
export function urlSafeEnvelopeHeader() {
  const env = v2Envelope();
  const base = env.resource.description;
  let raw = '';
  for (let pad = 0; pad < 64; pad++) {
    env.resource.description = base + '?'.repeat(pad);
    raw = b64(env);
    if (/[+/]/.test(raw)) break;
  }
  if (!/[+/]/.test(raw)) throw new Error('could not construct an envelope whose base64 needs rewriting');
  const unsafe = raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (unsafe === raw) throw new Error('the url-safe fixture is identical to the standard one');
  return unsafe;
}

// ------------------------------------------------------------------ the fixtures
//
// `expect.grade` and `expect.codes` are the contract. `codes` is the EXACT set
// of finding codes — not a subset — so a fixture that starts producing an extra
// finding fails rather than quietly passing, which is what keeps a new check
// from silently changing every other fixture's meaning.

export const FIXTURES = [
  {
    name: 'perfect dual-stack 402',
    why: 'the reference. Everything else is this with one thing broken.',
    response: () => response({ v1: v1Envelope(), v2: v2Envelope(), url: RESOURCE_URL }),
    expect: { grade: 'A', codes: [] },
  },
  {
    name: 'perfect v2-only 402',
    why: 'valid and modern, but invisible to every v1 client that still exists.',
    response: () => response({ v2: v2Envelope(), url: RESOURCE_URL }),
    // HTTP_CONTENT_TYPE_JSON deliberately does NOT fire here: it is a claim
    // about the v1 envelope's transport, and there is no v1 envelope to
    // mislabel. Complaining about the content-type of an absent body would be
    // a second finding for one fault.
    expect: { grade: 'B', codes: ['V1_BODY_PRESENT'] },
  },
  {
    name: 'perfect v1-only 402',
    why: 'the commonest real shape, and the one CDP tells sellers to upgrade.',
    response: () => response({ v1: v1Envelope(), url: RESOURCE_URL }),
    expect: { grade: 'B', codes: ['V2_HEADER_PRESENT'] },
  },
  {
    name: 'v2 header in url-safe base64',
    why:
      'the most expensive one-character bug in x402: the client validates the header ' +
      'against the standard-base64 charset BEFORE decoding, so a url-safe envelope is ' +
      'discarded unread and the seller looks like they published nothing.',
    response: () => response({ v1: v1Envelope(), v2Raw: urlSafeEnvelopeHeader(), url: RESOURCE_URL }),
    expect: { grade: 'F', codes: ['V2_B64_URLSAFE'] },
  },
  {
    name: 'v2 envelope naming the network "base"',
    why: 'the v1 spelling in a v2 envelope. The v2 schema requires the colon, so this is invalid, not lenient.',
    response: () => {
      const v2 = v2Envelope();
      v2.accepts[0].network = 'base';
      return response({ v1: v1Envelope(), v2, url: RESOURCE_URL });
    },
    // The chain still matches on both sides (base === eip155:8453), so DUAL_NETWORK
    // stays quiet — the fault is the spelling, and only the v2 check should say so.
    expect: { grade: 'F', codes: ['V2_NETWORK_CAIP2'] },
  },
  {
    name: 'v2 envelope with a flat-string resource',
    why: 'the v1 resource form at the v2 top level. An indexer gets no name, no method and no description.',
    response: () => {
      const v2 = v2Envelope();
      v2.resource = RESOURCE_URL;
      return response({ v1: v1Envelope(), v2, url: RESOURCE_URL });
    },
    expect: { grade: 'F', codes: ['V2_RESOURCE_OBJECT'] },
  },
  {
    name: 'v2 envelope carrying maxAmountRequired instead of amount',
    why: 'v2 renamed the price field; a v2 client reads `amount`, finds nothing, and has no price to sign.',
    response: () => {
      const v2 = v2Envelope();
      v2.accepts[0].maxAmountRequired = v2.accepts[0].amount;
      delete v2.accepts[0].amount;
      return response({ v1: v1Envelope(), v2, url: RESOURCE_URL });
    },
    // Two findings, not three. DUAL_PRICE stays quiet on purpose: the seller
    // meant one price and typed it in the wrong field, so the dual-stack check
    // reads through to the same number. The fault is the field name, and two
    // checks already say so — a third would be noise dressed as thoroughness.
    expect: { grade: 'F', codes: ['V2_AMOUNT', 'V2_ACCEPTS_V1_FIELDS'] },
  },
  {
    name: 'v1 envelope carrying amount instead of maxAmountRequired',
    why: 'the mirror image: the v2 spelling in a v1 body.',
    response: () => {
      const v1 = v1Envelope();
      v1.accepts[0].amount = v1.accepts[0].maxAmountRequired;
      delete v1.accepts[0].maxAmountRequired;
      return response({ v1, v2: v2Envelope(), url: RESOURCE_URL });
    },
    expect: { grade: 'F', codes: ['V1_MAX_AMOUNT_REQUIRED'] },
  },
  {
    name: 'v1 envelope naming the network in CAIP-2',
    why: 'the v2 spelling in a v1 body.',
    response: () => {
      const v1 = v1Envelope();
      v1.accepts[0].network = 'eip155:8453';
      return response({ v1, v2: v2Envelope(), url: RESOURCE_URL });
    },
    expect: { grade: 'F', codes: ['V1_NETWORK_NAME'] },
  },
  {
    name: 'v1 envelope with an object resource',
    why: 'the v2 resource form inside a v1 accepts entry.',
    response: () => {
      const v1 = v1Envelope();
      v1.accepts[0].resource = v2Resource();
      return response({ v1, v2: v2Envelope(), url: RESOURCE_URL });
    },
    expect: { grade: 'F', codes: ['V1_RESOURCE_STRING'] },
  },
  {
    name: 'v2 envelope with no extensions.bazaar',
    why: 'payable but not discoverable. The listing never appears and nothing says why.',
    response: () => {
      const v2 = v2Envelope();
      delete v2.extensions;
      return response({ v1: v1Envelope(), v2, url: RESOURCE_URL });
    },
    expect: { grade: 'B', codes: ['V2_BAZAAR_PRESENT'] },
  },
  {
    name: 'bazaar info that does not validate against its own schema',
    why:
      'the silent delisting. The facilitator validates one against the other before ' +
      'cataloguing and declines without telling anyone; the endpoint keeps taking payments.',
    response: () => {
      const v2 = v2Envelope();
      // A rename on one side only — exactly how this happens in the wild.
      v2.extensions.bazaar.info.input.bodyType = 'json';
      return response({ v1: v1Envelope(), v2, url: RESOURCE_URL });
    },
    expect: { grade: 'D', codes: ['V2_BAZAAR_INFO_VALIDATES'] },
  },
  {
    name: 'bazaar info with no computed output example',
    why: "CDP's validator asks for one, and a hand-written example drifts the first time the endpoint changes.",
    response: () => {
      const v2 = v2Envelope();
      delete v2.extensions.bazaar.info.output.example;
      return response({ v1: v1Envelope(), v2, url: RESOURCE_URL });
    },
    expect: { grade: 'B', codes: ['V2_BAZAAR_OUTPUT_EXAMPLE'] },
  },
  {
    name: 'free tier: 200 to an unauthenticated caller',
    why:
      "Bazaar's prober calls with no payment on an interval and expects a 402. A free " +
      'tier fails that probe and delists an endpoint that was already indexed.',
    response: () => response({ status: 200, headers: { 'content-type': 'application/json' } }),
    // No envelope at all is also true of a 200, and both are worth reporting:
    // the 200 explains WHY there is no envelope.
    expect: { grade: 'F', codes: ['HTTP_FREE_TIER_200', 'V2_HEADER_PRESENT', 'V1_BODY_PRESENT', 'ENVELOPE_PRESENT'] },
  },
  {
    name: 'dual-stack payTo divergence',
    why: 'your two generations of buyers are paying two different addresses, and only one is yours.',
    response: () => {
      const v2 = v2Envelope();
      v2.accepts[0].payTo = '0x00000000000000000000000000000000000000ff';
      return response({ v1: v1Envelope(), v2, url: RESOURCE_URL });
    },
    expect: { grade: 'F', codes: ['DUAL_PAYTO'] },
  },
  {
    name: 'dual-stack price divergence',
    why: 'the same call quoted at two prices. The cheaper one is the one you will be held to.',
    response: () => {
      const v2 = v2Envelope();
      v2.accepts[0].amount = '2000';
      return response({ v1: v1Envelope(), v2, url: RESOURCE_URL });
    },
    expect: { grade: 'F', codes: ['DUAL_PRICE'] },
  },
  {
    name: 'dual-stack chain divergence',
    why: 'a payment signed on one chain is worthless on the other.',
    response: () => {
      const v2 = v2Envelope();
      v2.accepts[0].network = 'eip155:84532';
      return response({ v1: v1Envelope(), v2, url: RESOURCE_URL });
    },
    expect: { grade: 'F', codes: ['DUAL_NETWORK'] },
  },
  {
    name: 'dual-stack asset divergence',
    why: 'the two versions are selling for different money.',
    response: () => {
      const v2 = v2Envelope();
      v2.accepts[0].asset = '0x0000000000000000000000000000000000000abc';
      return response({ v1: v1Envelope(), v2, url: RESOURCE_URL });
    },
    expect: { grade: 'F', codes: ['DUAL_ASSET'] },
  },
  {
    name: 'a redirect instead of a 402',
    why:
      'x402 clients do not follow redirects before reading the envelope, and the paid retry ' +
      'is a POST carrying a payment header that a redirect drops.',
    response: () =>
      response({
        status: 307,
        headers: { location: 'https://example.com/api/thing/v2' },
      }),
    expect: { grade: 'F', codes: ['HTTP_REDIRECT', 'V2_HEADER_PRESENT', 'V1_BODY_PRESENT', 'ENVELOPE_PRESENT'] },
  },
  {
    name: 'version confusion: a v1 payload in the v2 header',
    why: 'clients key on the payload field, not on the transport it arrived in.',
    response: () => {
      const inHeader = clone(v2Envelope());
      inHeader.x402Version = 1;
      return response({ v1: v1Envelope(), v2: inHeader, url: RESOURCE_URL });
    },
    expect: { grade: 'F', codes: ['VERSION_HEADER_SAYS_V1', 'V2_VERSION'] },
  },
  {
    name: 'version confusion: a v2 payload in the body',
    why: 'the mirror image, and it makes a v1 client parse v2 fields with v1 rules.',
    response: () => {
      const inBody = clone(v1Envelope());
      inBody.x402Version = 2;
      return response({ v1: inBody, v2: v2Envelope(), url: RESOURCE_URL });
    },
    expect: { grade: 'F', codes: ['VERSION_BODY_SAYS_V2', 'V1_VERSION'] },
  },
  {
    name: 'no EIP-712 domain in `extra`',
    why:
      'the silent killer. The client signs over an undefined domain name while the ' +
      'facilitator recomputes it from its own table, so every real payment fails as ' +
      'invalid_exact_evm_payload_signature and nothing in the logs says so.',
    response: () => {
      const v1 = v1Envelope();
      const v2 = v2Envelope();
      delete v1.accepts[0].extra;
      delete v2.accepts[0].extra;
      return response({ v1, v2, url: RESOURCE_URL });
    },
    expect: { grade: 'B', codes: ['V2_EXTRA_EIP712', 'V1_EXTRA_EIP712'] },
  },
  {
    name: 'a 401 instead of a 402',
    why: 'an endpoint telling an agent to go find credentials, which is the opposite of what x402 offers.',
    response: () => response({ status: 401, headers: { 'content-type': 'text/plain' } }),
    expect: {
      grade: 'F',
      codes: ['HTTP_STATUS_402', 'V2_HEADER_PRESENT', 'V1_BODY_PRESENT', 'ENVELOPE_PRESENT'],
    },
  },
  {
    name: 'a 500 instead of a 402',
    why: 'usually the payment middleware throwing on the no-payment path — the path every caller takes first.',
    response: () => response({ status: 500, headers: { 'content-type': 'text/plain' } }),
    expect: {
      grade: 'F',
      codes: ['HTTP_SERVER_ERROR', 'HTTP_STATUS_402', 'V2_HEADER_PRESENT', 'V1_BODY_PRESENT', 'ENVELOPE_PRESENT'],
    },
  },
  {
    name: 'a price as a decimal string',
    why: 'atomic units are integers. "0.01" is rejected by the facilitator and 0.01 loses precision.',
    response: () => {
      const v1 = v1Envelope();
      const v2 = v2Envelope();
      v1.accepts[0].maxAmountRequired = '0.01';
      v2.accepts[0].amount = '0.01';
      return response({ v1, v2, url: RESOURCE_URL });
    },
    expect: { grade: 'F', codes: ['V2_AMOUNT_ATOMIC', 'V1_AMOUNT_ATOMIC'] },
  },
  {
    name: 'payTo that is not an address',
    why: 'clients do not resolve names, so a name in payTo is an endpoint nobody can pay.',
    response: () => {
      const v1 = v1Envelope();
      const v2 = v2Envelope();
      v1.accepts[0].payTo = 'treasury.example.eth';
      v2.accepts[0].payTo = 'treasury.example.eth';
      return response({ v1, v2, url: RESOURCE_URL });
    },
    expect: { grade: 'F', codes: ['V2_PAYTO', 'V1_PAYTO'] },
  },
  {
    name: 'v1 outputSchema with discoverable at the wrong level',
    why: 'the flag lives inside outputSchema.input; one level up is the commonest way to be quietly left out.',
    response: () => {
      const v1 = v1Envelope();
      delete v1.accepts[0].outputSchema.input.discoverable;
      v1.accepts[0].outputSchema.discoverable = true;
      return response({ v1, v2: v2Envelope(), url: RESOURCE_URL });
    },
    expect: { grade: 'B', codes: ['V1_DISCOVERABLE'] },
  },
  {
    name: 'a JSON envelope served as text/html',
    why: 'proxies and some clients decide whether to parse a body from its content-type.',
    response: () =>
      response({
        v1: v1Envelope(),
        v2: v2Envelope(),
        headers: { 'content-type': 'text/html; charset=utf-8' },
        url: RESOURCE_URL,
      }),
    expect: { grade: 'B', codes: ['HTTP_CONTENT_TYPE_JSON'] },
  },
  {
    name: 'a 402 with an unparseable body and no header',
    why: 'an HTML error page where the envelope should be — a seller who thinks 402 alone is enough.',
    response: () => ({
      status: 402,
      headers: { 'content-type': 'text/html' },
      body: '<h1>402 Payment Required</h1>',
      url: RESOURCE_URL,
    }),
    expect: { grade: 'F', codes: ['V2_HEADER_PRESENT', 'V1_BODY_JSON', 'ENVELOPE_PRESENT'] },
  },
];
