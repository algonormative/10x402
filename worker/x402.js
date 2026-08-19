// The facilitator side: verify a presented payment, settle it after the work.
//
// Adapted from the sibling service's proven implementation. The CDP x402
// facilitator does the two things a Worker cannot — check that a signed payment
// is good (verify) and put the transfer on chain (settle) — and both are one
// POST with the same three-field body, `{ x402Version, paymentPayload,
// paymentRequirements }`, authenticated with a short-lived CDP bearer JWT.
//
// WHY THE JWT IS BUILT HERE rather than by @coinbase/x402: that package is 40
// lines of glue over generateJwt from @coinbase/cdp-sdk, which drags viem, zod
// and the whole CDP SDK into a Workers bundle for one Ed25519 signature. What
// follows is the same JWT — same header, same claims, same key handling —
// through WebCrypto, which workerd has natively. It adds no dependency at all.

import { base64Bytes, base64url, base64urlJson, PAYMENT_HEADER_V1, PAYMENT_HEADER_V2 } from './envelope.js';

// The documented production endpoint. Overridable so the suite can point it at
// a local mock; production never sets FACILITATOR_URL.
const DEFAULT_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

// Verify is on the critical path — the caller is waiting — so it gets a hard
// cap and an unreachable facilitator costs availability, not the request.
// Settle runs after the response in ctx.waitUntil, so it can afford to wait for
// a Base confirmation without anyone noticing.
const VERIFY_TIMEOUT_MS = 2_000;
const SETTLE_TIMEOUT_MS = 20_000;

// CDP bearer tokens are minted per call and live 120 s, matching @coinbase/cdp-sdk.
const CDP_JWT_TTL_SECONDS = 120;

/**
 * The payment presented on this request, in whichever version it arrived.
 *
 * THE VERSION COMES OUT OF THE PAYLOAD, NOT THE HEADER. `x402Version` is a
 * required field of both payload schemas and it is what the facilitator's own
 * client keys on, so it survives a client that puts a v2 payload in the old
 * header. Anything that is not exactly 2 is treated as v1.
 *
 * Returns null when no payment was presented; `decoded` is null when one was
 * presented and could not be decoded, which is a rejection, not an absence.
 */
export function presentedPayment(request) {
  const raw = request.headers.get(PAYMENT_HEADER_V2) || request.headers.get(PAYMENT_HEADER_V1);
  if (!raw) return null;
  const decoded = decodePaymentHeader(raw);
  // `raw` comes back with it so the caller can hash the payment EXACTLY as
  // presented, which is what the single-use claim in payment_seen is keyed on.
  // Hashing the decoded object instead would need a canonical serialisation
  // this code does not have, and would quietly treat two different bytes as one
  // payment.
  return { raw: String(raw).trim(), decoded, version: decoded?.x402Version === 2 ? 2 : 1 };
}

export const paymentPresented = (request) =>
  !!(request.headers.get(PAYMENT_HEADER_V2) || request.headers.get(PAYMENT_HEADER_V1));

function decodePaymentHeader(raw) {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64Bytes(raw)));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Best effort only: before verify, the payer is a CLAIM read out of the payload
 * the caller sent. The verified value replaces it when the facilitator returns one.
 */
export const payerOf = (payload) => payload?.payload?.authorization?.from ?? null;

/**
 * Ask the facilitator whether a presented payment is good.
 *
 * `requirements` must already be the VERSION-APPROPRIATE shape — the v1
 * envelope for a v1 payload, the v2 accepts entry for a v2 one. Getting that
 * pairing wrong is invisible locally and fatal in production: the facilitator
 * recovers the signature against what it is handed, so a v2 payload checked
 * against a v1 envelope verifies as invalid however good the payment was.
 *
 * NEVER THROWS — every failure is a verdict, because the caller is mid-request.
 * Returns exactly one of:
 *   { verified: true, payload, payer }   serve, then settle
 *   { rejected: true, reason, message }  the facilitator said no — 402
 *   { unavailable: '<reason>' }          we could not ask — serve, unverified
 */
export async function verifyPayment(env, payment, requirements) {
  const decoded = payment?.decoded;
  if (!decoded) {
    // A BACKSTOP, NOT THE PATH. worker.js answers an undecodable header before
    // it gets here — with no D1 write and no quota claim, because bytes that do
    // not decode are not a payment attempt and must not be able to write to the
    // ledger. This branch stays so that a future caller of verifyPayment cannot
    // reach the facilitator with nothing, and it is deliberately the only
    // `rejected` verdict this function produces without asking anyone.
    return {
      rejected: true,
      reason: 'malformed_payment_header',
      message:
        'X-PAYMENT (x402 v1) or PAYMENT-SIGNATURE (x402 v2) must be base64-encoded JSON — an x402 payment payload',
      payer: null,
    };
  }

  const payer = payerOf(decoded);
  if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) {
    // Operator error, not caller error, and kept distinct from a network
    // failure so the ledger says which one to go fix.
    return { unavailable: 'facilitator-unconfigured', payer };
  }

  const call = await facilitatorCall(env, 'verify', decoded, requirements, VERIFY_TIMEOUT_MS);
  if (!call.ok) return { unavailable: call.reason, payer };

  const data = call.data;
  if (data?.isValid === true) return { verified: true, payload: decoded, payer: data.payer || payer };
  if (data?.isValid === false) {
    return {
      rejected: true,
      reason: data.invalidReason || 'unspecified',
      message: data.invalidMessage || null,
      payer: data.payer || payer,
    };
  }
  // A 200 that is not a VerifyResponse means the facilitator is broken, which
  // is an outage — not evidence against the payment.
  return { unavailable: 'facilitator-error', payer };
}

