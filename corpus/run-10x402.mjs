#!/usr/bin/env node
// THE 10x402 ADAPTER: worker/lint.js over corpus/fixtures.json.
//
// An adapter's whole job is to translate one tool's vocabulary into the
// corpus's, and to do it by a RULE rather than by a lookup table someone tuned
// until the numbers agreed. The rules are stated in corpus/FORMAT.md § Adapters
// and are applied identically by both adapters that ship here.
//
//   1. SEVERITY. A dimension FAILS when a finding that speaks to it is an
//      error. A warn or an info is recorded and does not fail anything.
//
//   2. PER-FINDING PROVENANCE. Which dimensions a finding may fail is read off
//      THAT FINDING'S OPERATIVE provenance — `operativeSources()` in
//      worker/lint.js, which drops the citations marked contextual. A spec
//      citation that only locates the reader ("the header carries Base64-encoded
//      JSON", silent on the alphabet) is not authority for a payment verdict,
//      and treating it as authority is how a client-specific fault becomes a
//      normative one. The provenance that decided each finding's dimensions is
//      written into the results file beside it, so the reduction is auditable
//      rather than asserted.
//
//   3. NO AUTHORITY, NO VERDICT. A finding whose operative provenance is only
//      house opinion, a field report or a provider observation fails NOTHING.
//      It is recorded in `observed_tags` on the dimensions it speaks to. This is
//      the corpus's answer to "provider observations should not silently become
//      protocol requirements", and the previous version of this adapter got it
//      backwards: it routed an uncited finding to `payment`, "the strict side",
//      which made every house rule a normative payment failure. The `DUAL_*`
//      family is the case that mattered — five house positions about dual-stack
//      consistency, which no specification governs, deciding the payment
//      dimension. There is no override here any more; the rule decides.
//
//   4. REGISTRY REGIME. Bazaar-regime findings speak to `discovery`, and the
//      discovery verdict is the engine's own published `summary.bazaar_ready`.
//      Under the corpus's narrow reading of the dimension — STATIC DECLARATION
//      ELIGIBILITY, not indexing — that is the right kind of claim to make from
//      a recorded response: it asks whether the declaration is present and meets
//      the named provider's documented requirements as documented. It is not,
//      and does not claim to be, evidence that anything was indexed.
//
//   5. THE RECORDED-CHALLENGE PRECONDITION. Where the fixture records no
//      challenge at all, `payment` and `client_interop` are `n/a` — see
//      `judgeableFrom()` in corpus/vocabulary.mjs. Whatever the engine would
//      have said about those dimensions is preserved in `observed_tags` and
//      listed under `scope_suppressed`, so the opinion is on the record without
//      being counted as a verdict the recording cannot support.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { lint, CHECKS_BY_ID, operativeSources } from '../worker/lint.js';
import { TENX402_TAGS, TAGS, DIMENSIONS, judgeableFrom, dimensionsForProvenance } from './vocabulary.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * THE ENGINE BLOB, ASSERTED BEFORE ANYTHING RUNS.
 *
 * The published pin has to name the code that actually executed. A commit is the
 * wrong handle for that — the repository HEAD moves, and the HEAD at the moment
 * a corpus was cut may not be the HEAD that carries the adapter reading it. The
 * corpus therefore pins CONTENT: the git blob hash of every file whose bytes can
 * change an answer. This function recomputes them from the working tree and
 * refuses to run on a mismatch, so a results file can never claim to be the
 * output of code that is not the code that produced it.
 */
export function assertPinnedBlobs(corpus) {
  const blobs = corpus.pins['10x402']?.blobs;
  if (!blobs) throw new Error('corpus/fixtures.json carries no 10x402 blob pins — regenerate it with corpus/build-fixtures.mjs');
  const wrong = [];
  for (const [path, want] of Object.entries(blobs)) {
    const got = execFileSync('git', ['hash-object', path], { cwd: join(here, '..'), encoding: 'utf8' }).trim();
    if (got !== want) wrong.push(`${path}\n    pinned  ${want}\n    on disk ${got}`);
  }
  if (wrong.length) {
    throw new Error(
      'the engine on disk is not the engine the corpus pins:\n  ' +
        wrong.join('\n  ') +
        '\nRegenerate the corpus (node corpus/build-fixtures.mjs --stamp) if the change is intended.'
    );
  }
  return blobs;
}

export function tagFor(code) {
  const tag = TENX402_TAGS[code];
  if (!tag) throw new Error(`no corpus tag for check ${code} — add it to corpus/vocabulary.mjs`);
  if (!TAGS.includes(tag)) throw new Error(`check ${code} maps to ${tag}, which is not in the vocabulary`);
  return tag;
}

/**
 * Which dimensions this FINDING may fail, and which it merely speaks to.
 * Rule 2 and rule 3, applied to one finding's own operative provenance.
 */
export function dimensionsFor(code) {
  const registry = (CHECKS_BY_ID.get(code)?.regime ?? 'payment') === 'bazaar';
  return dimensionsForProvenance(operativeSources(code), { registry });
}

