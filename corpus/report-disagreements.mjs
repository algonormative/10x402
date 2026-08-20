#!/usr/bin/env node
// Generates DISAGREEMENTS.md from the two results files.
//
// The tables and every number in them are computed. The prose in ANALYSIS is
// written by hand and keyed by `fixture:dimension`, so the report regenerates
// without the analysis drifting away from the rows it is analysing — and a new
// disagreement that nobody has written about yet is printed with a NEEDS
// ANALYSIS marker rather than passing silently.
//
// NO WINNER IS DECLARED. That is the deliverable the thread asked for, and it
// is a discipline rather than a politeness: two conformance tools disagreeing
// is evidence about the specification's under-determination, and picking a
// winner throws that evidence away. Where one tool is demonstrably wrong about
// its own cited authority the row says so and names the document — including,
// twice, about 10x402.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, 'fixtures.json'), 'utf8'));
const ours = JSON.parse(readFileSync(join(here, 'results-10x402.json'), 'utf8'));
const theirs = JSON.parse(readFileSync(join(here, 'results-x402-doctor.json'), 'utf8'));

const DIMS = ['payment', 'client_interop', 'discovery'];
const A = new Map(ours.results.map((r) => [r.id, r]));
const B = new Map(theirs.results.map((r) => [r.id, r]));

// ------------------------------------------------------------------ analysis

const CLASSES = {
  scope: 'the tools cover different ground by design',
  judgement: 'both read the same bytes and disagree about what they mean',
  coverage: 'one tool has no rule for this fault',
  defect: 'one tool contradicts a document it itself cites',
  transport: 'the fault is not observable over a live HTTP probe at all',
};

