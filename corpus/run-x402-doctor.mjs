#!/usr/bin/env node
// THE x402-doctor ADAPTER: the prototype from x402-foundation/x402#3104, run
// over corpus/fixtures.json.
//
// ─── LICENCE, AND WHY NOTHING FROM IT IS IN THIS REPOSITORY ────────────────
//
// github.com/Maha-Strategies/maha-corp-web publishes NO LICENCE. There is no
// LICENSE file, `package.json` declares no `license`, and the GitHub API
// reports `license: null` — the repository is public and all rights are
// reserved. So not one line of it is vendored, copied, adapted or quoted here.
// This file CLONES it to a temporary directory outside the repository at a
// pinned commit and IMPORTS `diagnoseX402Endpoint()` from that clone. What is
// committed to 10x402 is the mapping below, which is our own work, plus the
// commit SHA. Nothing else of theirs travels.
//
// ─── HOW THE PROTOTYPE IS INVOKED ─────────────────────────────────────────
//
// `scripts/x402-doctor.ts` is a CLI that takes a live https URL. It also
// imports `viem` and can make a payment behind `--pay`. This adapter therefore
// does NOT use the CLI: it calls the library entry point `diagnoseX402Endpoint`
// directly and passes no `paidProbe`, which makes a payment structurally
// impossible rather than merely unrequested. There is no wallet, no key and no
// `--pay` in this file.
//
// The library refuses a non-https endpoint and probes it over the network, so
// the corpus is served to it from a LOCAL http server and a `fetchImpl` maps
// the fixture's own origin onto that server. The doctor is told
// `https://example.com/api/thing`, which is what the fixture declares; the
// bytes come from 127.0.0.1. Two consequences are recorded rather than papered
// over:
//
//   * IT IS A REAL HTTP ROUND TRIP, so the transport normalises what a
//     transport normalises. The whitespace-padded-base64 fixture is the case
//     that matters: HTTP strips optional whitespace around a header value, so
//     the doctor is handed a clean header and cannot see the fault at all. That
//     is reported as a disagreement with a transport-level explanation, not as
//     the doctor being wrong.
//   * ANY FETCH TO A HOST THAT IS NOT THE FIXTURE'S OWN IS REFUSED. The only
//     one the doctor attempts is the CDP Bazaar merchant lookup, which is the
//     registry half of its battery. Those rules are recorded as NOT-EVALUATED
//     in the results file. They are never counted as passes.
//
// ─── WHAT CANNOT BE EVALUATED OFFLINE ─────────────────────────────────────
//
// Listed in DOCTOR_NOT_EVALUABLE_OFFLINE. The live-versus-indexed digest
// comparison — the prototype's headline check — needs a registry, and a corpus
// of recorded responses has none. `x402.bazaar.crawler_status` runs but is
// structurally uninformative here: the fixture server answers every request on
// the endpoint with the same recorded response, so the replayed crawler request
// gets the same 402 the first probe did. It is reported, and the results file
// marks it `structurally-satisfied` so nobody reads it as evidence.

import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

import { DOCTOR_TAGS, DOCTOR_NOT_EVALUABLE_OFFLINE, TAGS, DIMENSIONS, judgeableFrom } from './vocabulary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, 'fixtures.json'), 'utf8'));
const PIN = corpus.pins['x402-doctor-prototype'];

// ------------------------------------------------------------------ the clone

const ROOT = join(tmpdir(), `x402-doctor-${PIN.commit.slice(0, 12)}`);
const CLONE = join(ROOT, 'prototype');
const DEPS = join(ROOT, 'deps');
const EXTENSIONS_VERSION = '2.23.0';

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

