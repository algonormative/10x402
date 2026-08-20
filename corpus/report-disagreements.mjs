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
// six times, about 10x402: twice about the engine, found by running someone
// else's implementation over our own fixtures, and four times about the corpus
// itself, found by a pre-publication review of it (CORPUS-REVIEW.md).

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
  placement:
    'both tools see the same fault and their adapters file it under different dimensions. ' +
    'This is a disagreement about WHERE a finding belongs, not about whether it is real, and ' +
    'it is reported separately because conflating the two makes an adapter choice look like ' +
    'two implementations reaching opposite conclusions',
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
  'v2-header-b64-urlsafe:payment': {
    class: 'placement',
    text:
      'BOTH TOOLS REFUSE THE ENVELOPE AND THEY FILE THE REFUSAL DIFFERENTLY. The header is ' +
      'base64url, `@x402/core` tests `Base64EncodedRegex` against the raw value and throws before ' +
      '`atob`, and neither implementation disputes any of that — the two `client_interop` verdicts ' +
      'agree, with the same reason tag. What differs is the payment dimension. 10x402 passes it, ' +
      'because the v2 transport specification says the header carries "Base64-encoded" JSON and is ' +
      'SILENT on the alphabet: there is no normative text that base64url violates, so the fault is ' +
      'a client-interoperability fault and nothing else. The prototype has one verdict per finding ' +
      'and no dimension to separate them into, so the adapter that maps it necessarily reports the ' +
      'refusal in both. It is worth being blunt that an earlier version of THIS corpus made the ' +
      'same conflation from the other end — it failed the payment dimension here on the strength ' +
      'of a spec citation that does not say what it was being made to say, and the pre-publication ' +
      'review caught it.',
  },
  'v2-header-b64-whitespace:client_interop': {
    class: 'transport',
    text:
      'THE MOST INSTRUCTIVE ROW IN THE TABLE, and neither tool is wrong. The fixture is a v2 ' +
      'header with a leading and trailing space. HTTP defines optional whitespace around a header ' +
      'value as not part of the value, so it is stripped by the parser before any client sees it — ' +
      'the prototype probes a URL, is handed a clean header, and correctly reports nothing. ' +
      '10x402 lints a RECORDED response, where the padding survives, and fails CLIENT ' +
      'INTEROPERABILITY because `@x402/core`’s `Base64EncodedRegex` runs against the raw header ' +
      'value before `atob`. ' +
      'Note what the corpus does NOT do here any more: it makes no payment claim at all. This ' +
      'corpus defines `response.headers` as PARSED FIELD VALUES, so a padded value is one that ' +
      'reached the client by a path with no HTTP parser in it — a facilitator replaying a stored ' +
      'declaration, an SDK reading a cache, a pasted capture. The fixture is labelled ' +
      '`population: "raw-input"` and scoped to exactly that population. An earlier version failed ' +
      'the payment dimension on it, which put a client-specific raw-input opinion inside a ' +
      'normative dimension. The two tools see different populations of bug, and that remains the ' +
      'concrete argument for a corpus of recorded responses alongside a live doctor.',
  },
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
  'free-tier-200:discovery': {
    class: 'judgement',
    text:
      'THE SHARPEST DISAGREEMENT IN THE CORPUS, and it now sits in the dimension it was always ' +
      'about. The endpoint answers an unauthenticated caller with 200. The prototype reports an ' +
      'error whose text is "The unpaid request returned HTTP 200; Bazaar requires HTTP 402" — one ' +
      'sentence carrying a transport observation and a NAMED-PROVIDER policy, and the corpus now ' +
      'maps that mixed-scope rule to both, rather than to payment and client interoperability ' +
      'alone. The prototype therefore says the declaration is ineligible at the provider it names, ' +
      'and it has a documented requirement to point at. 10x402 answers `n/a`, on the reading that ' +
      'under the corpus’s static-declaration definition there is no v2 registry declaration in ' +
      'this response to judge for eligibility at all: the question is not "does this fail the ' +
      'provider’s rules", it is "is there a declaration here". Both readings are defensible and ' +
      'the difference is real. ' +
      'What is NOT here any more is the pair of payment/client-interoperability rows this fixture ' +
      'used to generate. Those were an artefact of two things: the adapter filing a provider ' +
      'policy under the payment dimension, and the corpus expecting a `pass` where no challenge ' +
      'was recorded at all. Both are fixed, and the four rows are reported under § Scope-excluded ' +
      'with what each tool would have said.',
  },
  'redirect-instead-of-402:discovery': {
    class: 'judgement',
    text:
      'A 307 where the 402 was advertised, and the same mixed-scope rule as `free-tier-200`. The ' +
      'prototype fetches with `redirect: "manual"`, sees the 307, and reports that the advertised ' +
      'URL does not answer 402 — which for the named provider is exactly right, because the ' +
      'provider probes the advertised URL and not the final one. 10x402 answers `n/a`: this ' +
      'response carries no v2 declaration, so under the static-declaration reading there is ' +
      'nothing to judge for eligibility. ' +
      'Neither tool can say what is at the other end of the redirect, and the corpus no longer ' +
      'pretends otherwise — the target response is not in the recording, so payment and client ' +
      'interoperability are `n/a` for both. The right fix for that is to record the target ' +
      'response as a second exchange, not to infer a verdict from a Location header, and it is ' +
      'noted on the fixture as the concrete next thing this corpus should carry.',
  },
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
const stats = { total: 0, comparable: 0, agree: 0, disagree: 0, notEvaluated: 0, scopeExcluded: 0, tagDiff: 0 };

