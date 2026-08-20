#!/usr/bin/env node
// THE CONFORMANCE TEST A THIRD IMPLEMENTATION RUNS AGAINST ITS OWN RESULTS FILE.
//
//   node corpus/validate-results.mjs <results.json> [--corpus corpus/fixtures.json]
//   node corpus/validate-results.mjs <a.json> <b.json>   # and their agreement
//
// It imports corpus/vocabulary.mjs and worker/json-schema.js AND NOTHING ELSE.
// That restriction is the point of the file rather than an incidental tidiness:
// a conformance test that reached into worker/lint.js would be checking whether
// a third tool agrees with this repository's engine, which is a different claim
// from whether its results file is well-formed, and the moment the two are
// conflated the corpus stops being portable and becomes a compliance test for
// one implementation. Nothing here knows what a check id is, what a severity is,
// or how any tool reaches a verdict. It knows the FORMAT.
//
// WHY THE CHECKS ARE SPLIT BETWEEN A SCHEMA AND THIS FILE. corpus/schema/*.json
// are written against the subset of JSON Schema that worker/json-schema.js
// implements — see the long comment at the top of that file for why this repo
// carries its own validator rather than ajv. That subset has no if/then/else and
// no dependentRequired, so every rule that binds one field to another survives
// only as a programmatic check here. Encoding them as anyOf branches was tried
// and rejected: the subset reports a failed anyOf as "matches none of the 2
// alternatives", so a tool author who put an observational tag in `reason_tags`
// would be told that their dimension object is wrong in some unspecified way.
// A conformance test whose findings cannot be acted on is a worse artefact than
// no conformance test, so the cross-field rules are checked in JavaScript and
// each one reports the fixture, the dimension and the rule it broke.
//
// Enforced here and not in the schema, in full:
//
//   - the schema files' tag enums still match corpus/vocabulary.mjs
//   - the corpus's own `reason_tags` table still matches it too
//   - fixture ids are unique
//   - a `fail` carries at least one reason; a `pass`, `n/a` or `not-evaluated`
//     carries none
//   - every reason tag is FATAL, not merely in the vocabulary
//   - an expectation that is `n/a` says which kind of `n/a`
//   - a non-`n/a` discovery verdict names its provider
//   - the corpus's `judgeable` block agrees with judgeableFrom(response)
//   - the scope rule, in both directions, on both the corpus and the results
//   - every fixture is answered exactly once and no unknown id appears
//   - `corpus_version` matches
//   - every `not-evaluated` row is accounted for INDIVIDUALLY — by its own
//     reason, or by its own fixture's held-back record naming a rule that would
//     have decided that dimension; the file-wide list excuses nothing
//   - every rule the file declares held back is held back on some fixture, and
//     no fixture holds back a rule the file did not declare
//   - a dimension whose deciding rule was held back is not reported as a pass

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { validateAgainstSchema } from '../worker/json-schema.js';
import { REASON_TAGS, TAGS, DIMENSIONS, NOT_EVALUATED, judgeableFrom } from './vocabulary.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const FIXTURES_SCHEMA = join(here, 'schema', 'fixtures.schema.json');
const RESULTS_SCHEMA = join(here, 'schema', 'results.schema.json');
const DEFAULT_CORPUS = join(here, 'fixtures.json');

const FATAL_TAGS = TAGS.filter((tag) => REASON_TAGS[tag].fatal);

/** Read and parse, reporting the path rather than letting a SyntaxError name a byte offset nobody can find. */
function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
}

/** Set equality by content, for comparing a published tag list against the module's. */
function setDifference(a, b) {
  const other = new Set(b);
  return a.filter((x) => !other.has(x));
}

// ------------------------------------------------------------------ drift

/**
 * THE VOCABULARY EXISTS TWICE AND MUST NOT DIVERGE.
 *
 * corpus/vocabulary.mjs is the definition; the two schema files each carry a
 * copy of the tag list as an `enum`, because a JSON Schema cannot import from a
 * JavaScript module and a third implementation that only ever reads the schema
 * still needs to know what the tags are. A copy that goes stale is the worst of
 * both worlds — the schema would keep accepting a tag the corpus has retired, or
 * reject one it has added, and would do it silently, which is precisely the
 * failure mode this whole repository was built to catch elsewhere. So the copies
 * are checked against the original on every run, before anything else happens.
 */