function prepareClone() {
  if (existsSync(join(CLONE, 'lib/x402/doctor.ts')) && existsSync(join(DEPS, 'node_modules/@x402/extensions'))) {
    return;
  }
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(DEPS, { recursive: true });
  process.stderr.write(`cloning ${PIN.repo} @ ${PIN.commit.slice(0, 12)} into ${CLONE}\n`);
  run('git', ['clone', '--filter=blob:none', '--no-checkout', PIN.repo, CLONE], ROOT);
  run('git', ['checkout', PIN.commit], CLONE);

  // The prototype's own package.json pulls a whole Next.js application. The
  // diagnostic library needs exactly one third-party package, so that is the
  // only one installed, into a directory of our own that is then linked in.
  writeFileSync(join(DEPS, 'package.json'), JSON.stringify({ name: 'x402-doctor-deps', private: true, type: 'module' }));
  process.stderr.write(`installing @x402/extensions@${EXTENSIONS_VERSION}\n`);
  run('npm', ['install', '--no-audit', '--no-fund', `@x402/extensions@${EXTENSIONS_VERSION}`], DEPS);
  const link = join(CLONE, 'node_modules');
  if (!existsSync(link)) symlinkSync(join(DEPS, 'node_modules'), link, 'dir');
}

// ------------------------------------------------------------------ the fixture server

/**
 * Serves whatever `current` holds, byte for byte, to any path and any method.
 *
 * Any path: the doctor probes the endpoint and then REPLAYS the declared
 * crawler request, which may carry query parameters. Both are the same recorded
 * response, because a recorded response is all a corpus has. Recorded in the
 * results as `structurally-satisfied` so the crawler-status rule is not read as
 * evidence about the fixture.
 */