for (const fixture of corpus.fixtures) {
  const a = A.get(fixture.id);
  const b = B.get(fixture.id);
  for (const dim of DIMS) {
    stats.total++;
    const x = a.dimensions[dim];
    const y = b.dimensions[dim];
    const key = `${fixture.id}:${dim}`;
    const show = (v) => (v.verdict === 'fail' ? `fail (${v.reason_tags.join(', ')})` : v.verdict);
    // WHAT THE TOOL WOULD HAVE SAID, at the strength it would have said it. A
    // suppressed FAILURE and a suppressed warning are different things, and
    // rendering the second as "nothing to report" would hide the fact that
    // 10x402 does have an opinion about a free tier — it just holds it at a
    // severity that never decides a dimension.
    const wouldHave = (v) => {
      if (v.scope_suppressed?.length) return `fail (${v.scope_suppressed.join(', ')})`;
      if (v.observed_tags?.length) return `observed only: ${v.observed_tags.join(', ')}`;
      return 'nothing to report';
    };
    // SCOPE-EXCLUDED FIRST. The corpus itself declares that this recording
    // cannot support a verdict on this dimension, so both tools were forced to
    // `n/a` and counting that as an agreement would be counting two non-answers
    // as a meeting of minds. Excluded from the comparison and reported with what
    // each tool would have said, so the opinion survives the exclusion.
    if (fixture.judgeable?.[dim] === false) {
      stats.scopeExcluded++;
      rows.push({
        kind: 'scope-excluded',
        key,
        id: fixture.id,
        dim,
        ours: wouldHave(x),
        theirs: wouldHave(y),
        reason: fixture.expected[dim].na_kind === 'scope' ? 'no challenge is recorded in this fixture' : '',
      });
      continue;
    }
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
    'the row says so and names the document — six times about 10x402, which is the point of running ' +
    'someone else’s implementation over your own fixtures and then having the corpus itself ' +
    'reviewed. See § Where 10x402 was wrong.'
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
out.push(
  `| Package pins | ${Object.entries(corpus.pins.packages)
    .map(([name, p]) => `\`${name}\` ${p.version}`)
    .join(', ')} — each with its registry integrity hash |`
);
out.push(`| Spec pin | x402-foundation/x402 @ \`${corpus.pins['x402-foundation/x402'].commit.slice(0, 12)}\` |`);
out.push('');
out.push(
  '**The engine is pinned by content, not by commit.** The commit above says where the tree was ' +
    'when the corpus was last stamped; it is marked informational in `pins`, and it is ALWAYS behind ' +
    'this file — writing the file is itself a change to be committed, and it falls further behind ' +
    'with every commit made after a stamp, so no fixed lag is claimed. The AUTHORITY is the git blob ' +
    'hash of every file whose bytes can change an answer — ' +
    Object.keys(corpus.pins['10x402'].blobs)
      .map((p) => `\`${p}\``)
      .join(', ') +
    ' — and `assertPinnedBlobs()` recomputes them and refuses to run on a mismatch, before the ' +
    'engine executes. A published result therefore cannot claim to be the output of code that is ' +
    'not the code that produced it.'
);
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
out.push(`| Scope-excluded (the corpus cannot judge this from this recording) | ${stats.scopeExcluded} | ${pct(stats.scopeExcluded, stats.total)} of all |`);
out.push(`| Not comparable (one tool did not evaluate) | ${stats.notEvaluated} | ${pct(stats.notEvaluated, stats.total)} of all |`);
out.push(`| Comparable (both tools reached a verdict) | ${stats.comparable} | ${pct(stats.comparable, stats.total)} of all |`);
out.push(`| **Agreed** | **${stats.agree}** | **${pct(stats.agree, stats.comparable)} of comparable** |`);
out.push(`| Disagreed | ${stats.disagree} | ${pct(stats.disagree, stats.comparable)} of comparable |`);
out.push(`| Agreed on the verdict, differed on the reason | ${stats.tagDiff} | ${pct(stats.tagDiff, stats.agree)} of agreements |`);
out.push('');
out.push(
  '**Three exclusions, and they are different things.** `not-evaluated` means a TOOL did not run ' +
    'the rules that would answer the question — for the prototype that is the live-versus-indexed ' +
    'comparison, which needs a registry an offline corpus does not have. `scope-excluded` means the ' +
    'CORPUS cannot support an answer from this recording, whichever tool is asked: a response with ' +
    'no challenge in it declares no payment, and a recorded corpus cannot demonstrate payability it ' +
    'never recorded. Neither is counted as an agreement, and neither is counted as a pass. What each ' +
    'tool would have said on the scope-excluded rows is reported in full under § Scope-excluded.'
);
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