function checkSchemaDrift(fixturesSchema, resultsSchema) {
  const problems = [];
  const compare = (label, published, want) => {
    if (!Array.isArray(published)) {
      problems.push(`${label}: expected an enum of tags and found none`);
      return;
    }
    const extra = setDifference(published, want);
    const missing = setDifference(want, published);
    for (const tag of extra) problems.push(`${label} lists "${tag}", which corpus/vocabulary.mjs does not`);
    for (const tag of missing) problems.push(`${label} omits "${tag}", which corpus/vocabulary.mjs defines`);
  };
  compare('corpus/schema/fixtures.schema.json $defs.reason_tag', fixturesSchema.$defs?.reason_tag?.enum, TAGS);
  compare('corpus/schema/fixtures.schema.json $defs.fatal_reason_tag', fixturesSchema.$defs?.fatal_reason_tag?.enum, FATAL_TAGS);
  compare('corpus/schema/results.schema.json $defs.reason_tag', resultsSchema.$defs?.reason_tag?.enum, TAGS);
  return problems;
}

// ------------------------------------------------------------------ corpus

/**
 * The corpus is checked before the results are checked against it.
 *
 * A results file is judged against the corpus's `judgeable` block, so a corpus
 * that lies about its own scope would silently redefine what a conforming
 * results file looks like — and a third implementation running this script would
 * be told its perfectly correct file is wrong. The `judgeable` block is
 * therefore not read as authority but RECOMPUTED from the recorded response by
 * judgeableFrom(), which is the same mechanical rule every adapter applies.
 */
function validateCorpus(corpus, schema, path) {
  const problems = validateAgainstSchema(corpus, schema).map((p) => `${path}: ${p}`);

  const publishedTags = Object.keys(corpus.reason_tags ?? {});
  for (const tag of setDifference(publishedTags, TAGS)) {
    problems.push(`${path}: reason_tags publishes "${tag}", which corpus/vocabulary.mjs does not define`);
  }
  for (const tag of setDifference(TAGS, publishedTags)) {
    problems.push(`${path}: reason_tags omits "${tag}", which corpus/vocabulary.mjs defines`);
  }

  const seen = new Set();
  for (const fixture of corpus.fixtures ?? []) {
    const id = fixture?.id;
    if (typeof id !== 'string') continue; // the schema has already said so
    if (seen.has(id)) problems.push(`${path}: duplicate fixture id ${id} — a results file answers by id, so two fixtures sharing one cannot both be answered`);
    seen.add(id);

    // The mechanical scope rule, recomputed rather than trusted.
    const computed = judgeableFrom(fixture.response ?? {});
    for (const dim of DIMENSIONS) {
      if (fixture.judgeable?.[dim] !== computed[dim]) {
        problems.push(
          `${path}: ${id}.${dim}: the fixture declares judgeable ${JSON.stringify(fixture.judgeable?.[dim])} ` +
            `but judgeableFrom(response) says ${JSON.stringify(computed[dim])} — the block is computed from the ` +
            'recorded response and is not a place to record an opinion'
        );
      }
    }

    for (const dim of DIMENSIONS) {
      const expected = fixture.expected?.[dim];
      if (!expected) continue; // schema territory
      problems.push(...verdictShape(expected, `${path}: ${id}.${dim} (expectation)`));

      if (expected.verdict === 'n/a' && expected.na_kind === undefined) {
        problems.push(`${path}: ${id}.${dim}: an expectation of n/a must say which kind — the two mean different things and only one is excluded from the statistics`);
      }
      problems.push(...scopeShape(expected, computed[dim], `${path}: ${id}.${dim} (expectation)`));
    }

    // A discovery verdict that is not `n/a` is a claim about a NAMED provider's
    // documented requirements. One made without naming the provider is the
    // defect the corpus review found eighteen times, and it is worth catching in
    // a portable checker rather than only in this repository's builder.
    if (fixture.expected?.discovery?.verdict !== undefined && fixture.expected.discovery.verdict !== 'n/a') {
      if (!fixture.discovery_target?.provider) {
        problems.push(`${path}: ${id}: a discovery verdict of ${fixture.expected.discovery.verdict} with no discovery_target naming the provider it is about`);
      }
    }
  }
  return problems;
}

