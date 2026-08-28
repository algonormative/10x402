// SHA-256, SYNCHRONOUSLY, in about sixty lines.
//
// ------------------------------------------------------------------ why not crypto.subtle
//
// Because `crypto.subtle.digest` returns a PROMISE and the one caller here
// cannot await. The receipt's digest has to be computable inside
// `sampleOutput()` (worker/envelope.js), which is synchronous by construction:
// it feeds `extensions.bazaar.info.output.example`, which feeds the v2 envelope,
// which is base64'd into a RESPONSE HEADER while the 402 is being built. Making
// that path async would ripple through build402 → paymentRequired → every 402
// this Worker answers, and through build.mjs's self-lint, to buy nothing.
//
// The alternative was to freeze a precomputed digest string in
// worker/monitor-control.js. That would make the published receipt example the
// one part of it that was typed by hand rather than computed — in a document
// whose entire selling point is that a disputing seller can recompute every
// number in it. A hand-typed digest in a receipt sample is the exact shape of
// lie this repo exists to catch in other people's envelopes.
//
// So: one implementation, used by the request path and by the envelope sample
// alike, and test/monitor-surfaces.test.mjs pins it against the NIST vectors AND
// against `crypto.subtle` over the same bytes — the platform's own SHA-256 is
// the oracle, so a divergence is a test failure rather than a silent wrong hash.
//
// NOTHING ON THE PAYMENT PATH USES THIS. worker/x402.js keeps its async
// `sha256Hex` for the single-use payment claim; that path is already async and
// has every reason to use the platform primitive. Two callers, two shapes, one
// algorithm — and the test proves they agree.

/** The first 32 bits of the fractional parts of the cube roots of the first 64 primes (FIPS 180-4 §4.2.2). */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** SHA-256 of a byte array, as 32 bytes. */
export function sha256Bytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const bitLength = bytes.length * 8;

  // Pad: one 0x80 byte, then zeros, then the 64-bit big-endian bit length. The
  // padded length is the next multiple of 64 that leaves room for those 9 bytes.
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // The high word of the length: a Worker cannot hold a 2^32-byte string, so it
  // is written as zero rather than pretended to be computed.
  view.setUint32(padded.length - 8, 0);
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = H0.slice();
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256HexSync(text) {
  const digest = sha256Bytes(new TextEncoder().encode(String(text)));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}
