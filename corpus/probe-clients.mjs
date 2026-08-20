#!/usr/bin/env node
// GROUND TRUTH FOR THE `client-code` CITATIONS: the pinned x402 client packages,
// installed from the registry and RUN over corpus/fixtures.json.
//
// ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
//
// Every `client_interop` verdict in this corpus rests on a `client-code`
// citation, and a citation is a claim about how a named package at a named
// version behaves. Until now those claims were READ OFF THE SOURCE — someone
// opened `dist/esm/chunk-*.mjs`, followed the control flow, and wrote down what
// they concluded would happen. That is inference, and a pre-publication review
// caught it being wrong: a fixture was cited as accepted by a schema that in
// fact rejects it. Reading code is not running code. This file runs it.
//
// The output, corpus/client-probe.json, is the record: for every fixture, every
// reachable client entry point, what it actually returned or threw, verbatim.
// A citation that contradicts that file is wrong and the file is the evidence.
//
// ─── THE DISAGREEMENT THIS FILE EXISTS TO SURFACE ──────────────────────────
//
// There are TWO different things a v2 "client" does with a challenge, and they
// do not agree with each other:
//
//   * THE DECODE PATH — `decodePaymentRequiredHeader` in @x402/core/http, which
//     `x402HTTPClient#getPaymentRequiredResponse` calls, which is what an actual
//     client run actually executes. Its body is a Base64EncodedRegex test
//     followed by `JSON.parse`. It validates the ENCODING and nothing else. Any
//     JSON that survives base64 comes back as an object, however far from the
//     specification it is.
//   * THE SCHEMA — `PaymentRequiredV2Schema` and friends in @x402/core/schemas,
//     which are zod objects with required fields. They are EXPORTED, so a
//     consumer may call them, but the package's own payment path does not.
//
// So "@x402/core accepts this envelope" is ambiguous, and the ambiguity is
// load-bearing: an envelope can be decoded happily by every real client and
// rejected outright by the schema the same package ships. Both outcomes are
// recorded per fixture, and `disagreements` at the top of the output lists every
// fixture where they differ. That list is the point of this file.
//
// ─── WHAT IS NOT DONE HERE ─────────────────────────────────────────────────
//
// NO PAYMENT IS MADE AND NONE CAN BE. There is no key, no wallet and no chain
// in this process. The v1 fetch wrapper is exercised with a stub transport and a
// SELECTOR THAT THROWS A SENTINEL the moment selection completes, so control
// never reaches `createPaymentHeader` — signing is structurally unreachable
// rather than merely unrequested. Everything past that boundary is recorded as
// `not-exercisable-offline` and never as a result. The only network traffic is
// the npm install.
//
// ─── DETERMINISM ───────────────────────────────────────────────────────────
//
// Running this file twice must produce the same bytes, or "these are the pinned
// packages' answers" is unfalsifiable. Three things would otherwise move:
//
//   * THE INSTALLED BYTES. The first run resolves the tree and writes the
//     lockfile to corpus/client-probe.lock.json; every later run installs from
//     that lockfile with `npm ci`, so the same package tree executes. The
//     resolved version and integrity of each probed package are read back out of
//     the lockfile and recorded, so the output states what actually ran.
//   * THE DATE. Carried forward from the existing output, or from
//     corpus/fixtures.json on the first run. `--stamp` refreshes it, exactly as
//     corpus/build-fixtures.mjs does.
//   * ERROR TEXT. Recorded verbatim, including zod's issue list, which is a pure
//     function of the input and the schema.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, 'fixtures.json'), 'utf8'));
const LOCKFILE = join(here, 'client-probe.lock.json');
const OUT = join(here, 'client-probe.json');

// ------------------------------------------------------------------ the pins
//
// EXACT VERSIONS, NO RANGES. A caret here would make the whole file a claim
// about whatever npm felt like resolving on the day, which is the opposite of
// what a pinned citation is for.