const ANALYSIS = {
  'calibration-cloudflare-batch-settlement:payment': {
    class: 'defect',
    text:
      'The prototype requires `maxTimeoutSeconds` to be a positive integer on every offer. This ' +
      'fixture is the batch-settlement scheme’s own published 402, and that scheme’s specification ' +
      'marks the field optional on `cloudflare:402` (`scheme_batch_settlement_cloudflare.md:110`, ' +
      '"optional, see note below"). Neither tool invented a rule: one is applying the core ' +
      'PaymentRequirements table, the other is applying the network’s own scheme profile, and the ' +
      'two documents differ. It is worth recording that 10x402 had the MIRROR of this bug on the ' +
      'same fixture — it applied CDP’s 1000-atomic-unit price floor to an offer denominated in ISO ' +
      '4217 USD on a network CDP does not settle — and that it was this fixture that surfaced it. ' +
      'A checker that generalises one profile’s rule across all of them fails a spec-defined ' +
      'profile, and both tools did it once.',
  },
  'calibration-cloudflare-batch-settlement:client_interop': { sameAs: 'calibration-cloudflare-batch-settlement:payment' },
  'perfect-v1-only:payment': {
    class: 'scope',
    text:
      'The prototype is v2-only by construction: it requires the `PAYMENT-REQUIRED` header and ' +
      'rejects any challenge whose `x402Version` is not 2. A v1-only seller therefore fails both ' +
      'payment rules. 10x402 reads the v1 body, notes that `@x402/core` falls back to it when ' +
      'there is no header, and calls the endpoint payable — while separately answering `n/a` on ' +
      'discovery, because CDP’s indexing requirements are a v2 shape. This is a difference in ' +
      'declared scope, not in reading: the prototype’s issue text scopes it to the v2 flow.',
  },
  'perfect-v1-only:client_interop': { sameAs: 'perfect-v1-only:payment' },
  'v1-network-caip2:payment': {
    class: 'scope',
    text:
      'The v2 half of this response is perfect and the v1 body carries the v2 network spelling. ' +
      'The prototype never reads the body, so it sees nothing wrong; 10x402 reads it against ' +
      '`x402@1.2.0`’s closed enum of bare network names and fails it. Same scope difference as ' +
      'perfect-v1-only, arriving from the other side: a dual-stack seller can be broken in a half ' +
      'a v2-only tool does not look at.',
  },
  'v1-network-caip2:client_interop': { sameAs: 'v1-network-caip2:payment' },
  'v2-header-b64-whitespace:payment': {
    class: 'transport',
    text:
      'THE MOST INSTRUCTIVE ROW IN THE TABLE, and neither tool is wrong. The fixture is a v2 ' +
      'header with a leading and trailing space. HTTP defines optional whitespace around a header ' +
      'value as not part of the value, so it is stripped by the parser before any client sees it — ' +
      'the prototype probes a URL, is handed a clean header, and correctly reports nothing. ' +
      '10x402 lints a RECORDED response, where the padding survives, and fails it because ' +
      '`@x402/core`’s `Base64EncodedRegex` runs against the raw header value before `atob`. The ' +
      'fault is real for anything that hands the header to a client without a transport in ' +
      'between — a facilitator forwarding a stored declaration, an SDK reading from a cache — and ' +
      'it is invisible to any live probe. It is the concrete argument for a corpus of recorded ' +
      'responses alongside a live doctor: the two see different populations of bug.',
  },
  'v2-header-b64-whitespace:client_interop': { sameAs: 'v2-header-b64-whitespace:payment' },
  'extra-eip712-absent:payment': {
    class: 'coverage',
    text:
      'The prototype validates scheme, network, amount, timeout, asset and payee, and does not ' +
      'inspect `extra`. On an EIP-3009 chain the `exact` scheme signs a typed-data domain built ' +
      'from `extra.name` and `extra.version`; `@x402/evm` throws at payment CREATION when either ' +
      'is absent, so no payment is attempted at all. 10x402 fails both payment dimensions on it. ' +
      'This is a gap rather than a disagreement — there is no rule on the other side to disagree ' +
      'with — and it is the failure class the 10x402 catalogue describes as the silent one, ' +
      'because nothing in the seller’s logs mentions it.',
  },
  'extra-eip712-absent:client_interop': { sameAs: 'extra-eip712-absent:payment' },
  'v2-payto-array:payment': {
    class: 'defect',
    text:
      'The fixture’s `payTo` is `["0x…"]` — a one-element ARRAY holding a valid address. The ' +
      'prototype checks it with `EVM_ADDRESS.test(requirement.payTo)`, and `RegExp.prototype.test` ' +
      'coerces its argument with `String()`, which turns a one-element array into the element. ' +
      'The address regex passes and the envelope is reported clean, although both the ' +
      '`@x402/core` zod schema and viem reject a non-string outright, so no client can pay it. ' +
      'This is verifiable in one line: `/^0x[a-fA-F0-9]{40}$/.test(["0x…"]) === true`. It is worth ' +
      'saying that 10x402 shipped the identical hole — `String(entry.payTo || "")` — and closed ' +
      'it in its 2026-08-19 audit, which is why the fixture exists. The trap is the type ' +
      'coercion, not either codebase.',
  },
  'v2-payto-array:client_interop': { sameAs: 'v2-payto-array:payment' },
  'dual-payto-divergence:payment': {
    class: 'scope',
    text:
      'A dual-stack seller whose v1 body and v2 header name different payees. The prototype reads ' +
      'only the v2 header and correctly finds nothing wrong with it. 10x402 compares the two ' +
      'envelopes and fails the payment dimension. THE 10x402 FINDING IS NOT A PROTOCOL ' +
      'REQUIREMENT and the corpus labels it `house-opinion`: neither specification says a ' +
      'dual-stack seller’s two declarations must agree, and each half here is individually valid ' +
      'and individually settleable. What is true is that the seller is being paid at two ' +
      'addresses by two client generations. Whether that belongs in a conformance verdict at all ' +
      'is a live question, which is exactly why the evidence is labelled rather than asserted.',
  },
  'dual-network-unmapped-chain:client_interop': {
    class: 'scope',
    text:
      'A correctly paired dual-stack seller on Arbitrum. The v2 half is conformant; the v1 half ' +
      'spells the network `arbitrum`, which is not a member of the closed enum in `x402@1.2.0`, so ' +
      '`x402-fetch` throws `invalid_enum_value` and cannot pay that entry. The prototype does not ' +
      'read v1 and reports nothing. Note what 10x402 does NOT do here: the payment dimension ' +
      'passes. Nothing in either specification closes that enum — it is a fact about one client ' +
      'at one version, which is the whole reason `client_interop` is a separate dimension.',
  },
  'free-tier-200:payment': {
    class: 'judgement',
    text:
      'THE SHARPEST DISAGREEMENT IN THE CORPUS, and the one closest to the thread’s own concern. ' +
      'The endpoint answers an unauthenticated caller with 200. The prototype reports an error ' +
      'whose text is "The unpaid request returned HTTP 200; Bazaar requires HTTP 402" — a ' +
      'PROVIDER requirement, named as such in the message, deciding a payment-path verdict. ' +
      '10x402 reports a warning and passes the payment dimension, on the reading that there is no ' +
      'challenge here to misinterpret: a free tier is a seller’s choice, and the cost of it is a ' +
      'delisting, which the discovery dimension is for. Both readings have a real cost. Ours lets ' +
      'a response that earns an x402 buyer nothing pass the payment dimension; theirs promotes ' +
      '"Bazaar requires" into a protocol verdict. The corpus records ours as the expectation and ' +
      'flags it as the most arguable expectation it contains.',
  },
  'free-tier-200:client_interop': { sameAs: 'free-tier-200:payment' },
  'redirect-instead-of-402:payment': {
    class: 'judgement',
    text:
      'A 307 where the 402 was advertised. The prototype fetches with `redirect: "manual"`, sees ' +
      'the 307, and errors. 10x402 warns and passes the payment dimension, citing `@x402/fetch` ' +
      'at 2.23.0, which uses ordinary `fetch` and therefore FOLLOWS the redirect — so the envelope ' +
      'is reachable and the real costs are narrower (a 301/302 rewrites POST to GET; a ' +
      'cross-origin hop drops the payment header; the provider probes the advertised URL, not the ' +
      'final one). The disagreement is about whether "unreachable at the advertised URL" is a ' +
      'payment failure or a hazard, and the two tools’ redirect MODES are the reason each reading ' +
      'looks obvious from inside it.',
  },
  'redirect-instead-of-402:client_interop': { sameAs: 'redirect-instead-of-402:payment' },
};

