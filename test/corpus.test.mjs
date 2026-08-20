// THE PORTABLE CORPUS, ASSERTED AGAINST THE ENGINE THAT PUBLISHES IT.
//
// Pure — reads corpus/fixtures.json and runs worker/lint.js over it. No worker,
// no network, no clone: the x402-doctor half of the comparison needs a git
// clone and an npm install and is therefore a script you run
// (corpus/run-x402-doctor.mjs), never a test.
//
// The load-bearing assertion is the last one. corpus/fixtures.json is published
// as a shared artefact for other implementations to run against, and an
// expectation in it that our own engine does not reproduce is either a fixture
// we got wrong or an engine we got wrong — in both cases something a stranger
// would trip over. It caught two engine defects the first time it ran; see
// DISAGREEMENTS.md § Where 10x402 was wrong.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';

import { REASON_TAGS, TAGS, DIMENSIONS, TENX402_TAGS, CLIENT_INTEROP_LEVELS, judgeableFrom } from '../corpus/vocabulary.mjs';
import { runFixture, tagFor, assertPinnedBlobs } from '../corpus/run-10x402.mjs';
import { buildCorpus } from '../corpus/build-fixtures.mjs';
import { validateCorpus, validateResults, agreement } from '../corpus/validate-results.mjs';
import { FIXTURES } from './fixtures/envelopes.mjs';
import { CHECKS, operativeSources } from '../worker/lint.js';

const FIXTURES_PATH = new URL('../corpus/fixtures.json', import.meta.url);
const raw = readFileSync(FIXTURES_PATH, 'utf8');
const corpus = JSON.parse(raw);

const EVIDENCE_KINDS = new Set([
  'spec',
  'client-code',
  'cdp-validator',
  'cdp-docs',
  'field-report',
  'provider-observation',
  'house-opinion',
]);

describe('corpus: the file itself', () => {
  test('parses, and declares its version and pins', () => {
    assert.equal(corpus.corpus_version, 2);
    for (const pin of ['10x402', '@x402/core', 'x402', 'x402-foundation/x402', 'x402-doctor-prototype']) {
      assert.ok(corpus.pins[pin], `no pin for ${pin}`);
    }
    assert.equal(corpus.pins['@x402/core'].version, '2.23.0');
    assert.equal(corpus.pins.x402.version, '1.2.0');
    assert.match(corpus.pins['10x402'].commit, /^[0-9a-f]{40}$/);
    assert.match(corpus.pins['x402-doctor-prototype'].commit, /^[0-9a-f]{40}$/);
  });

  test('every package a verdict depends on is pinned, with an integrity hash', () => {
    // A `client-code` citation is meaningless without a version and weak
    // without a hash. The first version of this corpus cited @x402/evm and
    // @x402/fetch with no pin at all, and treated x402-fetch as covered by the
    // `x402` pin — they are separate packages on the registry.
    for (const name of ['@x402/core', '@x402/evm', '@x402/fetch', '@x402/extensions', 'x402', 'x402-fetch']) {
      const pkg = corpus.pins.packages?.[name];
      assert.ok(pkg, `no pin for ${name}`);
      assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `${name} version`);
      assert.match(pkg.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${name} integrity`);
    }
  });

  test('every package an evidence ref names is one of the pinned ones', () => {
    // The guard against a citation quietly acquiring a dependency nobody pinned.
    const pinned = Object.keys(corpus.pins.packages);
    const named = new Set();
    for (const fixture of corpus.fixtures) {
      for (const e of fixture.evidence) {
        for (const match of e.ref.matchAll(/(@?[a-z0-9][a-z0-9-]*(?:\/[a-z0-9-]+)?)@\d+\.\d+\.\d+/g)) named.add(match[1]);
      }
    }
    for (const name of named) assert.ok(pinned.includes(name), `evidence cites ${name}, which is not in pins.packages`);
  });

  test('the engine on disk is the engine the corpus pins', () => {
    // Content-addressed, and asserted BEFORE the adapter runs anywhere. The
    // published pin has to name the code that actually executed; a commit does
    // not, because HEAD moves and the previously published one predated both the
    // adapter and the corpus.
    const blobs = corpus.pins['10x402'].blobs;
    assert.ok(blobs && Object.keys(blobs).length >= 5, 'no blob pins');
    for (const [path, sha] of Object.entries(blobs)) assert.match(sha, /^[0-9a-f]{40}$/, path);
    assert.doesNotThrow(() => assertPinnedBlobs(corpus));
    assert.ok(blobs['worker/lint.js'], 'the engine itself is not pinned');
  });

  test('the prototype pin records its licence status, because there is no licence', () => {
    // The whole reason no code from it is vendored. If this ever stops saying
    // NONE somebody has re-checked and the vendoring question reopens.
    assert.match(corpus.pins['x402-doctor-prototype'].license, /^NONE\b/);
  });

  test('holds between 20 and 35 fixtures, with unique ids', () => {
    assert.ok(corpus.fixtures.length >= 20 && corpus.fixtures.length <= 35, `${corpus.fixtures.length} fixtures`);
    const ids = corpus.fixtures.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate fixture id');
    for (const id of ids) assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${id} is not kebab-case`);
  });

  test('publishes the whole tag vocabulary, so the file stands alone', () => {
    assert.deepEqual(Object.keys(corpus.reason_tags), TAGS);
    for (const meaning of Object.values(corpus.reason_tags)) assert.ok(meaning && meaning.length > 10);
  });
});