out.push('## Scope-excluded');
out.push('');
out.push(
  'A dimension the CORPUS cannot judge from the recording it holds. Both tools are held to `n/a` ' +
    'here, so these rows are excluded from the agreement figures rather than counted as agreements — ' +
    'two implementations forced to the same non-answer have not agreed about anything. **The opinion ' +
    'is not discarded with the verdict**: whatever each tool would have reported is kept in its ' +
    'results file under `scope_suppressed` and printed below.'
);
out.push('');
out.push('| fixture | dimension | 10x402 would say | x402-doctor would say | why excluded |');
out.push('| --- | --- | --- | --- | --- |');
for (const row of rows.filter((r) => r.kind === 'scope-excluded')) {
  out.push(`| \`${row.id}\` | ${row.dim} | ${esc(row.ours)} | ${esc(row.theirs)} | ${esc(row.reason)} |`);
}
out.push('');
out.push(
  'Both fixtures are cases where the response contains no payment declaration at all: a 200 to an ' +
    'anonymous caller, and a 307 whose target response was never captured. The mechanical rule is ' +
    'published with the corpus — `judgeableFrom()` in `corpus/vocabulary.mjs`, and the `judgeable` ' +
    'block on every fixture — so a third adapter reaches the same set from the file rather than ' +
    'from a convention. The right way to make the redirect case judgeable is to record the target ' +
    'response as a second exchange; inferring payability from a Location header is not the same ' +
    'thing and the corpus no longer does it.'
);
out.push('');

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
// READ FROM THE CONTRACT, NOT FROM THIS TOOL'S OWN SPELLING. An earlier version
// read a top-level `not_evaluated_rules` key that only the doctor adapter
// happened to write, so a third implementation following the published schema
// would have had its held-back rules render as an empty list — a report quietly
// claiming a tool ran everything. `partial_evaluation.rules_held_back` is the
// field corpus/schema/results.schema.json defines.
for (const rule of theirs.partial_evaluation?.rules_held_back ?? []) out.push(`- \`${rule}\``);
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
out.push('');
out.push(
  'A pre-publication accuracy review of the corpus itself (`CORPUS-REVIEW.md`) found four more, ' +
    'and all four were the same fault wearing different clothes — a 10x402 position deciding a ' +
    'dimension the corpus defines as belonging to somebody else’s document:'
);
out.push('');
out.push(
  '3. **A house rule as a normative payment failure.** `dual-payto-divergence` expected ' +
    '`payment: fail` while its own evidence said, in capitals, that no specification requires a ' +
    'dual-stack seller’s two envelopes to agree. The same non-normative reason was added to ' +
    '`v2-payto-array`’s otherwise legitimate failure. Both are gone: the adapter rule is now that a ' +
    'finding with no operative `spec` or `client-code` citation FAILS NOTHING and is recorded as an ' +
    'observation, and the `DUAL_*` override that forced the family into `payment` regardless has ' +
    'been deleted. The house position survives in the results file, where an unsourced rule belongs.'
);
out.push('');
out.push(
  '4. **A contextual spec citation counted as authority.** The adapter read "this check cites the ' +
    'specification somewhere" as "this check may fail the payment dimension", so the base64url ' +
    'family failed `payment` on the strength of a transport-spec line that says the header is ' +
    '"Base64-encoded" and is SILENT on the alphabet — a fact 10x402’s own provenance audit records ' +
    'in as many words. Citations are now marked operative or contextual in the check catalogue, the ' +
    'provenance that decided each finding’s dimensions is written into the results file beside it, ' +
    'and both base64 fixtures pass `payment` and fail `client_interop`.'
);
out.push('');
out.push(
  '5. **A pass where nothing had been recorded.** `free-tier-200` and `redirect-instead-of-402` ' +
    'expected `payment: pass` and `client_interop: pass`. The first contains no payment declaration; ' +
    'the second contains a 307 and a Location, and not the response at the other end of it. Those ' +
    'passes reproduced 10x402’s warning severities as fixture truth. Both dimensions are now `n/a` ' +
    'on both fixtures and excluded from the statistics — see § Scope-excluded.'
);
out.push('');
out.push(
  '6. **A discovery verdict with no named provider.** Eighteen non-`n/a` discovery expectations ' +
    'carried no provider evidence at all, while the dimension’s own question named a provider. The ' +
    'dimension is now defined narrowly as STATIC DECLARATION ELIGIBILITY, every non-`n/a` discovery ' +
    'verdict carries a structured `discovery_target` naming the provider and the documented ' +
    'requirement it turns on, and the builder refuses to emit one that does not. Indexed, listed and ' +
    'crawled outcomes are reserved for a live adapter and are out of scope here — including on the ' +
    'live positive control, whose `index.active: true` capture is recorded and explicitly is not the ' +
    'basis of its verdict.'
);
out.push('');