/** Reason-tag differences on rows where the two tools agreed on the verdict. */
const TAG_ANALYSIS = {
  'bazaar-extension-absent': {
    text:
      'Four fixtures with no `extensions.bazaar` reach the same discovery verdict by different ' +
      'routes. The prototype grades the missing extension a WARNING and then errors on ' +
      '`x402.bazaar.crawler_input` — "no reproducible HTTP input example" — so the verdict comes ' +
      'from the consequence rather than the cause. 10x402 names the cause. A seller reading the ' +
      'two reports is told to add an input example, or to add the extension; only the second is ' +
      'the fix.',
    rows: [
      'calibration-spec-canonical-402:discovery',
      'calibration-cloudflare-batch-settlement:discovery',
      'calibration-solana-spec-envelope:discovery',
      'bazaar-extension-absent:discovery',
    ],
  },
  'v2-resource-flat-string': {
    text:
      'Both tools fail both payment dimensions; the diagnoses are not the same fault. The ' +
      'prototype’s `decodeChallenge` requires `challenge.resource?.url` and throws "listed no ' +
      'terms that could be paid" when the resource is the v1 flat string, so the whole challenge ' +
      'is reported as malformed. 10x402 names the shape and quotes the object to replace it with. ' +
      'Same verdict, and one report tells the seller which line to edit.',
    rows: ['v2-resource-flat-string:payment', 'v2-resource-flat-string:client_interop'],
  },
  'v2-amount-uses-v1-field-name': {
    text:
      'A v2 accepts entry carrying `maxAmountRequired`. The prototype reports `accepts[0].amount ' +
      'must be a positive integer string` — true, and it reads as "your price is malformed" when ' +
      'the price is fine and the field name is not. 10x402 reports the rename and quotes the ' +
      'replacement. The dimension verdicts agree exactly.',
    rows: ['v2-amount-uses-v1-field-name:payment', 'v2-amount-uses-v1-field-name:client_interop'],
  },
  'no-envelope-html-body': {
    text:
      'A 402 with an HTML error page and no header. The prototype reports a missing v2 header and ' +
      'then a malformed PAYMENT-REQUIRED — the same absence twice, because `decodeChallenge` does ' +
      'not distinguish "no header" from "undecodable header". 10x402 separates the missing header ' +
      'from the unparseable body.',
    rows: ['no-envelope-html-body:payment', 'no-envelope-html-body:client_interop'],
  },
  'bazaar-schema-detail': {
    text:
      'On `bazaar-schema-external-ref` and `bazaar-input-no-type` both tools fail discovery. ' +
      '10x402 carries a second, more specific tag alongside the shared one — the unresolvable ' +
      '`$ref` (which `bazaar.md` says a facilitator MUST NOT resolve), and the absent `type` ' +
      'discriminator. The prototype reports both as a single extension-schema failure, which is ' +
      'the same verdict with less to act on.',
    rows: ['bazaar-schema-external-ref:discovery', 'bazaar-input-no-type:discovery'],
  },
};