// ------------------------------------------------------------------ shared rules

/**
 * The rules that bind a verdict to its reasons, applied identically to an
 * expectation in the corpus and to an answer in a results file. They are the
 * same rules because the two files are making the same kind of statement, and a
 * checker that was stricter about one than the other would let a tool publish
 * something the corpus itself could not.
 */
function verdictShape(entry, where) {
  const problems = [];
  const tags = entry.reason_tags ?? [];

  if (entry.verdict === 'fail' && tags.length === 0) {
    problems.push(`${where}: fail with no reason_tags — a failure that does not say why is not actionable, and is the one thing a seller cannot fix`);
  }
  if (entry.verdict !== 'fail' && tags.length > 0) {
    problems.push(`${where}: ${entry.verdict} carrying reason_tags [${tags.join(', ')}] — only a fail carries reasons; anything a tool merely noticed belongs in observed_tags`);
  }
  for (const tag of tags) {
    if (!TAGS.includes(tag)) {
      problems.push(`${where}: reason tag "${tag}" is not in the vocabulary`);
    } else if (!REASON_TAGS[tag].fatal) {
      problems.push(
        `${where}: reason tag "${tag}" is OBSERVATIONAL and cannot decide a dimension — ` +
          'it may appear in observed_tags, where it is on the record and decides nothing'
      );
    }
  }
  return problems;
}

/**
 * THE SCOPE RULE, both directions.
 *
 * Where the corpus records no challenge at all, the recording cannot support a
 * verdict on payment or client interoperability, and both `pass` and `fail` are
 * dishonest answers. Such a dimension must be `n/a` with `na_kind: "scope"`, and
 * a dimension the recording CAN support must not claim to be scope-excluded —
 * the second direction matters as much as the first, because a tool that marked
 * an inconvenient row scope-excluded would remove it from the agreement
 * statistics without anybody noticing.
 */
function scopeShape(entry, judgeable, where) {
  const problems = [];
  if (judgeable === false && !(entry.verdict === 'n/a' && entry.na_kind === 'scope')) {
    problems.push(
      `${where}: the corpus records no challenge on this dimension, so it must be n/a with na_kind "scope" — ` +
        `this says ${entry.verdict}${entry.na_kind ? ` / ${entry.na_kind}` : ''}`
    );
  }
  if (judgeable !== false && entry.na_kind === 'scope') {
    problems.push(`${where}: claims na_kind "scope" on a dimension the recording supports — scope exclusion removes a row from the agreement statistics and is not available as a way of declining a question`);
  }
  return problems;
}

// ------------------------------------------------------------------ partial evaluation

/**
 * PARTIAL EVALUATION IS ACCOUNTED FOR PER FIXTURE AND PER DIMENSION, OR IT IS
 * NOT ACCOUNTED FOR AT ALL.
 *
 * The version of this check that shipped with corpus v2 reduced the file-wide
 * `partial_evaluation.rules_held_back` to a BOOLEAN — a file that declared any
 * held-back rule at all was thereafter allowed to leave every `not-evaluated`
 * row unexplained. An external re-review demonstrated what that buys: it
 * replaced the list with the single invented string `fictional.rule`, turned
 * every judgeable answer in a results file into a reasonless `not-evaluated`,
 * and the validator returned OK. A results file that answers nothing and
 * explains nothing was conforming, which makes the whole file-wide declaration
 * decorative.
 *
 * The rule is therefore three-way, and each direction closes a different hole:
 *
 *   1. UPWARD, per dimension. An unanswered dimension must point at something —
 *      its own `not_evaluated_reason`, or a rule this fixture says was held back
 *      AND that names this dimension among the ones it would have decided. A
 *      list attached to the run cannot explain a question, because it does not
 *      know which question it is being asked about.
 *   2. DOWNWARD, per rule. Everything the file declares held back must actually
 *      be held back on some fixture. `fictional.rule` is caught here: it is
 *      declared, it accounts for nothing, and nothing accounts for it.
 *   3. SIDEWAYS, per fixture. A fixture may not hold back a rule the run never
 *      declared. The file-wide list and the per-fixture records are one
 *      declaration seen from two ends, and a rule that appears at only one end
 *      is a bookkeeping error in whichever direction it points.
 *
 * Note what is NOT required: a per-fixture block at all. A tool that ran
 * everything it has declares an empty list and carries no records, and both
 * shipped adapters are honest under this rule — 10x402 holds nothing back
 * anywhere, and the x402-doctor adapter carries the complete ten-rule list on
 * every one of its thirty-four answers.
 */