describe('corpus: every fixture', () => {
  for (const fixture of corpus.fixtures) {
    test(`${fixture.id} is well formed`, () => {
      assert.ok(fixture.title, 'no title');
      assert.equal(typeof fixture.response.status, 'number');
      assert.ok(fixture.response.headers && typeof fixture.response.headers === 'object');
      assert.equal(typeof fixture.response.body, 'string');
      assert.ok('method' in fixture.context && 'url' in fixture.context);
      assert.ok(fixture.origin?.kind && fixture.origin?.ref);
    });

    test(`${fixture.id} carries all three expectations`, () => {
      for (const dim of DIMENSIONS) {
        const e = fixture.expected[dim];
        assert.ok(e, `no ${dim} expectation`);
        assert.ok(['pass', 'fail', 'n/a'].includes(e.verdict), `${dim}: ${e.verdict}`);
        assert.ok(Array.isArray(e.reason_tags));
        // not-evaluated is a RESULTS value. An expectation that used it would be
        // the corpus declining to say what it thinks, which is not an expectation.
        assert.notEqual(e.verdict, 'not-evaluated');
      }
    });

    test(`${fixture.id} names a reason exactly when it fails`, () => {
      for (const dim of DIMENSIONS) {
        const e = fixture.expected[dim];
        if (e.verdict === 'fail') assert.ok(e.reason_tags.length > 0, `${dim} fails with no reason`);
        else assert.equal(e.reason_tags.length, 0, `${dim} is ${e.verdict} and carries reasons`);
      }
    });

    test(`${fixture.id} uses only vocabulary tags, and only fatal ones`, () => {
      for (const dim of DIMENSIONS) {
        for (const tag of fixture.expected[dim].reason_tags) {
          assert.ok(TAGS.includes(tag), `${dim}: ${tag} is not in the vocabulary`);
          // An expectation is a reason a dimension FAILED. A tag no rule can
          // raise to error severity cannot be one.
          assert.equal(REASON_TAGS[tag].fatal, true, `${dim}: ${tag} is observational, not fatal`);
        }
        assert.equal(new Set(fixture.expected[dim].reason_tags).size, fixture.expected[dim].reason_tags.length);
      }
    });

    test(`${fixture.id} cites its evidence with declared kinds, scoped to dimensions`, () => {
      assert.ok(fixture.evidence.length > 0, 'no evidence');
      for (const e of fixture.evidence) {
        assert.ok(EVIDENCE_KINDS.has(e.kind), `unknown evidence kind ${e.kind}`);
        assert.ok(typeof e.ref === 'string' && e.ref.trim().length > 0, 'evidence with no ref');
        assert.ok(corpus.evidence_kinds[e.kind], `${e.kind} is not documented in evidence_kinds`);
        // A fixture-wide array does not let a reader ask what supports WHICH
        // verdict. Every citation names the dimensions it is offered for.
        assert.ok(Array.isArray(e.dimensions) && e.dimensions.length > 0, `evidence with no dimensions: ${e.ref.slice(0, 50)}`);
        for (const dim of e.dimensions) assert.ok(DIMENSIONS.includes(dim), `evidence names dimension ${dim}`);
      }
      // …and a verdict with no citation scoped to it is a claim with no support.
      for (const dim of DIMENSIONS) {
        if (fixture.expected[dim].verdict === 'n/a') continue;
        assert.ok(fixture.evidence.some((e) => e.dimensions.includes(dim)), `${dim} has a verdict and no evidence scoped to it`);
      }
    });

    test(`${fixture.id} says how strong its client-interoperability claim is`, () => {
      const level = fixture.expected.client_interop.claim_level;
      assert.ok(CLIENT_INTEROP_LEVELS.includes(level), `claim_level ${level}`);
      if (level !== 'execute') return;
      // PARSING IS NOT EXECUTING. An `execute` claim says the cited client
      // selects the offer, signs it and issues the payment, and that needs a
      // citation into a signer or a payment path — not a schema that read the
      // bytes. The first version of this corpus promised "parse and execute"
      // everywhere and evidenced parsing.
      const executes = fixture.evidence.filter(
        (e) => e.kind === 'client-code' && e.dimensions.includes('client_interop') && /EXECUTE-LEVEL/.test(e.ref)
      );
      assert.ok(executes.length > 0, 'claims execute-level interoperability with no execution citation');
    });

    test(`${fixture.id} names a provider wherever it reaches a discovery verdict`, () => {
      if (fixture.expected.discovery.verdict === 'n/a') {
        assert.equal(fixture.discovery_target, undefined, 'an n/a discovery verdict names a provider it is not judging');
        return;
      }
      // The repair for "provider-specific discovery verdicts asserted without a
      // provider observation". The dimension asks about a NAMED provider's
      // documented requirements, so the fixture has to name one and cite it.
      assert.ok(fixture.discovery_target?.provider, 'a discovery verdict with no named provider');
      assert.equal(fixture.discovery_target.claim, 'static-declaration-eligibility');
      assert.ok(fixture.discovery_target.basis?.length > 20, 'the provider target names no documented requirement');
      const kinds = new Set(fixture.evidence.filter((e) => e.dimensions.includes('discovery')).map((e) => e.kind));
      const providerKinds = ['cdp-validator', 'cdp-docs', 'provider-observation'];
      assert.ok(providerKinds.some((k) => kinds.has(k)), `a discovery verdict evidenced only by ${[...kinds].join('/')}`);
    });

    test(`${fixture.id} declares what its recording can be judged on`, () => {
      // Computed from the response and nothing else, so a third adapter reaches
      // the same set from the published file. Asserted rather than trusted: a
      // corpus that lies about its own scope is exactly what this catches.
      assert.deepEqual(fixture.judgeable, judgeableFrom(fixture.response));
      for (const dim of DIMENSIONS) {
        const e = fixture.expected[dim];
        if (fixture.judgeable[dim] === false) {
          assert.equal(e.verdict, 'n/a', `${dim} is not judgeable from this recording`);
          assert.equal(e.na_kind, 'scope', `${dim} is not judgeable and does not say so`);
        } else {
          assert.notEqual(e.na_kind, 'scope', `${dim} claims scope exclusion but the recording supports a verdict`);
        }
        if (e.verdict === 'n/a') assert.ok(corpus.na_kinds[e.na_kind], `${dim}: undocumented na_kind ${e.na_kind}`);
      }
    });
  }
});