const PINNED = {
  '@x402/core': '2.23.0',
  '@x402/evm': '2.23.0',
  '@x402/fetch': '2.23.0',
  x402: '1.2.0',
  'x402-fetch': '1.2.0',
};

// The sandbox is keyed by the pin set, so changing a version installs into a
// fresh directory instead of layering onto a stale tree.
const PIN_KEY = createHash('sha256').update(JSON.stringify(PINNED)).digest('hex').slice(0, 12);
const SANDBOX = join(tmpdir(), `x402-client-probe-${PIN_KEY}`);

const MANIFEST = {
  name: 'x402-client-probe',
  version: '1.0.0',
  private: true,
  type: 'module',
  dependencies: PINNED,
};

function npm(args, cwd) {
  return execFileSync('npm', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

/**
 * Installs the pinned tree into the sandbox and returns the lockfile.
 *
 * THE LOCKFILE IS THE POINT. `npm install` at exact versions still resolves the
 * transitive tree freshly, and those transitives include zod — whose error text
 * this file records verbatim. So the first run's resolution is captured to
 * corpus/client-probe.lock.json and committed, and every later run installs from
 * it with `npm ci`, which is the only npm subcommand that promises to install
 * the lockfile rather than reconcile it.
 */
function install() {
  const haveLock = existsSync(LOCKFILE);
  const marker = join(SANDBOX, '.probe-installed');
  const lockHash = haveLock
    ? createHash('sha256').update(readFileSync(LOCKFILE)).digest('hex')
    : null;

  if (haveLock && existsSync(marker) && readFileSync(marker, 'utf8') === lockHash) {
    return JSON.parse(readFileSync(LOCKFILE, 'utf8'));
  }

  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });
  writeFileSync(join(SANDBOX, 'package.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);

  if (haveLock) {
    copyFileSync(LOCKFILE, join(SANDBOX, 'package-lock.json'));
    process.stderr.write(`npm ci from ${LOCKFILE}\n`);
    npm(['ci', '--no-audit', '--no-fund', '--loglevel=error'], SANDBOX);
  } else {
    process.stderr.write('no lockfile yet — resolving the tree once and recording it\n');
    npm(['install', '--no-audit', '--no-fund', '--loglevel=error'], SANDBOX);
    copyFileSync(join(SANDBOX, 'package-lock.json'), LOCKFILE);
    process.stderr.write(`wrote ${LOCKFILE}\n`);
  }

  const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8'));
  writeFileSync(marker, createHash('sha256').update(readFileSync(LOCKFILE)).digest('hex'));
  return lock;
}

const lock = install();

/**
 * What the lockfile says about a package, so the output records the bytes that
 * ran rather than the bytes that were asked for. The two are the same here only
 * because `npm ci` makes them the same, which is why it is used.
 */
function resolvedFromLock(name) {
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry) return { version: null, integrity: null, note: 'not present in the lockfile' };
  return { version: entry.version ?? null, integrity: entry.integrity ?? null, resolved: entry.resolved ?? null };
}

/**
 * Imports a package subpath OUT OF THE SANDBOX.
 *
 * Node resolves a bare specifier against the importing file's location, which is
 * this repository — and 10x402 does not depend on any of these packages and must
 * not start doing so just because a probe wants them. So the sandbox path is
 * built by hand and the subpath is resolved through the package's own `exports`
 * map, exactly as a consumer's resolver would, rather than by guessing a file.
 */
async function loadFrom(specifier) {
  const [scope, rest] = specifier.startsWith('@')
    ? [specifier.split('/').slice(0, 2).join('/'), specifier.split('/').slice(2).join('/')]
    : [specifier.split('/')[0], specifier.split('/').slice(1).join('/')];
  const pkgDir = join(SANDBOX, 'node_modules', scope);
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const key = rest ? `./${rest}` : '.';
  const entry = pkg.exports?.[key];
  const file = entry?.import?.default ?? entry?.default ?? (key === '.' ? pkg.module ?? pkg.main : null);
  if (!file) throw new Error(`${specifier}: no ESM entry declared in exports`);
  return import(pathToFileURL(join(pkgDir, file)).href);
}

// ------------------------------------------------------------------ the surface
//
// WHAT THE PACKAGES ACTUALLY EXPORT, enumerated rather than assumed. The names
// in this corpus's citations have to be names that exist, and the only way to
// know which ones do is to ask the package. Every subpath the package.json
// `exports` map declares is imported and its export names recorded; anything
// that fails to import is recorded as failing, not silently dropped.

async function enumerateExports(pkgName) {
  const pkgDir = join(SANDBOX, 'node_modules', pkgName);
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const subpaths = Object.keys(pkg.exports ?? { '.': {} }).filter((k) => !k.includes('*'));
  const out = {};
  for (const sub of subpaths.sort()) {
    const specifier = sub === '.' ? pkgName : `${pkgName}${sub.slice(1)}`;
    try {
      const mod = await loadFrom(specifier);
      out[specifier] = Object.keys(mod).sort();
    } catch (error) {
      out[specifier] = { import_failed: error instanceof Error ? error.message.split('\n')[0] : String(error) };
    }
  }
  return out;
}

const exportsByPackage = {};
for (const name of Object.keys(PINNED)) exportsByPackage[name] = await enumerateExports(name);

// ------------------------------------------------------------------ the modules

const coreHttp = await loadFrom('@x402/core/http');
const coreSchemas = await loadFrom('@x402/core/schemas');
const coreUtils = await loadFrom('@x402/core/utils');
const v1Types = await loadFrom('x402/types');
const v1Client = await loadFrom('x402/client');
const v1Fetch = await loadFrom('x402-fetch');

// ------------------------------------------------------------------ outcomes
//
// FIVE OUTCOMES, and the distinctions between them are the ones a reader needs
// in order to not over-read the file:
//
//   accepted  — the entry point returned. For a safeParse, `success: true`.
//   rejected  — the entry point said the input is invalid. A zod failure, or a
//               documented validation throw such as decodePaymentRequiredHeader's
//               "Invalid payment required header". This is a VERDICT.
//   threw     — an error that is not one of the package's documented refusals: a
//               type error, an unhandled network name, a JSON.parse blowing up on
//               a body the code assumed was there. Recorded verbatim and never
//               counted as a rejection, because "it crashed" and "it declined"
//               are different findings and the first is usually the sharper one.
//   n/a       — the entry point's input is not present in this fixture. No
//               PAYMENT-REQUIRED header, no JSON body, not a 402. Silence, not
//               approval.
//   not-exercisable-offline — the path needs a key or a chain. Recorded as a
//               boundary. NOTHING past it is ever reported as a result.

const ACCEPTED = 'accepted';
const REJECTED = 'rejected';
const THREW = 'threw';
const NA = 'n/a';
const OFFLINE = 'not-exercisable-offline';

const isZodError = (error) => Boolean(error && typeof error === 'object' && Array.isArray(error.issues) && error.name === 'ZodError');

/** zod issues, flattened to the three fields that identify a rejection and nothing that moves. */
const issues = (error) => error.issues.map((i) => ({ path: i.path.map(String).join('.'), code: i.code, message: i.message }));

/** A safeParse result in the vocabulary above. */
function fromSafeParse(result) {
  if (result.success) return { outcome: ACCEPTED };
  return { outcome: REJECTED, issues: issues(result.error) };
}

/**
 * A throwing entry point in the vocabulary above.
 *
 * The classifier decides REJECTED versus THREW, and it is deliberately narrow:
 * a throw only counts as a verdict when it is one of the package's own
 * documented validation errors. Anything else is a crash, and a crash reported
 * as a rejection would flatter the package into looking like it had an opinion.
 */
const VALIDATION_MESSAGES = [
  'Invalid payment required header',
  'Invalid payment required response',
  'Invalid payment response header',
];

// A JSON.parse failure is NOT on this list and is deliberately not treated as a
// verdict. Where it happens — the v1 fetch wrapper meeting a header-only v2
// response with an empty body, or an HTML error page — the wrapper does not
// decline the response, it crashes on it. Recording that as a rejection would
// dress a crash up as an opinion, and "the v1 client crashes on a v2-only 402"
// is a sharper and truer finding than "the v1 client declines it".
function fromThrow(error) {
  if (isZodError(error)) return { outcome: REJECTED, issues: issues(error) };
  const message = error instanceof Error ? error.message : String(error);
  if (VALIDATION_MESSAGES.some((m) => message.startsWith(m))) return { outcome: REJECTED, error: message };
  return { outcome: THREW, error: `${error?.name ?? 'Error'}: ${message}` };
}

function attempt(fn) {
  try {
    const value = fn();
    return { outcome: ACCEPTED, ...(value === undefined ? {} : { returned: value }) };
  } catch (error) {
    return fromThrow(error);
  }
}

// ------------------------------------------------------------------ fixture inputs

/**
 * Everything a probe needs from one fixture, computed once.
 *
 * TWO DECODES, DELIBERATELY. `decoded` is what the real decode path produced —
 * absent when the path refused. `envelope` is the object the fixture author
 * MEANT, recovered leniently when the strict path refused, so the zod schemas
 * can still be run over it and the corpus can still say what a schema would have
 * made of the intended envelope. `envelope_source` says which is which, and a
 * reader who conflates them will read a schema verdict as a decode verdict.
 */
function inputsFor(fixture) {
  const headers = fixture.response.headers ?? {};
  const rawHeader = headers['payment-required'];
  const rawBody = fixture.response.body;

  let decoded = null;
  let decodeFailed = null;
  if (typeof rawHeader === 'string' && rawHeader !== '') {
    try {
      decoded = coreHttp.decodePaymentRequiredHeader(rawHeader);
    } catch (error) {
      decodeFailed = error instanceof Error ? error.message : String(error);
    }
  }

  let envelope = decoded;
  let envelopeSource = decoded ? 'decodePaymentRequiredHeader' : 'none';
  if (!envelope && typeof rawHeader === 'string' && rawHeader.trim() !== '') {
    // The strict path refused. Strip the whitespace HTTP would have stripped and
    // map the URL-safe alphabet back, purely so the schema question can still be
    // asked. This is NOT a claim that a client would do this — no client does.
    try {
      const relaxed = rawHeader.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
      envelope = JSON.parse(Buffer.from(relaxed, 'base64').toString('utf8'));
      envelopeSource = 'lenient-recovery (the real decode path REFUSED this header)';
    } catch {
      envelope = null;
      envelopeSource = 'unrecoverable';
    }
  }

  let body = null;
  let bodyParseError = null;
  if (typeof rawBody === 'string' && rawBody.trim() !== '') {
    try {
      body = JSON.parse(rawBody);
    } catch (error) {
      bodyParseError = error instanceof Error ? error.message : String(error);
    }
  }

  return { headers, rawHeader, decoded, decodeFailed, envelope, envelopeSource, rawBody, body, bodyParseError };
}

/** Case-insensitive header lookup, which is what x402HTTPClient asks its caller for. */
const getHeaderFrom = (headers) => (name) => {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value;
  return undefined;
};

// ------------------------------------------------------------------ the entry points
//
// Each entry point is a name, the citation string a corpus fixture would use for
// it, and a function from the fixture inputs to an outcome. They are ordered
// transport-first, because that is the order a client executes them in.

const SENTINEL = 'x402-client-probe: selection reached; signing is out of scope for an offline probe';

const ENTRY_POINTS = [
  // ---------------------------------------------------------------- v2, over the raw header
  {
    name: 'core.utils.Base64EncodedRegex.test',
    generation: 'v2',
    input: 'raw PAYMENT-REQUIRED header',
    cites: '@x402/core@2.23.0 utils — Base64EncodedRegex',
    why: 'the gate decodePaymentRequiredHeader applies before it will look at the bytes at all',
    run: ({ rawHeader }) => {
      if (typeof rawHeader !== 'string') return { outcome: NA, reason: 'the fixture records no PAYMENT-REQUIRED header' };
      const ok = coreUtils.Base64EncodedRegex.test(rawHeader);
      return ok ? { outcome: ACCEPTED } : { outcome: REJECTED, error: 'the header does not match Base64EncodedRegex' };
    },
  },
  {
    name: 'core.http.decodePaymentRequiredHeader',
    generation: 'v2',
    input: 'raw PAYMENT-REQUIRED header',
    cites: '@x402/core@2.23.0 http — decodePaymentRequiredHeader()',
    why: 'THE REAL DECODE PATH. Base64EncodedRegex test, then JSON.parse. No schema runs here',
    run: ({ rawHeader }) => {
      if (typeof rawHeader !== 'string') return { outcome: NA, reason: 'the fixture records no PAYMENT-REQUIRED header' };
      return attempt(() => {
        coreHttp.decodePaymentRequiredHeader(rawHeader);
        return undefined;
      });
    },
  },
  {
    name: 'core.http.x402HTTPClient#getPaymentRequiredResponse',
    generation: 'v2+v1',
    input: 'the recorded headers and the parsed body',
    cites: '@x402/core@2.23.0 http — x402HTTPClient.getPaymentRequiredResponse()',
    why:
      'what a v2 client run actually executes: the PAYMENT-REQUIRED header if there is one, ' +
      'otherwise the body when it declares x402Version 1. This one method is where the two ' +
      'generations meet, so it is the entry point that answers "which path parsed this fixture"',
    run: ({ headers, body }) => {
      // The instance never touches `this.client`, so no signer is constructed and
      // none can be reached from here.
      const client = new coreHttp.x402HTTPClient(null);
      return attempt(() => {
        const value = client.getPaymentRequiredResponse(getHeaderFrom(headers), body ?? undefined);
        return { x402Version: value?.x402Version ?? null };
      });
    },
  },
  // ---------------------------------------------------------------- v2, over the decoded envelope
  {
    name: 'core.schemas.PaymentRequiredV2Schema.safeParse',
    generation: 'v2',
    input: 'the decoded v2 envelope',
    cites: '@x402/core@2.23.0 schemas — PaymentRequiredV2Schema',
    why:
      'the exported schema. NOT called by the package on the payment path — a consumer has to ' +
      'reach for it. Where it disagrees with the decode path above, that disagreement is the finding',
    run: ({ envelope }) => {
      if (!envelope) return { outcome: NA, reason: 'no v2 envelope could be recovered from this fixture' };
      return fromSafeParse(coreSchemas.PaymentRequiredV2Schema.safeParse(envelope));
    },
  },
  {
    name: 'core.schemas.PaymentRequiredSchema.safeParse',
    generation: 'v2+v1',
    input: 'the decoded v2 envelope',
    cites: '@x402/core@2.23.0 schemas — PaymentRequiredSchema (the version-dispatching union)',
    why: 'the union a consumer reaches for when it does not already know which generation it holds',
    run: ({ envelope }) => {
      if (!envelope) return { outcome: NA, reason: 'no v2 envelope could be recovered from this fixture' };
      return fromSafeParse(coreSchemas.PaymentRequiredSchema.safeParse(envelope));
    },
  },
  {
    name: 'core.schemas.PaymentRequirementsV2Schema.safeParse[]',
    generation: 'v2',
    input: 'each entry of the decoded envelope’s accepts array',
    cites: '@x402/core@2.23.0 schemas — PaymentRequirementsV2Schema',
    why:
      'per-offer, because an envelope with one good offer and one bad one is a different fact ' +
      'about interoperability than an envelope that fails whole',
    run: ({ envelope }) => {
      if (!envelope) return { outcome: NA, reason: 'no v2 envelope could be recovered from this fixture' };
      if (!Array.isArray(envelope.accepts)) return { outcome: NA, reason: 'the envelope declares no accepts array' };
      const per = envelope.accepts.map((entry, index) => ({ index, ...fromSafeParse(coreSchemas.PaymentRequirementsV2Schema.safeParse(entry)) }));
      const worst = per.some((p) => p.outcome === REJECTED) ? REJECTED : ACCEPTED;
      return { outcome: worst, offers: per };
    },
  },
  // ---------------------------------------------------------------- v1, over the body
  {
    name: 'core.schemas.PaymentRequiredV1Schema.safeParse',
    generation: 'v1',
    input: 'the parsed response body',
    cites: '@x402/core@2.23.0 schemas — PaymentRequiredV1Schema',
    why: 'the v2 package’s own view of a v1 body, which is what a dual-stack server is asking clients to accept',
    run: ({ body }) => {
      if (!body || typeof body !== 'object') return { outcome: NA, reason: 'the fixture records no JSON body' };
      return fromSafeParse(coreSchemas.PaymentRequiredV1Schema.safeParse(body));
    },
  },
  {
    name: 'x402.types.x402ResponseSchema.safeParse',
    generation: 'v1',
    input: 'the parsed response body',
    cites: 'x402@1.2.0 types — x402ResponseSchema',
    why: 'the v1 generation’s own envelope schema',
    run: ({ body }) => {
      if (!body || typeof body !== 'object') return { outcome: NA, reason: 'the fixture records no JSON body' };
      return fromSafeParse(v1Types.x402ResponseSchema.safeParse(body));
    },
  },
  {
    name: 'x402.types.PaymentRequirementsSchema.safeParse[]',
    generation: 'v1',
    input: 'each entry of the body’s accepts array',
    cites: 'x402@1.2.0 types — PaymentRequirementsSchema',
    why:
      'the schema x402-fetch calls with .parse() — the THROWING form — on every offer before it ' +
      'will select one. safeParse is used here only so every offer is reported instead of the first failure',
    run: ({ body }) => {
      if (!body || typeof body !== 'object') return { outcome: NA, reason: 'the fixture records no JSON body' };
      if (!Array.isArray(body.accepts)) return { outcome: NA, reason: 'the body declares no accepts array' };
      const per = body.accepts.map((entry, index) => ({ index, ...fromSafeParse(v1Types.PaymentRequirementsSchema.safeParse(entry)) }));
      const worst = per.some((p) => p.outcome === REJECTED) ? REJECTED : ACCEPTED;
      return { outcome: worst, offers: per };
    },
  },
  {
    name: 'x402.client.selectPaymentRequirements',
    generation: 'v1',
    input: 'the body’s accepts array',
    cites: 'x402@1.2.0 client — selectPaymentRequirements()',
    why:
      'v1 offer selection, which is pure and therefore reachable offline. Which offer a client ' +
      'would have picked is a PARSE-level fact; whether it could pay for it is not',
    run: ({ body }) => {
      if (!body || !Array.isArray(body.accepts) || body.accepts.length === 0) {
        return { outcome: NA, reason: 'the body declares no offers to select from' };
      }
      return attempt(() => {
        const chosen = v1Client.selectPaymentRequirements(body.accepts, undefined, 'exact');
        return chosen ? { scheme: chosen.scheme ?? null, network: chosen.network ?? null, asset: chosen.asset ?? null } : null;
      });
    },
  },
  {
    name: 'x402-fetch.wrapFetchWithPayment (response handling)',
    generation: 'v1',
    input: 'the whole recorded response, served by a stub transport',
    cites: 'x402-fetch@1.2.0 — wrapFetchWithPayment()',
    why:
      'the v1 wrapper’s real 402 handling, run end to end up to the signing boundary. It calls ' +
      'PaymentRequirementsSchema.parse() — throwing, not safeParse — on every offer, so a single ' +
      'bad offer aborts the whole response. Selection is replaced by a recorder that THROWS a ' +
      'sentinel the moment it has chosen, which makes createPaymentHeader unreachable rather ' +
      'than merely unused',
    async: true,
    run: async (inputs, fixture) => {
      const { response } = fixture;
      if (response.status !== 402) {
        return { outcome: NA, reason: `the wrapper passes through any status that is not 402; this fixture records ${response.status}` };
      }
      const stubFetch = async () => new Response(response.body ?? '', { status: response.status, headers: { 'content-type': response.headers?.['content-type'] ?? 'application/json' } });
      let selected = null;
      const selector = (requirements, network, scheme) => {
        selected = v1Client.selectPaymentRequirements(requirements, network, scheme);
        throw new Error(SENTINEL);
      };
      // A plain object is not a signer of any kind, so the wrapper's network
      // inference resolves to undefined and no wallet code runs.
      const wrapped = v1Fetch.wrapFetchWithPayment(stubFetch, {}, BigInt(0.1 * 10 ** 6), selector);
      try {
        await wrapped('https://example.com/api/thing', {});
        return { outcome: THREW, error: 'the sentinel did not fire, which means selection never ran — the probe is wrong, not the package' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === SENTINEL) {
          return {
            outcome: ACCEPTED,
            selected: selected ? { scheme: selected.scheme ?? null, network: selected.network ?? null, asset: selected.asset ?? null } : null,
            beyond_this_point: OFFLINE,
            beyond_this_point_is: 'createPaymentHeader() — signing needs a key and a chain and was made structurally unreachable',
          };
        }
        return fromThrow(error);
      }
    },
  },
];

// EXECUTE-LEVEL PATHS, NAMED AND NOT RUN. Listing them is the honest form of
// "we did not test this": a reader can see exactly which claims in the corpus
// have no observation behind them and never will from an offline probe.
const NOT_EXERCISABLE_OFFLINE = [
  {
    entry_point: 'x402.client.createPaymentHeader / preparePaymentHeader / signPaymentHeader',
    package: 'x402@1.2.0',
    reason: 'builds and signs an EIP-712 authorization; needs a private key. No key exists in this process',
  },
  {
    entry_point: '@x402/evm exact/client, exact/v1/client, upto/client — payload construction and signing',
    package: '@x402/evm@2.23.0',
    reason:
      'the signer. EVERY execute-level client_interop claim in this corpus cites this package, and ' +
      'none of them is observed here: signing needs a key, and settlement needs a chain',
  },
  {
    entry_point: '@x402/fetch wrapFetchWithPayment (past selection)',
    package: '@x402/fetch@2.23.0',
    reason: 'reaches createPaymentPayload, which delegates to a scheme client that signs',
  },
  {
    entry_point: 'x402.verify — verify(), settle(), supported()',
    package: 'x402@1.2.0',
    reason: 'calls a facilitator over the network. This probe makes no request to any x402 endpoint',
  },
  {
    entry_point: '@x402/core/facilitator, @x402/core/server settlement helpers',
    package: '@x402/core@2.23.0',
    reason: 'server and facilitator side; needs a facilitator and a chain',
  },
];

// ------------------------------------------------------------------ run

const results = [];
for (const fixture of corpus.fixtures) {
  const inputs = inputsFor(fixture);
  const probes = {};
  for (const entry of ENTRY_POINTS) {
    probes[entry.name] = entry.async ? await entry.run(inputs, fixture) : entry.run(inputs, fixture);
  }

  // THE DISAGREEMENT, computed per fixture rather than left to a reader to spot.
  const decode = probes['core.http.decodePaymentRequiredHeader'];
  const schema = probes['core.schemas.PaymentRequiredV2Schema.safeParse'];
  let disagreement = null;
  if (decode.outcome === ACCEPTED && schema.outcome === REJECTED) {
    disagreement = {
      kind: 'decoder-accepts-schema-rejects',
      what:
        'every real v2 client decodes this envelope without complaint, and the zod schema the same ' +
        'package exports rejects it. A client_interop claim here must say WHICH it means',
      schema_issues: schema.issues,
    };
  } else if (decode.outcome === REJECTED && schema.outcome === ACCEPTED) {
    disagreement = {
      kind: 'decoder-rejects-schema-accepts',
      what: 'the envelope is well-formed but no client can get to it, because the header will not decode',
      decoder_error: decode.error,
    };
  }

  results.push({
    id: fixture.id,
    inputs: {
      has_payment_required_header: typeof inputs.rawHeader === 'string',
      envelope_source: inputs.envelopeSource,
      decode_path_error: inputs.decodeFailed,
      body_is_json: inputs.body !== null,
      body_parse_error: inputs.bodyParseError,
      body_x402_version: inputs.body && typeof inputs.body === 'object' ? (inputs.body.x402Version ?? null) : null,
    },
    probes,
    disagreement,
  });
}

// ------------------------------------------------------------------ output

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
const stampNow = process.argv.includes('--stamp');
const ran = stampNow ? new Date().toISOString().slice(0, 10) : previous?.ran ?? corpus.generated;

const payload = {
  probe: 'corpus/probe-clients.mjs',
  what:
    'the pinned x402 client packages, installed from the registry and run over every fixture in ' +
    'corpus/fixtures.json. Every outcome in this file was observed, not inferred',
  corpus_version: corpus.corpus_version,
  ran,
  ran_is: 'carried forward unless --stamp is passed, so regenerating without changing an answer changes no bytes',
  install: {
    sandbox: `\${TMPDIR}/x402-client-probe-${PIN_KEY}`,
    lockfile: 'corpus/client-probe.lock.json',
    method: 'first run resolves with `npm install` and records the lockfile; every later run installs it with `npm ci`',
    packages: Object.fromEntries(Object.keys(PINNED).map((name) => [name, { requested: PINNED[name], ...resolvedFromLock(name) }])),
    transitive_note: 'zod resolves transitively and its issue text is recorded verbatim, which is why the lockfile is committed rather than regenerated',
  },
  exports: {
    what: 'every subpath each package’s own exports map declares, imported, with its export names as they actually are',
    packages: exportsByPackage,
  },
  entry_points: ENTRY_POINTS.map((e) => ({ name: e.name, generation: e.generation, input: e.input, cites: e.cites, why: e.why })),
  outcomes: {
    accepted: 'the entry point returned; for a safeParse, success',
    rejected: 'the entry point judged the input invalid — a zod failure or a documented validation throw',
    threw: 'an error that is not one of the package’s documented refusals — a crash, not a declining. Never counted as a rejection',
    'n/a': 'the entry point’s input is absent from this fixture. Silence, not approval',
    'not-exercisable-offline': 'the path needs a key or a chain, and is recorded as a boundary rather than a result',
  },
  not_exercisable_offline: NOT_EXERCISABLE_OFFLINE,
  disagreements: results.filter((r) => r.disagreement).map((r) => ({ id: r.id, ...r.disagreement })),
  results,
};

writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);

const tally = {};
for (const r of results) for (const p of Object.values(r.probes)) tally[p.outcome] = (tally[p.outcome] ?? 0) + 1;
process.stdout.write(
  `corpus/client-probe.json — ${results.length} fixtures x ${ENTRY_POINTS.length} entry points; ` +
    `${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}\n`
);
if (payload.disagreements.length) {
  process.stdout.write(`  DECODER/SCHEMA DISAGREEMENTS (${payload.disagreements.length}): ${payload.disagreements.map((d) => d.id).join(', ')}\n`);
}