async function withFixtureServer(fn) {
  const state = { current: null, requests: [] };
  const server = createServer((req, res) => {
    state.requests.push({ method: req.method, url: req.url });
    req.resume();
    req.on('end', () => {
      const { status, headers, body } = state.current;
      const out = { ...headers };
      // Content-Length is recomputed: the recorded response is being re-served
      // and a stale length from the capture would truncate or hang the read.
      delete out['content-length'];
      delete out['transfer-encoding'];
      try {
        res.writeHead(status, out);
      } catch {
        res.writeHead(status);
      }
      res.end(body ?? '');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(state, server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * A fetch that answers only the fixture's own origin, from 127.0.0.1.
 *
 * Everything else — in practice only the CDP Bazaar merchant lookup — is
 * refused. NO third-party network traffic leaves this process.
 */
function localOnlyFetch(origin, port, blocked) {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin !== origin) {
      blocked.push(url.origin + url.pathname);
      throw new Error(`corpus adapter: refused a request to ${url.origin} — the corpus runs offline`);
    }
    const local = new URL(url.pathname + url.search, `http://127.0.0.1:${port}`);
    return fetch(local, init);
  };
}

// ------------------------------------------------------------------ the mapping
//
// Rule for rule, the same severity contract the 10x402 adapter applies: an
// ERROR fails the dimension it speaks to; a warning or a note is recorded and
// fails nothing. Applying one contract to both tools is what makes a
// disagreement a disagreement about the envelope rather than about where each
// project happens to draw its severity line.
//
// WHICH DIMENSION each rule speaks to is read off the rule's own subject, not
// off our regimes: a rule about the payment terms speaks to `payment`, a rule
// about what the client can parse speaks to `client_interop`, a rule about the
// Bazaar declaration speaks to `discovery`. Where the prototype's placement
// differs from ours, the difference is preserved rather than harmonised — that
// is the finding, and DISAGREEMENTS.md reports it.

// A MIXED RULE keeps every scope its own text states. `x402.http.challenge_status`
// emits "The unpaid request returned HTTP 200; Bazaar requires HTTP 402", which is
// two observations in one sentence: a TRANSPORT one (the response is not a 402)
// and a NAMED-PROVIDER one (Bazaar's documented requirement). Mapping it to
// payment/client_interop alone discarded the provider scope the prototype itself
// stated, and manufactured payment-dimension disagreements out of a policy
// citation. The format's rule, stated in FORMAT.md § Mixed-scope rules: a finding
// whose own text names more than one scope maps to EVERY dimension it speaks to,
// and the per-dimension preconditions then decide what it may fail there.
const MIXED_SCOPE = {
  'x402.http.challenge_status': {
    dimensions: ['payment', 'client_interop', 'discovery'],
    why: 'the prototype’s own message states a transport observation and a named-provider policy in one sentence',
    discovery_tag: 'status-not-402',
  },
};

const RULE_DIMENSIONS = {
  // transport / envelope readability: a client cannot get to the terms at all.
  // challenge_status is the one MIXED-SCOPE rule; see the table above.
  'x402.http.challenge_status': MIXED_SCOPE['x402.http.challenge_status'].dimensions,
  'x402.headers.v2': ['payment', 'client_interop'],
  'x402.header.payment_required': ['payment', 'client_interop'],
  'x402.version': ['payment', 'client_interop'],
  'x402.network': ['payment'],
  // payment terms, as the specification states them
  'x402.requirement.network': ['payment', 'client_interop'],
  'x402.requirement.amount': ['payment', 'client_interop'],
  'x402.requirement.timeout': ['payment', 'client_interop'],
  'x402.requirement.asset': ['payment', 'client_interop'],
  'x402.requirement.payee': ['payment', 'client_interop'],
  'x402.requirement.scheme': ['client_interop'],
  'x402.resource.url': ['payment', 'client_interop'],
  'x402.declaration_integrity.malformed': ['payment'],
  'x402.declaration_integrity.self_mismatch': ['payment'],
  'x402.declaration_integrity.resource': ['payment'],
  // legacy header names are an observation about the response, not the terms
  'x402.headers.legacy': ['client_interop'],
  // discovery
  'x402.resource.description': ['discovery'],
  'x402.resource.mime_type': ['discovery'],
  'x402.bazaar.missing': ['discovery'],
  'x402.bazaar.schema': ['discovery'],
  'x402.bazaar.examples': ['discovery'],
  'x402.bazaar.crawler_input': ['discovery'],
  'x402.bazaar.crawler_status': ['discovery'],
  'x402.extensions.responses': ['discovery'],
};

/**
 * The PAYMENT-REQUIRED failure carries its cause in `detail`, and the causes
 * are different faults. Splitting them is the difference between agreeing with
 * 10x402 about a fixture and merely producing the same verdict.
 *
 * THE ORDER MATTERS AND IT WAS WRONG. `b64-undecodable` used to be the
 * fall-through, so a report about a header that WAS NOT THERE came out as a
 * header that would not decode. On `perfect-v1-only` and `no-envelope-html-body`
 * the prototype's own detail says there was no header at all, and the adapter
 * added a Base64 diagnosis on top of it — distorting the prototype's
 * observation, and flattering 10x402's by comparison. Absent input is
 * `envelope-absent`; `b64-undecodable` requires an actual header to have failed
 * to decode.
 */
function paymentRequiredTag(finding, rawHeader) {
  const detail = String(finding.detail ?? '');
  if (/listed no terms/i.test(detail)) return 'wrong-version-field';
  // THE INPUT DECIDES, NOT THE WORDING. The prototype's message for this rule is
  // the single string "PAYMENT-REQUIRED is missing or malformed", which cannot
  // tell the two apart — so the adapter looks at what was actually sent. No
  // header, or an empty one, is an ABSENT envelope; a header has to be present
  // before "it would not decode" is a thing that can be said about it.
  if (typeof rawHeader !== 'string' || rawHeader.trim() === '') return 'envelope-absent';
  if (/[-_]/.test(rawHeader.trim())) return 'b64-urlsafe';
  return 'b64-undecodable';
}

function mapReport(report, fixture) {
  const dims = {
    payment: { verdict: 'pass', reason_tags: [], observed_tags: [] },
    client_interop: { verdict: 'pass', reason_tags: [], observed_tags: [] },
    discovery: { verdict: 'pass', reason_tags: [], observed_tags: [] },
  };
  const notEvaluated = [];
  const unmapped = [];
  const rawHeader = fixture.response.headers['payment-required'];

  for (const finding of report.findings) {
    if (DOCTOR_NOT_EVALUABLE_OFFLINE.has(finding.ruleId)) {
      notEvaluated.push({ rule: finding.ruleId, level: finding.level, message: finding.message, status: 'reported-by-tool' });
      continue;
    }
    const targets = RULE_DIMENSIONS[finding.ruleId];
    let tag = DOCTOR_TAGS[finding.ruleId];
    if (finding.ruleId === 'x402.header.payment_required') tag = paymentRequiredTag(finding, rawHeader);
    if (!targets || !tag) {
      unmapped.push({ rule: finding.ruleId, level: finding.level, message: finding.message });
      continue;
    }
    if (!TAGS.includes(tag)) throw new Error(`doctor rule ${finding.ruleId} maps to ${tag}, not in the vocabulary`);
    const mixed = MIXED_SCOPE[finding.ruleId];
    for (const dim of targets) {
      // A mixed-scope rule may carry a different tag on its provider half, so
      // that "the response is not a 402" and "Bazaar requires 402" are the same
      // observation reported in the two dimensions it is an observation about.
      const dimTag = mixed && dim === 'discovery' ? (mixed.discovery_tag ?? tag) : tag;
      if (!dims[dim].observed_tags.includes(dimTag)) dims[dim].observed_tags.push(dimTag);
      if (finding.level === 'error' && !dims[dim].reason_tags.includes(dimTag)) dims[dim].reason_tags.push(dimTag);
    }
  }

  for (const dim of Object.keys(dims)) {
    dims[dim].verdict = dims[dim].reason_tags.length ? 'fail' : 'pass';
  }

  // THE REGISTRY HALF OF THE DISCOVERY DIMENSION DID NOT RUN. Where the doctor
  // found no discovery error of its own, `pass` would be claiming an answer it
  // could not reach — the live-versus-indexed comparison is the check it exists
  // for, and this corpus has no registry to compare against. Say so.
  if (dims.discovery.verdict === 'pass') {
    dims.discovery.verdict = 'not-evaluated';
    dims.discovery.not_evaluated_reason =
      'the extension checks passed, but the live-versus-indexed comparison — the rule this tool ' +
      'exists for — needs a registry the offline corpus cannot provide';
  }

  // THE RECORDED-CHALLENGE PRECONDITION, applied to this tool exactly as
  // corpus/run-10x402.mjs applies it to ours. Where the fixture records no
  // challenge, neither tool may report a payment or client-interoperability
  // verdict — but what each WOULD have said is kept, in `observed_tags` and in
  // `scope_suppressed`, and reported in DISAGREEMENTS.md. Suppressing the
  // verdict is not the same as discarding the opinion, and the prototype's
  // reading of a free tier is the sharpest thing in the comparison.
  const judgeable = fixture.judgeable ?? judgeableFrom(fixture.response);
  for (const dim of DIMENSIONS) {
    if (judgeable[dim] !== false) continue;
    if (dims[dim].reason_tags.length) dims[dim].scope_suppressed = [...dims[dim].reason_tags];
    dims[dim].reason_tags = [];
    dims[dim].verdict = 'n/a';
    dims[dim].na_kind = 'scope';
  }

  // PER-FIXTURE SKIP EVIDENCE, COMPLETE. Previously a rule was recorded on a
  // fixture only if the prototype happened to mention it in that fixture's
  // findings, so nine of the ten offline-unevaluable rules existed only in a
  // top-level list and no reader could tell, per fixture, what had run. Every
  // held-back rule is now listed on every fixture with its status.
  const reported = new Set(notEvaluated.map((n) => n.rule));
  for (const rule of DOCTOR_NOT_EVALUABLE_OFFLINE) {
    if (!reported.has(rule)) notEvaluated.push({ rule, level: null, message: null, status: 'held-back' });
  }

  return { dims, notEvaluated, unmapped };
}

// ------------------------------------------------------------------ run

prepareClone();
const doctor = await import(pathToFileURL(join(CLONE, 'lib/x402/doctor.ts')).href);

const results = await withFixtureServer(async (state, port) => {
  const out = [];
  for (const fixture of corpus.fixtures) {
    state.current = fixture.response;
    state.requests.length = 0;
    const blocked = [];
    const endpoint = fixture.context.url ?? 'https://example.com/api/thing';
    const origin = new URL(endpoint).origin;

    let report = null;
    let harnessError = null;
    try {
      report = await doctor.diagnoseX402Endpoint({
        endpoint,
        request: { method: fixture.context.method ?? 'GET', headers: {} },
        timeoutMs: 5000,
        fetchImpl: localOnlyFetch(origin, port, blocked),
        // NO paidProbe. A payment is structurally impossible, not merely unasked for.
      });
    } catch (error) {
      // The doctor refuses a non-https endpoint outright, which is a real
      // verdict about the fixture and not a harness failure. Recorded as such.
      harnessError = error instanceof Error ? error.message : String(error);
    }

    if (!report) {
      out.push({
        id: fixture.id,
        dimensions: {
          payment: { verdict: 'not-evaluated', reason_tags: [], not_evaluated_reason: harnessError },
          client_interop: { verdict: 'not-evaluated', reason_tags: [], not_evaluated_reason: harnessError },
          discovery: { verdict: 'not-evaluated', reason_tags: [], not_evaluated_reason: harnessError },
        },
        tool_detail: { refused: harnessError, requests: state.requests.length },
      });
      continue;
    }

    const { dims, notEvaluated, unmapped } = mapReport(report, fixture);
    out.push({
      id: fixture.id,
      dimensions: dims,
      tool_detail: {
        ok: report.ok,
        summary: report.summary,
        live: report.live ?? null,
        findings: report.findings.map((f) => ({ rule: f.ruleId, level: f.level, message: f.message, detail: f.detail ?? null })),
        not_evaluated: notEvaluated,
        unmapped,
        blocked_hosts: [...new Set(blocked)],
        crawler_replay:
          report.live?.crawlerStatus === undefined
            ? 'not run'
            : 'structurally-satisfied — the fixture server answers the replay with the same recorded response',
        local_requests: state.requests.length,
      },
    });
  }
  return out;
});

const payload = {
  tool: {
    name: 'x402-doctor (prototype)',
    repo: PIN.repo,
    commit: PIN.commit,
    license: PIN.license,
    vendored: false,
    entry: 'lib/x402/doctor.ts → diagnoseX402Endpoint()',
    dependency: `@x402/extensions@${EXTENSIONS_VERSION}`,
  },
  corpus_version: corpus.corpus_version,
  // The corpus's own stamp rather than today's date, so that regenerating this
  // file without changing an answer changes no bytes. See FORMAT.md § Determinism.
  ran: corpus.generated,
  adapter: 'corpus/run-x402-doctor.mjs',
  partial_evaluation: {
    rules_held_back: [...DOCTOR_NOT_EVALUABLE_OFFLINE],
    per_fixture: 'every result carries the complete held-back list under tool_detail.not_evaluated, each marked `reported-by-tool` or `held-back`',
    unsupported_versions: 'the prototype is v2-only by construction; it reports v1-only challenges as failures rather than declining them, and the corpus records that as a scope difference rather than harmonising it',
    note: 'a dimension whose rules all ran is a verdict; a dimension whose deciding rule was held back is `not-evaluated`, never a pass',
  },
  harness: {
    transport: 'the recorded response is re-served from 127.0.0.1 and the fixture’s own origin is mapped onto it',
    payments: 'no paidProbe is passed; a settlement is structurally impossible',
    network: 'the git clone and one npm install; every other host is refused at the fetch boundary',
  },
  results,
};

writeFileSync(join(here, 'results-x402-doctor.json'), `${JSON.stringify(payload, null, 2)}\n`);

const counts = { pass: 0, fail: 0, 'n/a': 0, 'not-evaluated': 0 };
for (const r of results) for (const d of Object.values(r.dimensions)) counts[d.verdict] = (counts[d.verdict] ?? 0) + 1;
process.stdout.write(
  `corpus/results-x402-doctor.json — ${results.length} fixtures; ` +
    `${counts.pass} pass, ${counts.fail} fail, ${counts['not-evaluated']} not-evaluated\n`
);
const allUnmapped = new Set(results.flatMap((r) => (r.tool_detail.unmapped ?? []).map((u) => u.rule)));
if (allUnmapped.size) process.stdout.write(`  UNMAPPED RULES: ${[...allUnmapped].join(', ')}\n`);