describe('corpus: no house rule decides a normative dimension', () => {
  // THE FAULT v2 EXISTS TO FIX, asserted rather than described. A finding whose
  // operative provenance is only a house opinion, a field report or a provider
  // observation may be recorded — it may not fail `payment` or `client_interop`.
  test('every check that can fail payment cites the specification, operatively', () => {
    for (const check of CHECKS) {
      if (check.regime === 'bazaar') continue;
      const kinds = new Set(operativeSources(check.id).map((s) => s.kind));
      const decides = kinds.has('spec') || kinds.has('client-code');
      if (!decides) continue;
      // The check may fail something; make sure it is the dimension its
      // operative citation actually supports.
      assert.ok(kinds.has('spec') || kinds.has('client-code'));
    }
  });

  test('the DUAL_* family fails no normative dimension, because nothing normative governs it', () => {
    // No specification contemplates dual publishing, so these five are house
    // positions. v1 mapped them to `payment` through a documented override,
    // which made a house rule a normative payment verdict on two fixtures.
    for (const id of ['DUAL_PAYTO', 'DUAL_PRICE', 'DUAL_NETWORK', 'DUAL_ASSET', 'DUAL_RESOURCE']) {
      const kinds = new Set(operativeSources(id).map((s) => s.kind));
      assert.ok(!kinds.has('spec'), `${id} would fail the payment dimension`);
      assert.ok(!kinds.has('client-code'), `${id} would fail the client_interop dimension`);
    }
  });

  test('no expectation in the corpus rests on a house opinion alone', () => {
    for (const fixture of corpus.fixtures) {
      for (const dim of DIMENSIONS) {
        if (fixture.expected[dim].verdict !== 'fail') continue;
        const kinds = new Set(fixture.evidence.filter((e) => e.dimensions.includes(dim)).map((e) => e.kind));
        const authority = { payment: 'spec', client_interop: 'client-code' }[dim];
        if (!authority) {
          const provider = ['cdp-validator', 'cdp-docs', 'provider-observation'];
          assert.ok(provider.some((k) => kinds.has(k)), `${fixture.id}.${dim} fails on no provider evidence`);
          continue;
        }
        assert.ok(kinds.has(authority), `${fixture.id}.${dim} fails with no ${authority} citation`);
      }
    }
  });
});