/** Run the engine over one fixture and reduce its report to the three dimensions. */
export function runFixture(fixture) {
  const report = lint({
    status: fixture.response.status,
    headers: fixture.response.headers,
    body: fixture.response.body,
    url: fixture.context.url ?? undefined,
    method: fixture.context.method ?? undefined,
  });

  const dims = {
    payment: { verdict: 'pass', reason_tags: [], observed_tags: [] },
    client_interop: { verdict: 'pass', reason_tags: [], observed_tags: [] },
    discovery: { verdict: 'pass', reason_tags: [], observed_tags: [] },
  };

  const detail = [];
  for (const finding of report.findings) {
    const tag = tagFor(finding.code);
    // THE BRANCH'S OWN PROVENANCE, not the check id's. worker/lint.js attaches
    // the citations the emitting branch rests on; `operativeSources(code)` is
    // the fallback for a check whose branches all rest on the same documents.
    // The difference is not cosmetic: `V2_PAYTO` firing on a solana:* entry used
    // to publish viem's getAddress and fail client interoperability with no
    // Solana client cited anywhere, and `V2_MAX_TIMEOUT` firing BECAUSE a scheme
    // makes the field optional used to publish the three documents that make it
    // required.
    const provenance = (finding.sources ?? operativeSources(finding.code)).filter((src) => src.context !== true);
    const { fails, speaks } = dimensionsForProvenance(provenance, {
      registry: (CHECKS_BY_ID.get(finding.code)?.regime ?? 'payment') === 'bazaar',
    });
    detail.push({
      code: finding.code,
      severity: finding.severity,
      core: finding.core === true,
      regime: CHECKS_BY_ID.get(finding.code)?.regime ?? 'payment',
      tag,
      // RULE 2, ON THE RECORD. The provenance that decided this finding's
      // dimensions travels with the finding into the published results.
      provenance: provenance.map((s) => ({ kind: s.kind, ref: s.ref })),
      // WHAT IT DECIDED, not what a finding of this kind could decide. An info
      // or a warning decides nothing at all under rule 1, and listing dimensions
      // beside it read as though it had — the Cloudflare optional-timeout note
      // published `decides: [payment, client_interop]` while failing neither.
      decides: finding.severity === 'error' ? fails : [],
      could_decide: fails,
      message: finding.message,
    });
    for (const dim of new Set([...speaks, ...fails])) {
      if (!dims[dim].observed_tags.includes(tag)) dims[dim].observed_tags.push(tag);
    }
    if (finding.severity !== 'error') continue;
    for (const dim of fails) {
      if (!dims[dim].reason_tags.includes(tag)) dims[dim].reason_tags.push(tag);
    }
  }

  dims.payment.verdict = dims.payment.reason_tags.length ? 'fail' : 'pass';
  dims.client_interop.verdict = dims.client_interop.reason_tags.length ? 'fail' : 'pass';

  // RULE 4: the engine's own second verdict, verbatim. `n/a` is a real answer —
  // a v1-only endpoint is not "declaration ineligible", it is outside the question.
  const ready = report.summary.bazaar_ready;
  dims.discovery.verdict = ready === 'n/a' ? 'n/a' : ready ? 'pass' : 'fail';
  if (dims.discovery.verdict !== 'fail') dims.discovery.reason_tags = [];

  // RULE 5: the recorded-challenge precondition, applied last so that what the
  // engine would have said is preserved rather than never computed.
  const judgeable = fixture.judgeable ?? judgeableFrom(fixture.response);
  for (const dim of DIMENSIONS) {
    if (judgeable[dim] !== false) continue;
    if (dims[dim].reason_tags.length) dims[dim].scope_suppressed = [...dims[dim].reason_tags];
    dims[dim].reason_tags = [];
    dims[dim].verdict = 'n/a';
    dims[dim].na_kind = 'scope';
  }

  return {
    id: fixture.id,
    dimensions: dims,
    tool_detail: {
      grade: report.grade,
      bazaar_ready: report.summary.bazaar_ready,
      blockers: report.summary.blockers ?? [],
      checks_run: report.checks_run,
      findings: detail,
    },
  };
}

export function runCorpus(corpus) {
  return corpus.fixtures.map(runFixture);
}

// ------------------------------------------------------------------ cli

if (import.meta.url === `file://${process.argv[1]}`) {
  const corpus = JSON.parse(readFileSync(join(here, 'fixtures.json'), 'utf8'));
  const blobs = assertPinnedBlobs(corpus);
  const results = runCorpus(corpus);
  const out = {
    tool: {
      name: '10x402',
      repo: corpus.pins['10x402'].repo,
      commit: corpus.pins['10x402'].commit,
      // What actually ran, content-addressed. `commit` is where the tree was;
      // these are what the bytes were.
      blobs,
    },
    corpus_version: corpus.corpus_version,
    ran: corpus.generated,
    adapter: 'corpus/run-10x402.mjs',
    partial_evaluation: {
      // See FORMAT.md § Partial evaluation. 10x402 runs every rule it has on
      // every fixture: nothing is held back, so nothing is `not-evaluated`.
      rules_held_back: [],
      note: 'the engine is a pure function over a recorded response; every check in the catalogue is applied to every fixture',
    },
    results,
  };
  writeFileSync(join(here, 'results-10x402.json'), `${JSON.stringify(out, null, 2)}\n`);

  let agree = 0;
  const misses = [];
  for (const fixture of corpus.fixtures) {
    const got = results.find((r) => r.id === fixture.id);
    for (const dim of DIMENSIONS) {
      const want = fixture.expected[dim];
      const have = got.dimensions[dim];
      const sameVerdict = want.verdict === have.verdict;
      const sameTags =
        want.verdict !== 'fail' ||
        (want.reason_tags.length === have.reason_tags.length &&
          want.reason_tags.every((t) => have.reason_tags.includes(t)));
      if (sameVerdict && sameTags) agree++;
      else misses.push(`${fixture.id}.${dim}: expected ${want.verdict}[${want.reason_tags}] got ${have.verdict}[${have.reason_tags}]`);
    }
  }
  const total = corpus.fixtures.length * 3;
  process.stdout.write(`corpus/results-10x402.json — ${results.length} fixtures, ${agree}/${total} dimension-verdicts match the corpus\n`);
  for (const miss of misses) process.stdout.write(`  MISMATCH ${miss}\n`);
  process.exitCode = misses.length ? 1 : 0;
}