// ------------------------------------------------------------------ compute

const rows = [];
const stats = { total: 0, comparable: 0, agree: 0, disagree: 0, notEvaluated: 0, tagDiff: 0 };

for (const fixture of corpus.fixtures) {
  const a = A.get(fixture.id);
  const b = B.get(fixture.id);
  for (const dim of DIMS) {
    stats.total++;
    const x = a.dimensions[dim];
    const y = b.dimensions[dim];
    const key = `${fixture.id}:${dim}`;
    const show = (v) => (v.verdict === 'fail' ? `fail (${v.reason_tags.join(', ')})` : v.verdict);
    if (x.verdict === 'not-evaluated' || y.verdict === 'not-evaluated') {
      stats.notEvaluated++;
      rows.push({ kind: 'not-evaluated', key, id: fixture.id, dim, ours: show(x), theirs: show(y), reason: y.not_evaluated_reason ?? x.not_evaluated_reason ?? '' });
      continue;
    }
    stats.comparable++;
    if (x.verdict !== y.verdict) {
      stats.disagree++;
      rows.push({ kind: 'disagree', key, id: fixture.id, dim, ours: show(x), theirs: show(y) });
      continue;
    }
    stats.agree++;
    const xt = [...x.reason_tags].sort().join(',');
    const yt = [...y.reason_tags].sort().join(',');
    if (xt !== yt) {
      stats.tagDiff++;
      rows.push({ kind: 'tag-diff', key, id: fixture.id, dim, ours: show(x), theirs: show(y) });
    }
  }
}

const analysisFor = (key) => {
  const entry = ANALYSIS[key];
  if (!entry) return null;
  return entry.sameAs ? { ...ANALYSIS[entry.sameAs], sameAs: entry.sameAs } : entry;
};

const missing = rows.filter((r) => r.kind === 'disagree' && !analysisFor(r.key));

// ------------------------------------------------------------------ render

const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);
const esc = (s) => String(s).replace(/\|/g, '\\|');
const out = [];

out.push('# Disagreements: 10x402 vs the x402-doctor prototype');
out.push('');
out.push(
  'Two independent conformance implementations run over the same portable corpus, reported ' +
    'side by side. **No winner is declared.** Where a tool contradicts a document it itself cites, ' +
    'the row says so and names the document — twice about 10x402, which is the point of running ' +
    'someone else’s implementation over your own fixtures.'
);
out.push('');
out.push('Prepared for [x402-foundation/x402#3104](https://github.com/x402-foundation/x402/issues/3104).');
out.push('');
out.push('## What was run');
out.push('');
out.push('| | |');
out.push('| --- | --- |');
out.push(`| Corpus | \`corpus/fixtures.json\`, corpus_version ${corpus.corpus_version}, ${corpus.fixtures.length} fixtures |`);
out.push(`| 10x402 | ${corpus.pins['10x402'].repo} @ \`${corpus.pins['10x402'].commit.slice(0, 12)}\` — adapter \`corpus/run-10x402.mjs\` |`);
out.push(`| x402-doctor | ${corpus.pins['x402-doctor-prototype'].repo} @ \`${corpus.pins['x402-doctor-prototype'].commit.slice(0, 12)}\` — adapter \`corpus/run-x402-doctor.mjs\` |`);
out.push(`| Client pins | \`@x402/core\` ${corpus.pins['@x402/core'].version}, \`x402\` ${corpus.pins.x402.version} |`);
out.push(`| Spec pin | x402-foundation/x402 @ \`${corpus.pins['x402-foundation/x402'].commit.slice(0, 12)}\` |`);
out.push('');
out.push(
  '**Licence.** The prototype’s repository publishes no licence — no `LICENSE` file, no `license` ' +
    'field in `package.json`, and `license: null` from the GitHub API — so all rights are reserved ' +
    'and **no code from it is vendored into this repository**. `corpus/run-x402-doctor.mjs` clones ' +
    'it to a temporary directory at the pinned commit and imports `diagnoseX402Endpoint()` from ' +
    'there. What is committed here is our mapping and the SHA.'
);
out.push('');
out.push(
  '**No payments, no third-party network.** The adapter passes no `paidProbe`, so a settlement is ' +
    'structurally impossible rather than merely unrequested. Each recorded response is re-served ' +
    'from `127.0.0.1` and the fixture’s own origin is mapped onto it; every other host is refused ' +
    'at the fetch boundary. The only host the prototype attempted was the CDP Bazaar merchant ' +
    'lookup, which was refused — see § Not evaluated.'
);
out.push('');