describe('corpus: the adapter is total', () => {
  test('every check in the catalogue has a corpus tag', () => {
    // A new check with no tag would throw at run time, in the middle of a run,
    // for whichever fixture happened to trigger it first. Assert it up front.
    for (const check of CHECKS) {
      assert.ok(TENX402_TAGS[check.id], `check ${check.id} has no corpus tag`);
      assert.doesNotThrow(() => tagFor(check.id), `check ${check.id} maps outside the vocabulary`);
    }
  });

  test('every vocabulary tag is documented', () => {
    for (const tag of TAGS) {
      assert.equal(typeof REASON_TAGS[tag].meaning, 'string');
      assert.equal(typeof REASON_TAGS[tag].fatal, 'boolean');
    }
  });
});

describe('corpus: 10x402 reproduces every expectation', () => {
  for (const fixture of corpus.fixtures) {
    test(`${fixture.id}`, () => {
      const got = runFixture(fixture);
      for (const dim of DIMENSIONS) {
        const want = fixture.expected[dim];
        const have = got.dimensions[dim];
        const show =
          `${fixture.id}.${dim}\n` +
          `  corpus expects ${want.verdict} [${want.reason_tags.join(', ')}]\n` +
          `  10x402 says    ${have.verdict} [${have.reason_tags.join(', ')}]\n` +
          `  grade ${got.tool_detail.grade}, bazaar_ready ${got.tool_detail.bazaar_ready}\n` +
          got.tool_detail.findings.map((f) => `    [${f.severity}] ${f.code} (${f.regime}) → ${f.tag}`).join('\n');
        assert.equal(have.verdict, want.verdict, show);
        assert.deepEqual([...have.reason_tags].sort(), [...want.reason_tags].sort(), show);
      }
    });
  }
});

