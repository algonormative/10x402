// The lint engine, against fixtures. No server, no network, no D1.
//
// This is the phase that says what the product KNOWS. Every fixture is a
// perfect dual-stack 402 with exactly one thing broken, and each asserts the
// EXACT set of codes the report carries — not a subset. That strictness is the
// point: a new check that starts firing on an unrelated fixture is a check that
// has been written too broadly, and it should fail here rather than show up as
// a stranger's confusing report six months from now.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CHECKS, CHECKS_BY_ID, GRADE_RULES, grade, lint } from '../worker/lint.js';
import { FIXTURES, response, v1Envelope, v2Envelope, RESOURCE_URL } from './fixtures/envelopes.mjs';

const codesOf = (report) => report.findings.map((f) => f.code).sort();

describe('the check catalogue', () => {
  test('every id is unique', () => {
    const seen = new Set();
    for (const check of CHECKS) {
      assert.ok(!seen.has(check.id), `duplicate check id ${check.id}`);
      seen.add(check.id);
    }
    assert.equal(seen.size, CHECKS.length);
  });

  test('every check has a severity, an area and a one-line summary', () => {
    for (const check of CHECKS) {
      assert.ok(['error', 'warn', 'info'].includes(check.severity), `${check.id} severity`);
      assert.ok(['http', 'v1', 'v2', 'dual', 'version'].includes(check.area), `${check.id} area`);
      assert.ok(check.summary && check.summary.length > 8, `${check.id} summary`);
      assert.ok(!check.summary.includes('\n'), `${check.id} summary is one line`);
    }
  });

  test('only error-severity checks are marked core', () => {
    // `core` is what turns a D into an F, and a warning that could do that would
    // make the grade ladder a lie.
    for (const check of CHECKS.filter((c) => c.core)) {
      assert.equal(check.severity, 'error', `${check.id} is core but ${check.severity}`);
    }
  });

  test('the catalogue is big enough to be worth a cent', () => {
    // Not a vanity number: the marketing copy and GET /check both quote it, and
    // a catalogue that quietly shrank would make both of them wrong.
    assert.ok(CHECKS.length >= 30, `only ${CHECKS.length} checks`);
  });

  test('the grade ladder covers every grade', () => {
    assert.deepEqual(GRADE_RULES.map((r) => r.grade), ['A', 'B', 'C', 'D', 'F']);
  });
});

describe('the grade ladder', () => {
  const finding = (severity, code) => ({ severity, code, message: '', fix: '' });

  test('no findings is an A', () => {
    assert.equal(grade([]), 'A');
  });
  test('info findings alone are still an A', () => {
    assert.equal(grade([finding('info', 'V2_TAGS'), finding('info', 'V2_SERVICE_NAME')]), 'A');
  });
  test('one or two warnings is a B', () => {
    assert.equal(grade([finding('warn', 'V2_MAX_TIMEOUT')]), 'B');
    assert.equal(grade([finding('warn', 'V2_MAX_TIMEOUT'), finding('warn', 'V1_MIMETYPE')]), 'B');
  });
  test('three warnings is a C', () => {
    const warns = ['V2_MAX_TIMEOUT', 'V1_MIMETYPE', 'V1_DESCRIPTION'].map((c) => finding('warn', c));
    assert.equal(grade(warns), 'C');
  });
  test('a non-core error is a D', () => {
    assert.equal(grade([finding('error', 'V2_BAZAAR_INFO_VALIDATES')]), 'D');
  });
  test('a core error is an F, whatever else is true', () => {
    assert.equal(grade([finding('error', 'V2_B64_URLSAFE')]), 'F');
    assert.equal(grade([finding('error', 'V2_B64_URLSAFE'), finding('warn', 'V1_MIMETYPE')]), 'F');
  });
  test('a core error outranks a pile of non-core ones', () => {
    assert.equal(
      grade([finding('error', 'V2_BAZAAR_INFO_VALIDATES'), finding('error', 'V1_PAYTO')]),
      'F'
    );
  });
});