/**
 * Settle a verified payment. Runs after the response, inside ctx.waitUntil,
 * where an exception would be invisible — so it never throws.
 *
 * `resource` is completed on the SETTLE payload and only there. A discovery
 * index attaches a settlement to a listing by reading `resource` off the settle
 * body, and an x402 client is not obliged to echo it back. It is spread in, so
 * a client that DID send one keeps its own, and it is deliberately absent from
 * verify — verify is the signature check, and the payload it sees stays
 * byte-for-byte what arrived. `resource` is envelope metadata outside the
 * EIP-712 signature, so adding it here cannot invalidate anything.
 */
export async function settlePayment(env, { facRequirements, payload, ownResource }) {
  const settlePayload = payload?.resource ? payload : { ...payload, resource: ownResource };
  try {
    const call = await facilitatorCall(env, 'settle', settlePayload, facRequirements, SETTLE_TIMEOUT_MS);
    if (!call.ok) return { settleOk: 0, txHash: null, error: call.reason };
    if (call.data?.success === true) {
      return { settleOk: 1, txHash: call.data.transaction || null, error: null };
    }
    return { settleOk: 0, txHash: null, error: call.data?.errorReason || 'settle_failed' };
  } catch (err) {
    return { settleOk: 0, txHash: null, error: oneLineMessage(err) };
  }
}

/**
 * One POST to the facilitator. Returns { ok: true, data } or { ok: false, reason }.
 *
 * IT IS THE SAME BODY AND THE SAME TWO ENDPOINTS IN BOTH VERSIONS — the version
 * travels in the payload and in the shapes, so this function needs no branch.
 * (The `v2` in the CDP path is CDP's platform API version and has nothing to do
 * with the protocol version.)
 */
async function facilitatorCall(env, endpoint, payload, requirements, timeoutMs) {
  const base = (env.FACILITATOR_URL || DEFAULT_FACILITATOR_URL).replace(/\/+$/, '');
  const url = `${base}/${endpoint}`;

  let authorization;
  try {
    authorization = await cdpAuthHeader(env, 'POST', url);
  } catch {
    // A key that will not import is a configuration fault, not an outage, but
    // it fails the same way for the caller: we cannot ask.
    return { ok: false, reason: 'facilitator-unconfigured' };
  }

  // AbortController rather than AbortSignal.timeout so the timer is cleared on
  // the happy path instead of firing into a finished request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({
        x402Version: payload.x402Version ?? 1,
        paymentPayload: payload,
        paymentRequirements: requirements,
      }),
      signal: controller.signal,
    });
    // Anything but a 200 is the facilitator's problem, including a 4xx that
    // says OUR request was wrong — which is why these are recorded rather than
    // swallowed. A run of them in `settlements` is the alarm.
    if (res.status !== 200) return { ok: false, reason: `facilitator-http-${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return {
      ok: false,
      reason: err?.name === 'AbortError' ? 'facilitator-timeout' : 'facilitator-unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `Authorization: Bearer <CDP JWT>`.
 *
 * Bound to the exact call it authorises: the `uris` claim carries
 * "POST host/path", so a token minted for /verify cannot be replayed at /settle.
 */
async function cdpAuthHeader(env, method, url) {
  const keyId = env.CDP_API_KEY_ID;
  const secret = env.CDP_API_KEY_SECRET;
  if (!keyId || !secret) return undefined;

  const { host, pathname } = new URL(url);
  const raw = base64Bytes(secret);
  // A CDP Secret API Key is base64 of 64 bytes: a 32-byte Ed25519 seed followed
  // by its 32-byte public key. The older EC/PEM format is not supported here.
  if (raw.length !== 64) throw new Error('CDP_API_KEY_SECRET is not a 64-byte base64 Ed25519 key');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', d: base64url(raw.subarray(0, 32)), x: base64url(raw.subarray(32)) },
    { name: 'Ed25519' },
    false,
    ['sign']
  );

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'EdDSA', kid: keyId, typ: 'JWT', nonce: randomHex(16) };
  const claims = {
    sub: keyId,
    iss: 'cdp',
    uris: [`${method} ${host}${pathname}`],
    iat: now,
    nbf: now,
    exp: now + CDP_JWT_TTL_SECONDS,
  };

  const signingInput = `${base64urlJson(header)}.${base64urlJson(claims)}`;
  const signature = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(signingInput));
  return `Bearer ${signingInput}.${base64url(new Uint8Array(signature))}`;
}

/**
 * The two `x-payment-error` values a caller can see.
 *
 * The LEDGER keeps the precise reason (facilitator-timeout, facilitator-http-503,
 * …) because that is what an operator debugs from; the header keeps a small
 * stable vocabulary because that is what a client branches on. The distinction
 * worth exposing is "we could not reach it" vs "this seller has not finished
 * configuring payments" — those want different reactions.
 */
export const publicReason = (reason) =>
  reason === 'facilitator-unconfigured' ? 'facilitator-unconfigured' : 'facilitator-unreachable';

export function oneLineMessage(err) {
  const raw = String((err && err.message) || err || 'unknown error');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function randomHex(bytes) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function hex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return hex(new Uint8Array(digest));
}

/**
 * The caller-identity hash: SHA-256 truncated to 64 bits.
 *
 * Truncated because it keys a per-day counter and nothing else — a collision
 * costs one caller a share of another's allowance for one day, and the shorter
 * value is that much less of a handle on an IP. The single-use payment claim
 * uses the FULL digest (sha256Hex): there a collision would hand a stranger's
 * payment to whoever collided with it.
 */
export async function truncatedHash(input) {
  return (await sha256Hex(input)).slice(0, 16);
}