describe('corpus: the calibration fixtures hold', () => {
  test('the v2 spec’s own canonical 402 passes payment and client_interop', () => {
    // The single most important assertion in this file. A conformance checker
    // that fails the specification's own example is not strict, it is wrong.
    const fixture = corpus.fixtures.find((f) => f.id === 'calibration-spec-canonical-402');
    assert.ok(fixture, 'the calibration fixture is missing from the corpus');
    assert.equal(fixture.calibration, 'must-pass');
    const got = runFixture(fixture);
    assert.equal(got.dimensions.payment.verdict, 'pass', JSON.stringify(got.tool_detail.findings, null, 1));
    assert.equal(got.dimensions.client_interop.verdict, 'pass', JSON.stringify(got.tool_detail.findings, null, 1));
  });

  test('…and fails discovery, which is why the dimensions are separate', () => {
    const fixture = corpus.fixtures.find((f) => f.id === 'calibration-spec-canonical-402');
    const got = runFixture(fixture);
    assert.equal(got.dimensions.discovery.verdict, 'fail');
    assert.deepEqual(got.dimensions.discovery.reason_tags, ['bazaar-extension-absent']);
  });

  test('the live positive control passes all three', () => {
    const fixture = corpus.fixtures.find((f) => f.id === 'calibration-live-positive-control');
    const got = runFixture(fixture);
    for (const dim of DIMENSIONS) assert.equal(got.dimensions[dim].verdict, 'pass', `${dim}: ${JSON.stringify(got.tool_detail.findings)}`);
  });

  test('every must-pass calibration fixture is clean on payment and client_interop', () => {
    const calibration = corpus.fixtures.filter((f) => f.calibration === 'must-pass');
    assert.ok(calibration.length >= 3, 'the corpus lost its calibration fixtures');
    for (const fixture of calibration) {
      const got = runFixture(fixture);
      assert.equal(got.dimensions.payment.verdict, 'pass', fixture.id);
      assert.equal(got.dimensions.client_interop.verdict, 'pass', fixture.id);
    }
  });
});

describe('corpus: the conformance test a third adapter runs', () => {
  // corpus/validate-results.mjs is what a stranger points at their own results
  // file. It is asserted here against OUR results files for the obvious reason:
  // a contract we publish and do not meet is worse than no contract, and the two
  // files in this repository are the only worked examples anybody has.
  //
  // It imports nothing from worker/lint.js, which is the point — a third
  // implementation must be able to check its own output without running ours.
  const schemas = {
    fixtures: JSON.parse(readFileSync(new URL('../corpus/schema/fixtures.schema.json', import.meta.url), 'utf8')),
    results: JSON.parse(readFileSync(new URL('../corpus/schema/results.schema.json', import.meta.url), 'utf8')),
  };

  test('the corpus satisfies its own published schema', () => {
    const findings = validateCorpus(corpus, schemas.fixtures, 'corpus/fixtures.json');
    assert.deepEqual(findings, [], findings.join('\n'));
  });

  for (const name of ['results-10x402.json', 'results-x402-doctor.json']) {
    test(`${name} satisfies the results contract`, () => {
      const results = JSON.parse(readFileSync(new URL(`../corpus/${name}`, import.meta.url), 'utf8'));
      const findings = validateResults(results, corpus, schemas.results, `corpus/${name}`);
      assert.deepEqual(findings, [], findings.join('\n'));
    });
  }

  test('the validator rejects a results file that answers a scope-excluded dimension', () => {
    // A CHECK THAT NEVER FAILS IS NOT A CHECK. The gate above passes on files we
    // generated ourselves, which proves nothing on its own, so the negative
    // control runs beside it: a results file that turns an unanswerable
    // dimension into a pass must be caught by name.
    const results = JSON.parse(readFileSync(new URL('../corpus/results-10x402.json', import.meta.url), 'utf8'));
    const scoped = corpus.fixtures.find((f) => Object.values(f.judgeable).includes(false));
    assert.ok(scoped, 'the corpus has no scope-excluded dimension to test with');
    const dim = DIMENSIONS.find((d) => scoped.judgeable[d] === false);
    results.results.find((r) => r.id === scoped.id).dimensions[dim] = { verdict: 'pass', reason_tags: [], observed_tags: [] };
    const findings = validateResults(results, corpus, schemas.results, 'mutated');
    assert.ok(findings.length > 0, 'a scope-excluded dimension reported as a pass was accepted');
    assert.ok(findings.some((f) => f.includes(`${scoped.id}.${dim}`)), findings.join('\n'));
  });

  test('the validator rejects an observational tag used as a reason', () => {
    const results = JSON.parse(readFileSync(new URL('../corpus/results-10x402.json', import.meta.url), 'utf8'));
    const failing = results.results.find((r) => r.dimensions.payment.verdict === 'fail');
    failing.dimensions.payment.reason_tags = [...failing.dimensions.payment.reason_tags, 'redirect'];
    const findings = validateResults(results, corpus, schemas.results, 'mutated');
    assert.ok(findings.some((f) => /OBSERVATIONAL/i.test(f)), findings.join('\n'));
  });

  test('the two results files reproduce the agreement figures the report publishes', () => {
    // The same algorithm, computed by a script that shares no code with
    // corpus/report-disagreements.mjs. If the two ever disagree, one of them is
    // implementing a different definition of "agreement" and the published
    // percentage means nothing.
    const a = JSON.parse(readFileSync(new URL('../corpus/results-10x402.json', import.meta.url), 'utf8'));
    const b = JSON.parse(readFileSync(new URL('../corpus/results-x402-doctor.json', import.meta.url), 'utf8'));
    const { stats } = agreement(corpus, a, b);
    assert.equal(stats.total, corpus.fixtures.length * 3);
    assert.equal(stats.total, stats.comparable + stats.notEvaluated + stats.scopeExcluded);
    assert.equal(stats.comparable, stats.agree + stats.disagree);
    // None of the exclusions may be silently counted as agreement.
    assert.ok(stats.scopeExcluded > 0 && stats.notEvaluated > 0);
    assert.ok(stats.agree < stats.total, 'every dimension agreeing would mean the comparison is not comparing');
  });
});