out.push('## Reproducing');
out.push('');
out.push('```sh');
out.push('node corpus/build-fixtures.mjs       # regenerate corpus/fixtures.json — BYTE-IDENTICAL unless a fixture changed');
out.push('node corpus/run-10x402.mjs           # → corpus/results-10x402.json (asserts the pinned engine blobs first)');
out.push('node corpus/run-x402-doctor.mjs      # clones the prototype to a temp dir → corpus/results-x402-doctor.json');
out.push('node corpus/report-disagreements.mjs # → DISAGREEMENTS.md');
out.push('node corpus/validate-results.mjs corpus/results-10x402.json   # the third-adapter conformance test');
out.push('npm test                             # the corpus phase asserts run-10x402 reproduces every expectation');
out.push('```');
out.push('');
out.push(
  'A third implementation joins by writing an adapter, emitting a results file in the shape ' +
    '`corpus/schema/results.schema.json` defines, and running `corpus/validate-results.mjs` against ' +
    'it. That script is the conformance test: it checks the file against the schema, that every ' +
    'fixture is answered, that reason tags are drawn from the vocabulary and are fatal ones, that ' +
    '`n/a` and `not-evaluated` are used the way the format defines them, and that the scope rules ' +
    'were applied. It needs nothing from this repository’s engine and imports no worker code.'
);
out.push('');
out.push(`Generated by \`corpus/report-disagreements.mjs\` from results dated ${ours.ran} and ${theirs.ran}.`);
out.push('');

writeFileSync(join(here, '..', 'DISAGREEMENTS.md'), `${out.join('\n')}`);
process.stdout.write(
  `DISAGREEMENTS.md — ${stats.agree}/${stats.comparable} comparable verdicts agree (${pct(stats.agree, stats.comparable)}), ` +
    `${stats.disagree} disagreements, ${stats.tagDiff} reason-only differences, ` +
    `${stats.notEvaluated} not evaluated, ${stats.scopeExcluded} scope-excluded\n`
);
if (missing.length) {
  for (const row of missing) process.stdout.write(`  NEEDS ANALYSIS: ${row.key}\n`);
  process.exitCode = 1;
}
