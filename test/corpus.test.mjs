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

import { REASON_TAGS, TAGS, DIMENSIONS, TENX402_TAGS } from '../corpus/vocabulary.mjs';
import { runFixture, tagFor } from '../corpus/run-10x402.mjs';
import { CHECKS } from '../worker/lint.js';

const corpus = JSON.parse(readFileSync(new URL('../corpus/fixtures.json', import.meta.url), 'utf8'));

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
    assert.equal(corpus.corpus_version, 1);
    for (const pin of ['10x402', '@x402/core', 'x402', 'x402-foundation/x402', 'x402-doctor-prototype']) {
      assert.ok(corpus.pins[pin], `no pin for ${pin}`);
    }
    assert.equal(corpus.pins['@x402/core'].version, '2.23.0');
    assert.equal(corpus.pins.x402.version, '1.2.0');
    assert.match(corpus.pins['10x402'].commit, /^[0-9a-f]{40}$/);
    assert.match(corpus.pins['x402-doctor-prototype'].commit, /^[0-9a-f]{40}$/);
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

    test(`${fixture.id} cites its evidence with declared kinds`, () => {
      assert.ok(fixture.evidence.length > 0, 'no evidence');
      for (const e of fixture.evidence) {
        assert.ok(EVIDENCE_KINDS.has(e.kind), `unknown evidence kind ${e.kind}`);
        assert.ok(typeof e.ref === 'string' && e.ref.trim().length > 0, 'evidence with no ref');
        assert.ok(corpus.evidence_kinds[e.kind], `${e.kind} is not documented in evidence_kinds`);
      }
    });
  }
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

describe('corpus: the suite fixtures were exported unchanged', () => {
  // fromSuite() in the builder invokes the suite's own response builder, so the
  // exported bytes ARE the suite's. This asserts the provenance is recorded,
  // which is what lets a reader of the corpus check that claim.
  test('every suite-derived fixture names the suite fixture it came from', () => {
    const derived = corpus.fixtures.filter((f) => f.origin.kind === '10x402-suite');
    assert.ok(derived.length >= 15, `${derived.length} suite-derived fixtures`);
    for (const f of derived) assert.match(f.origin.ref, /^test\/fixtures\/envelopes\.mjs — .+/);
  });

  test('the corpus carries calibration and constructed fixtures too, and says which', () => {
    const kinds = new Set(corpus.fixtures.map((f) => f.origin.kind));
    assert.deepEqual([...kinds].sort(), ['10x402-suite', 'calibration', 'constructed']);
  });
});