function heldBackIndex(results) {
  const declared = new Set(
    (Array.isArray(results.partial_evaluation?.rules_held_back) ? results.partial_evaluation.rules_held_back : []).filter(
      (rule) => typeof rule === 'string'
    )
  );
  // Per fixture id, per dimension, the declared rules that stand behind an
  // unanswered question there. Undeclared rules are deliberately excluded from
  // the excuse — they are reported separately, and a rule the run never
  // admitted to holding back should not be able to silence a row.
  const byFixture = new Map();
  const accounted = new Set();
  const problems = [];

  for (const entry of results.results ?? []) {
    const id = typeof entry?.id === 'string' ? entry.id : null;
    const excuses = { payment: [], client_interop: [], discovery: [] };
    for (const record of entry?.partial_evaluation?.rules_held_back ?? []) {
      const rule = record?.rule;
      if (typeof rule !== 'string' || rule === '') continue; // the schema has already said so
      accounted.add(rule);
      if (!declared.has(rule)) {
        problems.push(
          `${id ?? 'a result'}: holds back "${rule}", which the file-wide partial_evaluation.rules_held_back does not ` +
            'declare — the run-level list and the per-fixture records are one declaration, and a rule that appears at ' +
            'only one end is unreviewable'
        );
        continue;
      }
      for (const dim of record?.dimensions ?? []) {
        if (excuses[dim]) excuses[dim].push(rule);
      }
    }
    if (id) byFixture.set(id, excuses);
  }

  for (const rule of declared) {
    if (!accounted.has(rule)) {
      problems.push(
        `partial_evaluation.rules_held_back declares "${rule}", and no fixture's own partial_evaluation records it — ` +
          'a rule held back on nothing held nothing back, and a run-level list that no result corroborates is exactly ' +
          'what a fabricated one looks like'
      );
    }
  }

  return { byFixture, problems, empty: { payment: [], client_interop: [], discovery: [] } };
}

// ------------------------------------------------------------------ results