out.push('## Agreement');
out.push('');
out.push('| | count | of |');
out.push('| --- | ---: | ---: |');
out.push(`| Dimension-verdicts in the corpus | ${stats.total} | ${corpus.fixtures.length} fixtures × 3 dimensions |`);
out.push(`| Comparable (both tools reached a verdict) | ${stats.comparable} | ${pct(stats.comparable, stats.total)} of all |`);
out.push(`| **Agreed** | **${stats.agree}** | **${pct(stats.agree, stats.comparable)} of comparable** |`);
out.push(`| Disagreed | ${stats.disagree} | ${pct(stats.disagree, stats.comparable)} of comparable |`);
out.push(`| Not comparable (one tool did not evaluate) | ${stats.notEvaluated} | ${pct(stats.notEvaluated, stats.total)} of all |`);
out.push(`| Agreed on the verdict, differed on the reason | ${stats.tagDiff} | ${pct(stats.tagDiff, stats.agree)} of agreements |`);
out.push('');
out.push(
  'Both tools pass the calibration fixture — the v2 transport specification’s own canonical 402 — ' +
    'on `payment` and `client_interop`, and both fail it on `discovery`, which is the demonstration ' +
    'the three dimensions were separated for.'
);
out.push('');

out.push('## Disagreements');
out.push('');
out.push('| fixture | dimension | 10x402 | x402-doctor | class |');
out.push('| --- | --- | --- | --- | --- |');
for (const row of rows.filter((r) => r.kind === 'disagree')) {
  const analysis = analysisFor(row.key);
  out.push(`| \`${row.id}\` | ${row.dim} | ${esc(row.ours)} | ${esc(row.theirs)} | ${analysis ? analysis.class : '**NEEDS ANALYSIS**'} |`);
}
out.push('');
for (const [name, meaning] of Object.entries(CLASSES)) out.push(`- **${name}** — ${meaning}`);
out.push('');

out.push('### Each one');
out.push('');
const seen = new Set();
for (const row of rows.filter((r) => r.kind === 'disagree')) {
  const analysis = analysisFor(row.key);
  const anchor = analysis?.sameAs ?? row.key;
  if (seen.has(anchor)) continue;
  seen.add(anchor);
  const fixture = corpus.fixtures.find((f) => f.id === row.id);
  const dims = rows.filter((r) => r.kind === 'disagree' && (analysisFor(r.key)?.sameAs ?? r.key) === anchor).map((r) => r.dim);
  out.push(`#### \`${row.id}\` — ${dims.join(', ')}`);
  out.push('');
  out.push(`*${fixture.title}*`);
  out.push('');
  out.push(`- **10x402**: ${row.ours}`);
  out.push(`- **x402-doctor**: ${row.theirs}`);
  out.push(`- **Class**: ${analysis ? analysis.class : 'NEEDS ANALYSIS'}`);
  out.push('');
  out.push(analysis ? analysis.text : '> This disagreement has no written analysis yet.');
  out.push('');
  out.push('Evidence on the fixture:');
  out.push('');
  for (const e of fixture.evidence) out.push(`- \`${e.kind}\` — ${esc(e.ref)}`);
  out.push('');
}

out.push('## Same verdict, different reason');
out.push('');
out.push(
  'These rows agree on whether the fixture passes and disagree on why. They matter because the ' +
    'reason is what a seller acts on: two tools can both say "not indexable" and send the operator ' +
    'to two different lines of JSON.'
);
out.push('');
out.push('| fixture | dimension | 10x402 | x402-doctor |');
out.push('| --- | --- | --- | --- |');
for (const row of rows.filter((r) => r.kind === 'tag-diff')) {
  out.push(`| \`${row.id}\` | ${row.dim} | ${esc(row.ours)} | ${esc(row.theirs)} |`);
}
out.push('');
for (const entry of Object.values(TAG_ANALYSIS)) {
  out.push(`- ${entry.text}`);
  out.push('');
}

