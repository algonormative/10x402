#!/usr/bin/env node
// THE 10x402 ADAPTER: worker/lint.js over corpus/fixtures.json.
//
// An adapter's whole job is to translate one tool's vocabulary into the
// corpus's, and to do it by a RULE rather than by a lookup table someone tuned
// until the numbers agreed. The rule here has three parts and is stated in
// corpus/FORMAT.md § Adapters:
//
//   1. SEVERITY. A dimension FAILS when a finding that speaks to it is an
//      error. A warn or an info is recorded and does not fail anything. Both
//      adapters in this corpus apply the same contract, so a disagreement
//      between them is a disagreement about the envelope rather than about
//      where each tool draws its severity line.
//
//   2. PROVENANCE decides which dimensions a payment-regime finding speaks to.
//      A check citing the specification speaks to `payment`; a check citing
//      client code speaks to `client_interop`; a check citing both speaks to
//      both; a check citing neither (house opinion, a field report, a provider)
//      speaks to `payment`, the strict side. This is the whole reason the
//      catalogue carries `sources` — it is what makes "the spec says so" and
//      "this client does so" separable after the fact.
//
//   3. REGIME. Bazaar-regime findings speak to `discovery`, and the discovery
//      verdict is the engine's own published `summary.bazaar_ready`, not a
//      recount — including its `n/a`, which is what a v1-only endpoint gets
//      because CDP's requirements are a v2 shape that does not apply.
//
// ONE DOCUMENTED OVERRIDE. The DUAL_* family compares a dual-stack seller's two
// envelopes with each other. Neither specification requires them to agree, so
// the checks cite house opinion — and two of the four also cite client code,
// which under rule 2 alone would land them in `client_interop` while their two
// siblings landed in `payment`, splitting one family across two dimensions on
// the strength of a citation rather than a meaning. They are mapped to
// `payment` as a family: the consequence is money at the wrong address or the
// wrong price. The evidence stays labelled `house-opinion` in every fixture
// that carries one, so nobody can mistake it for a protocol requirement.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { lint, CHECKS_BY_ID } from '../worker/lint.js';
import { TENX402_TAGS, TAGS } from './vocabulary.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const DUAL_FAMILY = new Set(['DUAL_PAYTO', 'DUAL_PRICE', 'DUAL_NETWORK', 'DUAL_ASSET', 'DUAL_RESOURCE']);

/** Which dimensions a payment- or hygiene-regime finding speaks to. */
export function dimensionsFor(code) {
  if (DUAL_FAMILY.has(code)) return ['payment'];
  const kinds = new Set((CHECKS_BY_ID.get(code)?.sources ?? []).map((s) => s.kind));
  const dims = [];
  if (kinds.has('spec')) dims.push('payment');
  if (kinds.has('client-code')) dims.push('client_interop');
  if (!dims.length) dims.push('payment');
  return dims;
}

export function tagFor(code) {
  const tag = TENX402_TAGS[code];
  if (!tag) throw new Error(`no corpus tag for check ${code} — add it to corpus/vocabulary.mjs`);
  if (!TAGS.includes(tag)) throw new Error(`check ${code} maps to ${tag}, which is not in the vocabulary`);
  return tag;
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

  for (const finding of report.findings) {
    const regime = CHECKS_BY_ID.get(finding.code)?.regime ?? 'payment';
    const tag = tagFor(finding.code);
    const targets = regime === 'bazaar' ? ['discovery'] : dimensionsFor(finding.code);
    for (const dim of targets) {
      if (!dims[dim].observed_tags.includes(tag)) dims[dim].observed_tags.push(tag);
      if (finding.severity === 'error' && dim !== 'discovery' && !dims[dim].reason_tags.includes(tag)) {
        dims[dim].reason_tags.push(tag);
      }
      if (finding.severity === 'error' && dim === 'discovery' && !dims[dim].reason_tags.includes(tag)) {
        dims[dim].reason_tags.push(tag);
      }
    }
  }

  dims.payment.verdict = dims.payment.reason_tags.length ? 'fail' : 'pass';
  dims.client_interop.verdict = dims.client_interop.reason_tags.length ? 'fail' : 'pass';

  // RULE 3: the engine's own second verdict, verbatim. `n/a` is a real answer —
  // a v1-only endpoint is not "discoverable: false", it is outside the question.
  const ready = report.summary.bazaar_ready;
  dims.discovery.verdict = ready === 'n/a' ? 'n/a' : ready ? 'pass' : 'fail';
  if (dims.discovery.verdict !== 'fail') dims.discovery.reason_tags = [];

  return {
    id: fixture.id,
    dimensions: dims,
    tool_detail: {
      grade: report.grade,
      bazaar_ready: report.summary.bazaar_ready,
      blockers: report.summary.blockers ?? [],
      checks_run: report.checks_run,
      findings: report.findings.map((f) => ({
        code: f.code,
        severity: f.severity,
        core: f.core === true,
        regime: CHECKS_BY_ID.get(f.code)?.regime ?? 'payment',
        tag: tagFor(f.code),
        message: f.message,
      })),
    },
  };
}

export function runCorpus(corpus) {
  return corpus.fixtures.map(runFixture);
}

// ------------------------------------------------------------------ cli

if (import.meta.url === `file://${process.argv[1]}`) {
  const corpus = JSON.parse(readFileSync(join(here, 'fixtures.json'), 'utf8'));
  const results = runCorpus(corpus);
  const out = {
    tool: { name: '10x402', repo: corpus.pins['10x402'].repo, commit: corpus.pins['10x402'].commit },
    corpus_version: corpus.corpus_version,
    ran: new Date().toISOString().slice(0, 10),
    adapter: 'corpus/run-10x402.mjs',
    not_evaluated: [],
    results,
  };
  writeFileSync(join(here, 'results-10x402.json'), `${JSON.stringify(out, null, 2)}\n`);

  let agree = 0;
  const misses = [];
  for (const fixture of corpus.fixtures) {
    const got = results.find((r) => r.id === fixture.id);
    for (const dim of ['payment', 'client_interop', 'discovery']) {
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