function validateResults(results, corpus, schema, path) {
  const problems = validateAgainstSchema(results, schema).map((p) => `${path}: ${p}`);

  if (results.corpus_version !== corpus.corpus_version) {
    problems.push(
      `${path}: corpus_version ${JSON.stringify(results.corpus_version)} but the corpus is ` +
        `${JSON.stringify(corpus.corpus_version)} — the tag list and the dimension contract are versioned with the ` +
        'fixtures, so these are answers to a different set of questions and comparing them would be comparing nothing'
    );
  }

  const heldBack = heldBackIndex(results);
  problems.push(...heldBack.problems.map((p) => `${path}: ${p}`));

  const answers = new Map();
  for (const entry of results.results ?? []) {
    const id = entry?.id;
    if (typeof id !== 'string') continue;
    if (answers.has(id)) problems.push(`${path}: fixture ${id} is answered more than once`);
    answers.set(id, entry);
  }

  const fixtures = new Map((corpus.fixtures ?? []).filter((f) => typeof f?.id === 'string').map((f) => [f.id, f]));
  for (const id of fixtures.keys()) {
    if (!answers.has(id)) problems.push(`${path}: fixture ${id} is in the corpus and is not answered — a corpus run is all of it or none of it, since choosing which fixtures to answer is choosing the score`);
  }
  for (const id of answers.keys()) {
    if (!fixtures.has(id)) problems.push(`${path}: answers a fixture "${id}" that is not in the corpus`);
  }

  for (const [id, fixture] of fixtures) {
    const entry = answers.get(id);
    if (!entry) continue;
    const judgeable = judgeableFrom(fixture.response ?? {});
    for (const dim of DIMENSIONS) {
      const answer = entry.dimensions?.[dim];
      if (!answer) continue; // the schema has already reported the missing key
      const where = `${path}: ${id}.${dim}`;
      problems.push(...verdictShape(answer, where));
      problems.push(...scopeShape(answer, judgeable[dim], where));

      // THE PER-DIMENSION HALF of the partial-evaluation contract. `excuses` is
      // the list of rules THIS fixture says were held back AND that name THIS
      // dimension among the ones they would have decided; the file-wide
      // declaration is deliberately not consulted here, because it cannot know
      // which question it is being offered in place of.
      const excuses = (heldBack.byFixture.get(id) ?? heldBack.empty)[dim];

      if (answer.verdict === NOT_EVALUATED && !answer.not_evaluated_reason && excuses.length === 0) {
        problems.push(
          `${where}: not-evaluated with no not_evaluated_reason, and nothing in this fixture's ` +
            'partial_evaluation.rules_held_back names a held-back rule that would have decided this dimension — a ' +
            'not-evaluated must be accounted for where it happened or it reads as a quiet pass'
        );
      }

      // The other side of the same declaration, and it is the sentence FORMAT.md
      // § Partial evaluation already published: a dimension whose deciding rule
      // was held back is `not-evaluated`, NEVER A PASS. A `fail` is allowed to
      // sit on top of a held-back subrule — a tool that found one fatal fault
      // and could not check for a second should say both — and an `n/a` is the
      // corpus's own exclusion rather than the tool's answer.
      if (answer.verdict === 'pass' && excuses.length > 0) {
        problems.push(
          `${where}: pass, while this fixture declares [${excuses.join(', ')}] held back on this dimension — a rule ` +
            'that did not run cannot have found nothing wrong, so the honest answer is not-evaluated'
        );
      }

      for (const [field, tags] of [['observed_tags', answer.observed_tags], ['scope_suppressed', answer.scope_suppressed]]) {
        for (const tag of tags ?? []) {
          if (!TAGS.includes(tag)) problems.push(`${where}: ${field} carries "${tag}", which is not in the vocabulary`);
        }
      }
    }
  }
  return problems;
}

// ------------------------------------------------------------------ agreement

/**
 * THE AGREEMENT STATISTICS, and they are computed by the same algorithm as
 * corpus/report-disagreements.mjs — deliberately duplicated rather than
 * imported, because that file writes DISAGREEMENTS.md and carries the hand-
 * written analysis prose with it, and this script must import nothing but the
 * vocabulary and the schema validator. The ordering below is the substance and
 * not an implementation detail:
 *
 *   1. SCOPE-EXCLUDED ROWS COME OUT FIRST and are not counted anywhere else.
 *      The corpus itself declares that the recording cannot support a verdict,
 *      so both tools were forced to the same non-answer, and counting that as an
 *      agreement would be counting two silences as a meeting of minds.
 *   2. `not-evaluated` on EITHER side removes the row next. One tool declining
 *      to run a rule is not evidence about the other tool's answer.
 *   3. What remains is comparable, and agreement is verdict equality.
 *   4. Among agreements, reason-tag SET equality is reported separately. Two
 *      tools can both say "not indexable" and send the operator to two different
 *      lines of JSON, and that difference is worth a number of its own.
 */
function agreement(corpus, a, b) {
  const A = new Map((a.results ?? []).map((r) => [r.id, r]));
  const B = new Map((b.results ?? []).map((r) => [r.id, r]));
  const stats = { total: 0, scopeExcluded: 0, notEvaluated: 0, comparable: 0, agree: 0, disagree: 0, tagDiff: 0 };
  const disagreements = [];

  for (const fixture of corpus.fixtures ?? []) {
    const x0 = A.get(fixture.id);
    const y0 = B.get(fixture.id);
    if (!x0 || !y0) continue; // already reported as an unanswered fixture
    for (const dim of DIMENSIONS) {
      stats.total++;
      const x = x0.dimensions?.[dim] ?? {};
      const y = y0.dimensions?.[dim] ?? {};
      if (fixture.judgeable?.[dim] === false) {
        stats.scopeExcluded++;
        continue;
      }
      if (x.verdict === NOT_EVALUATED || y.verdict === NOT_EVALUATED) {
        stats.notEvaluated++;
        continue;
      }
      stats.comparable++;
      if (x.verdict !== y.verdict) {
        stats.disagree++;
        disagreements.push({ id: fixture.id, dim, a: show(x), b: show(y) });
        continue;
      }
      stats.agree++;
      const xt = [...(x.reason_tags ?? [])].sort().join(',');
      const yt = [...(y.reason_tags ?? [])].sort().join(',');
      if (xt !== yt) stats.tagDiff++;
    }
  }
  return { stats, disagreements };
}