out.push('## Not evaluated');
out.push('');
out.push(
  'A corpus of recorded responses has no registry, so the prototype’s live-versus-indexed digest ' +
    'comparison — the check the proposal exists for — cannot run. Those dimension-verdicts are ' +
    'recorded as `not-evaluated`. **None of them is counted as a pass**, and none is counted in ' +
    'the agreement figures above.'
);
out.push('');
out.push('Rules held back:');
out.push('');
for (const rule of theirs.not_evaluated_rules) out.push(`- \`${rule}\``);
out.push('');
out.push(
  'One more is reported and should not be read as evidence: `x402.bazaar.crawler_status` replays ' +
    'the declared crawler request, and the fixture server answers the replay with the same recorded ' +
    'response, so it is structurally satisfied for every fixture. The results file marks it ' +
    '`structurally-satisfied`. Replaying the declared input against a live endpoint is the one ' +
    'check in the prototype that a recorded corpus fundamentally cannot carry, and the two ' +
    'approaches are complementary for exactly that reason.'
);
out.push('');
out.push(`${stats.notEvaluated} of ${stats.total} dimension-verdicts fell into this category.`);
out.push('');

out.push('## Where 10x402 was wrong');
out.push('');
out.push(
  'Running someone else’s implementation over our own fixtures found two defects in ours. Both ' +
    'are fixed in the commit this report was generated from; both were found by a CALIBRATION ' +
    'fixture rather than by a broken one, which is the argument for keeping known-good documents ' +
    'in a corpus of broken ones.'
);
out.push('');
out.push(
  '1. **A provider’s price floor applied outside the provider’s own domain.** `V2_AMOUNT_MINIMUM` ' +
    'enforced CDP’s 1000-atomic-unit minimum on every offer. On the Cloudflare batch-settlement ' +
    'profile — `network: "cloudflare:402"`, `asset: "USD"`, `amount: "1"`, one cent in ISO 4217 — ' +
    'it reported a spec-defined 402 as too cheap to index, for an index that does not carry that ' +
    'network at all. This is precisely the failure mode the thread named: a provider observation ' +
    'becoming a protocol requirement. The check is now gated on `CDP_FACILITATOR_CHAINS`, and ' +
    '`V2_NETWORK_SUPPORTED` already says the chain is outside CDP’s set.'
);
out.push('');
out.push(
  '2. **"Indexable" reported when nothing had been inspected.** `bazaar_ready` was computed from ' +
    'the ABSENCE of blocking findings. Where the registry checks could not run at all — the v2 ' +
    'header did not decode, or `resource` arrived as the v1 flat string, so there is no ' +
    '`ResourceInfo` object to read — there were no blockers, and the engine answered `true` to a ' +
    'seller whose envelope no indexer can read. It now answers `n/a`, joining the v1-only case ' +
    'under the same rule: not a failure, a question this response cannot answer. Found by ' +
    '`v2-resource-flat-string`.'
);
out.push('');
out.push(
  'A third is not a defect and is recorded as a standing judgement rather than fixed: 10x402 ' +
    'passes the payment dimension on `free-tier-200` and `redirect-instead-of-402` where the ' +
    'prototype fails both. The corpus notes on those fixtures say so, and the reasoning is in ' +
    '§ Disagreements. It is the most arguable pair of expectations the corpus contains, and it is ' +
    'written down rather than smoothed over.'
);
out.push('');

out.push('## Reproducing');
out.push('');
out.push('```sh');
out.push('node corpus/build-fixtures.mjs      # regenerate corpus/fixtures.json');
out.push('node corpus/run-10x402.mjs          # → corpus/results-10x402.json');
out.push('node corpus/run-x402-doctor.mjs     # clones the prototype to a temp dir → corpus/results-x402-doctor.json');
out.push('node corpus/report-disagreements.mjs # → DISAGREEMENTS.md');
out.push('npm test                            # the corpus phase asserts run-10x402 reproduces every expectation');
out.push('```');
out.push('');
out.push(`Generated by \`corpus/report-disagreements.mjs\` from results dated ${ours.ran} and ${theirs.ran}.`);
out.push('');

writeFileSync(join(here, '..', 'DISAGREEMENTS.md'), `${out.join('\n')}`);
process.stdout.write(
  `DISAGREEMENTS.md — ${stats.agree}/${stats.comparable} comparable verdicts agree (${pct(stats.agree, stats.comparable)}), ` +
    `${stats.disagree} disagreements, ${stats.tagDiff} reason-only differences, ${stats.notEvaluated} not evaluated\n`
);
if (missing.length) {
  for (const row of missing) process.stdout.write(`  NEEDS ANALYSIS: ${row.key}\n`);
  process.exitCode = 1;
}