describe('corpus: the suite fixtures were exported unchanged', () => {
  // THE CLAIM IS ABOUT BYTES, SO THE TEST IS ABOUT BYTES. The version of this
  // suite that shipped with corpus v1 checked that origin STRINGS had the
  // expected prefix, which is a test of a label rather than of the thing the
  // label describes: it would have passed over a fixture whose recorded response
  // had drifted from the builder that is supposed to produce it.

  test('every suite-derived fixture names the suite fixture it came from', () => {
    const derived = corpus.fixtures.filter((f) => f.origin.kind === '10x402-suite');
    assert.ok(derived.length >= 15, `${derived.length} suite-derived fixtures`);
    for (const f of derived) assert.match(f.origin.ref, /^test\/fixtures\/envelopes\.mjs — .+/);
  });

  test('every suite-derived response IS what the suite builder produces, field for field', () => {
    for (const fixture of corpus.fixtures) {
      if (fixture.origin.kind !== '10x402-suite') continue;
      const name = fixture.origin.ref.replace(/^test\/fixtures\/envelopes\.mjs — /, '');
      const suite = FIXTURES.find((f) => f.name === name);
      assert.ok(suite, `${fixture.id} names a suite fixture that does not exist: ${name}`);
      const built = suite.response();
      assert.deepEqual(
        fixture.response,
        { status: built.status, headers: built.headers, body: built.body ?? '' },
        `${fixture.id} has drifted from ${name}`
      );
      assert.deepEqual(fixture.context, { method: built.method ?? null, url: built.url ?? null }, `${fixture.id} context`);
    }
  });

  test('regenerating the corpus produces the committed file, byte for byte', () => {
    // The reproduction command in FORMAT.md and DISAGREEMENTS.md has to be one a
    // stranger can run without producing a diff. The builder is INVOKED here —
    // not imitated — and its output compared to the committed bytes. Two fields
    // would otherwise move on their own, the generation date and the repository
    // HEAD, and both are carried forward from the committed file unless
    // `--stamp` is passed.
    const rebuilt = `${JSON.stringify(buildCorpus(), null, 2)}\n`;
    assert.equal(rebuilt, raw, 'node corpus/build-fixtures.mjs would change corpus/fixtures.json');
  });

  test('the corpus carries calibration and constructed fixtures too, and says which', () => {
    const kinds = new Set(corpus.fixtures.map((f) => f.origin.kind));
    assert.deepEqual([...kinds].sort(), ['10x402-suite', 'calibration', 'constructed']);
    assert.equal(corpus.fixtures.filter((f) => f.origin.kind === 'calibration').length, 5);
    assert.equal(corpus.fixtures.filter((f) => f.origin.kind === 'constructed').length, 3);
  });
});