describe('fixtures', () => {
  for (const fixture of FIXTURES) {
    test(fixture.name, () => {
      const report = lint(fixture.response());

      assert.deepEqual(
        codesOf(report),
        [...fixture.expect.codes].sort(),
        `${fixture.name}: unexpected findings\n${JSON.stringify(report.findings, null, 2)}`
      );
      assert.equal(report.grade, fixture.expect.grade, `${fixture.name}: grade`);
      assert.ok(report.checks_run > 0, 'checks_run should be counted');
    });
  }

  test('every finding carries a specific, actionable fix', () => {
    // The `fix` string IS the product. A finding that reports a problem without
    // saying how to fix it has told the seller nothing they did not already
    // know from the silence.
    for (const fixture of FIXTURES) {
      for (const finding of lint(fixture.response()).findings) {
        assert.ok(finding.message, `${finding.code} has no message`);
        assert.ok(finding.fix, `${finding.code} has no fix`);
        assert.ok(
          finding.fix.length >= 40,
          `${finding.code} fix is too short to be actionable: ${finding.fix}`
        );
        assert.ok(CHECKS_BY_ID.has(finding.code), `${finding.code} is not in the catalogue`);
      }
    }
  });

  test('every code a fixture produces is one the catalogue can be asked about', () => {
    // The codes in a report and the ids published at GET /check are one
    // vocabulary, so a caller can always look up what it received.
    const produced = new Set();
    for (const fixture of FIXTURES) {
      for (const f of lint(fixture.response()).findings) produced.add(f.code);
    }
    assert.ok(produced.size >= 20, `only ${produced.size} distinct codes exercised`);
    for (const code of produced) assert.ok(CHECKS_BY_ID.has(code));
  });
});

describe('the summary line', () => {
  test('reports both versions, the address, the network and a readable price', () => {
    const report = lint(response({ v1: v1Envelope(), v2: v2Envelope(), url: RESOURCE_URL }));
    assert.deepEqual(report.summary.versions_detected, [1, 2]);
    assert.equal(report.summary.payTo, '0x0000000000000000000000000000000000000001');
    assert.equal(report.summary.network, 'eip155:8453');
    assert.equal(report.summary.price, '$0.001 (1000 atomic)');
  });

  test('reports only the version that is actually there', () => {
    assert.deepEqual(lint(response({ v1: v1Envelope() })).summary.versions_detected, [1]);
    assert.deepEqual(lint(response({ v2: v2Envelope() })).summary.versions_detected, [2]);
    assert.deepEqual(lint({ status: 402, headers: {}, body: '' }).summary.versions_detected, []);
  });

  test('does not invent a price it could not read', () => {
    const report = lint({ status: 402, headers: {}, body: '' });
    assert.equal(report.summary.price, null);
    assert.equal(report.summary.payTo, null);
  });
});

describe('checks_run', () => {
  test('counts fewer checks for a v1-only endpoint than for a dual-stack one', () => {
    // The denominator moves, which is exactly why it is reported: a caller
    // comparing two reports needs to know the v2 checks did not silently pass.
    const dual = lint(response({ v1: v1Envelope(), v2: v2Envelope(), url: RESOURCE_URL }));
    const v1Only = lint(response({ v1: v1Envelope(), url: RESOURCE_URL }));
    assert.ok(v1Only.checks_run < dual.checks_run, `${v1Only.checks_run} vs ${dual.checks_run}`);
  });

  test('never claims to have run a check that is not in the catalogue', () => {
    const report = lint(response({ v1: v1Envelope(), v2: v2Envelope(), url: RESOURCE_URL }));
    assert.ok(report.checks_run <= CHECKS.length, `${report.checks_run} > ${CHECKS.length}`);
  });
});

describe('robustness', () => {
  // A linter is handed broken things by definition, so it must never be the
  // thing that throws. Every one of these is a shape a real caller has sent.
  const junk = [
    undefined,
    {},
    { status: 402 },
    { status: 402, headers: null, body: null },
    { status: 402, headers: { 'payment-required': '!!!not base64!!!' }, body: 'not json' },
    { status: 402, headers: { 'payment-required': btoa('not json at all') }, body: '{}' },
    { status: 402, headers: { 'payment-required': btoa('[1,2,3]') }, body: '[1,2,3]' },
    { status: 402, headers: { 'payment-required': btoa('"a string"') }, body: '"a string"' },
    { status: 0, headers: {}, body: '' },
    { status: 402, headers: { 'PAYMENT-REQUIRED': btoa('{"x402Version":2}') }, body: '{}' },
  ];

  for (const [i, input] of junk.entries()) {
    test(`does not throw on junk input #${i}`, () => {
      const report = lint(input);
      assert.ok(['A', 'B', 'C', 'D', 'F'].includes(report.grade));
      assert.ok(Array.isArray(report.findings));
    });
  }

  test('header lookup is case-insensitive', () => {
    const lower = lint(response({ v1: v1Envelope(), v2: v2Envelope(), url: RESOURCE_URL }));
    const upper = lint({
      ...response({ v1: v1Envelope(), v2: v2Envelope(), url: RESOURCE_URL }),
      headers: Object.fromEntries(
        Object.entries(response({ v1: v1Envelope(), v2: v2Envelope() }).headers).map(([k, v]) => [
          k.toUpperCase(),
          v,
        ])
      ),
    });
    assert.equal(upper.grade, lower.grade);
    assert.deepEqual(codesOf(upper), codesOf(lower));
  });
});