const show = (v) => (v.verdict === 'fail' ? `fail (${(v.reason_tags ?? []).join(', ')})` : v.verdict ?? 'absent');

// ------------------------------------------------------------------ cli

function parseArgs(argv) {
  const files = [];
  let corpusPath = DEFAULT_CORPUS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--corpus') {
      corpusPath = argv[++i];
      if (!corpusPath) throw new Error('--corpus needs a path');
    } else if (arg.startsWith('--corpus=')) {
      corpusPath = arg.slice('--corpus='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0 || files.length > 2) {
    throw new Error(
      'usage: node corpus/validate-results.mjs <results.json> [<results-b.json>] [--corpus corpus/fixtures.json]\n' +
        '       one file validates it; two also report the agreement between them'
    );
  }
  return { files: files.map((f) => resolve(f)), corpusPath: resolve(corpusPath) };
}

function main(argv) {
  const { files, corpusPath } = parseArgs(argv);
  const fixturesSchema = readJson(FIXTURES_SCHEMA);
  const resultsSchema = readJson(RESULTS_SCHEMA);
  const corpus = readJson(corpusPath);

  const findings = [
    ...checkSchemaDrift(fixturesSchema, resultsSchema),
    ...validateCorpus(corpus, fixturesSchema, corpusPath),
  ];

  const loaded = files.map((path) => ({ path, doc: readJson(path) }));
  for (const { path, doc } of loaded) {
    findings.push(...validateResults(doc, corpus, resultsSchema, path));
  }

  const out = process.stdout;
  out.write(`corpus  ${corpusPath}\n`);
  out.write(`        corpus_version ${corpus.corpus_version}, ${corpus.fixtures?.length ?? 0} fixtures\n`);
  for (const { path, doc } of loaded) {
    out.write(`results ${path}\n`);
    out.write(`        ${doc.tool?.name ?? 'unnamed tool'} via ${doc.adapter ?? 'an unnamed adapter'}, ${doc.results?.length ?? 0} answers\n`);
  }

  if (loaded.length === 2) {
    const { stats, disagreements } = agreement(corpus, loaded[0].doc, loaded[1].doc);
    const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);
    out.write('\nAgreement\n');
    out.write(`  dimension-verdicts in the corpus            ${stats.total}\n`);
    out.write(`  scope-excluded (the corpus cannot judge)    ${stats.scopeExcluded}\n`);
    out.write(`  not comparable (one tool did not evaluate)  ${stats.notEvaluated}\n`);
    out.write(`  comparable (both reached a verdict)         ${stats.comparable}\n`);
    out.write(`  agreed                                      ${stats.agree}  (${pct(stats.agree, stats.comparable)} of comparable)\n`);
    out.write(`  disagreed                                   ${stats.disagree}  (${pct(stats.disagree, stats.comparable)} of comparable)\n`);
    out.write(`  agreed on the verdict, differed on reason   ${stats.tagDiff}  (${pct(stats.tagDiff, stats.agree)} of agreements)\n`);
    if (disagreements.length) {
      out.write('\nDisagreements\n');
      for (const row of disagreements) out.write(`  ${row.id}.${row.dim}: ${row.a} vs ${row.b}\n`);
    }
  }

  if (findings.length) {
    process.stderr.write(`\n${findings.length} finding${findings.length === 1 ? '' : 's'}\n`);
    for (const finding of findings) process.stderr.write(`  ${finding}\n`);
    return 1;
  }
  out.write('\nOK — the results conform to the format and to the corpus.\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}

export { validateCorpus, validateResults, agreement, checkSchemaDrift };
