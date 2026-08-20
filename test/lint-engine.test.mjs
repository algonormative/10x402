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
import { CHECKS, CHECKS_BY_ID, GRADE_RULES, MAX_ACCEPTS_LINTED, grade, lint } from '../worker/lint.js';
import {
  FIXTURES,
  bazaar,
  response,
  v1Accept,
  v1Envelope,
  v2Accept,
  v2Envelope,
  v2Resource,
  RESOURCE_URL,
} from './fixtures/envelopes.mjs';

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
      assert.ok(['http', 'v1', 'v2', 'dual', 'version', 'report'].includes(check.area), `${check.id} area`);
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
    // V2_EXTRA_EIP712: payment regime, error, not core. A client throws before
    // it signs, so the endpoint takes no money — but the envelope itself parses.
    assert.equal(grade([finding('error', 'V2_EXTRA_EIP712')]), 'D');
  });

  test('a BAZAAR-regime error does not touch the grade', () => {
    // The whole point of the split. An info/schema pair that does not agree is
    // a silent delisting and it is not a payment defect: the endpoint takes
    // money correctly and simply never appears in the directory. Answering that
    // with a D told a seller their working endpoint was broken.
    assert.equal(grade([finding('error', 'V2_BAZAAR_INFO_VALIDATES')]), 'A');
    assert.equal(grade([finding('error', 'V2_BAZAAR_PRESENT'), finding('warn', 'V2_TAGS')]), 'A');
  });

  test('a HYGIENE finding is an info by construction, so it cannot grade', () => {
    // Asserted on the catalogue rather than on a report: the constructor loop in
    // lint.js refuses to load a hygiene check above info severity, and this is
    // the readable statement of that rule.
    for (const check of CHECKS.filter((c) => c.regime === 'hygiene')) {
      assert.equal(check.severity, 'info', `${check.id} is hygiene at ${check.severity}`);
    }
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

describe('the report is bounded, because the input is not', () => {
  // A lint report is a function of attacker-controlled input, and every one of
  // these bounds was missing: a 60 KB envelope produced a 56 MB report, which
  // is an out-of-memory for the price of one cent. The bounds report
  // themselves, because a truncated report read as a clean one would be worse
  // than the amplification.

  /** A small envelope with an absurd accepts[]: ~15 KB in, unbounded out. */
  const hostile = () => {
    const entries = Array.from({ length: 5000 }, () => ({}));
    return response({
      v1: { x402Version: 1, accepts: entries },
      v2: { x402Version: 2, resource: v2Resource(), accepts: entries, extensions: bazaar() },
      url: RESOURCE_URL,
    });
  };

  test('5,000 accepts[] entries do not become a 56 MB report', () => {
    const input = hostile();
    const report = lint(input);
    const size = JSON.stringify(report).length;

    assert.ok(size < 256 * 1024, `the report is ${Math.round(size / 1024)} KB`);
    // And the amplification factor itself, which is the number that matters:
    // before the bounds this was 945x.
    const ratio = size / JSON.stringify(input).length;
    assert.ok(ratio < 20, `${ratio.toFixed(1)}x amplification`);
  });

  test('it says how many entries it did not read', () => {
    const truncated = lint(hostile()).findings.filter((f) => f.code === 'ACCEPTS_TRUNCATED');
    // One per envelope: the v1 body and the v2 header each have 5,000.
    assert.equal(truncated.length, 2);
    for (const finding of truncated) {
      assert.equal(finding.severity, 'info');
      assert.match(finding.message, /5000 accepts\[\] entries/);
      assert.match(finding.message, /4992 were not/);
    }
  });

  test('a fault repeated across accepts[] is ONE finding, not one per entry', () => {
    // Otherwise the grade scales with the length of the array: the same fault
    // is a B in a one-entry envelope and a C in a four-entry one.
    const v1 = v1Envelope();
    v1.accepts = [0, 1, 2, 3].map(() => {
      const entry = v1Accept();
      delete entry.extra;
      return entry;
    });
    const report = lint(response({ v1, v2: v2Envelope(), url: RESOURCE_URL }));

    const extra = report.findings.filter((f) => f.code === 'V1_EXTRA_EIP712');
    assert.equal(extra.length, 1, JSON.stringify(report.findings.map((f) => f.code)));
    assert.match(extra[0].message, /also in v1 accepts\[1\], v1 accepts\[2\], v1 accepts\[3\]/);
    assert.match(extra[0].message, /4 of the 4 accepts\[\] entries/);
    // One error, so a D — exactly what the same fault in ONE entry scores, which
    // is the whole invariant. (An error rather than a warn because @x402/evm
    // throws before signing when the EIP-712 domain is absent; see the catalogue.)
    assert.equal(report.grade, 'D');
  });

  test('two DIFFERENT faults under one code stay two findings', () => {
    // THE DEDUPE MUST NOT LIE. Several checks reach the same code from branches
    // that diagnose different things: V2_NETWORK_CAIP2 fires for "names no
    // network", for "uses the v1 name base" — whose fix spells out the exact
    // CAIP-2 replacement, the most actionable string in the catalogue — and for
    // "is not a CAIP-2 identifier". Collapsing on the code alone kept the first
    // and threw the other two away, then appended "the same fault is also in
    // accepts[1]", which was false: a seller checking accepts[1] would find a
    // network there and conclude the linter was wrong.
    const v2 = v2Envelope();
    const missing = v2Accept();
    delete missing.network;
    const v1Spelling = { ...v2Accept(), network: 'base' };
    const nonsense = { ...v2Accept(), network: 'no-colon-here' };
    v2.accepts = [missing, v1Spelling, nonsense];

    const findings = lint(response({ v1: v1Envelope(), v2, url: RESOURCE_URL })).findings.filter(
      (f) => f.code === 'V2_NETWORK_CAIP2'
    );
    assert.equal(findings.length, 3, JSON.stringify(findings.map((f) => f.message), null, 2));
    assert.match(findings[0].message, /accepts\[0\] names no network/);
    assert.match(findings[1].message, /accepts\[1\] uses the v1 network name "base"/);
    assert.match(findings[1].fix, /eip155:8453/, 'the replacement value was lost in the collapse');
    assert.match(findings[2].message, /accepts\[2\].*is not a network identifier/);
    // And none of them claims the others are the same fault.
    for (const f of findings) assert.ok(!/The same fault/.test(f.message), f.message);
  });

  test('a non-object accepts[] entry is reported wherever it is', () => {
    // Two silences, at two indexes. A non-object at index 0 returned early and
    // skipped the entire array — including the truncation notice, so unread
    // entries went unmentioned — and one at any later index was skipped with
    // nothing said. A client iterating accepts[] faults on both.
    const v2 = v2Envelope();
    v2.accepts = [null, v2Accept(), 'a string', 12345];
    const report = lint(response({ v1: v1Envelope(), v2, url: RESOURCE_URL }));
    const junk = report.findings.filter((f) => f.code === 'V2_SCHEME');

    assert.equal(junk.length, 3, JSON.stringify(report.findings.map((f) => f.code)));
    assert.match(junk[0].message, /accepts\[0\] is null, not an object/);
    assert.match(junk[1].message, /accepts\[2\] is "a string", not an object/);
    assert.match(junk[2].message, /accepts\[3\] is 12345, not an object/);
  });

  test('a non-object first entry no longer hides how much went unread', () => {
    const v2 = v2Envelope();
    v2.accepts = [null, ...Array.from({ length: 40 }, () => v2Accept())];
    const report = lint(response({ v1: v1Envelope(), v2, url: RESOURCE_URL }));
    const truncated = report.findings.find((f) => f.code === 'ACCEPTS_TRUNCATED');
    assert.ok(truncated, 'forty unread entries and nothing said about them');
    assert.match(truncated.message, /41 accepts\[\] entries/);
  });

  test('summary.price is clipped like everything else that leaves here', () => {
    // It looks derived rather than copied, which is how it escaped: formatPrice
    // turns any run of digits into a dollar figure the same length, so a
    // 60,000-digit amount produced a 60,000-character price sitting next to a
    // dutifully clipped atomic value.
    const v2 = v2Envelope();
    v2.accepts[0].amount = '1'.repeat(60_000);
    const report = lint(response({ v2, url: RESOURCE_URL }));
    assert.ok(report.summary.price.length < 200, `price is ${report.summary.price.length} characters`);
    assert.ok(JSON.stringify(report).length < 16_000, 'the report grew with the amount');
  });

  test('the grade of a repeated fault does not move with the array length', () => {
    const withEntries = (n) => {
      const v1 = v1Envelope();
      v1.accepts = Array.from({ length: n }, () => {
        const entry = v1Accept();
        delete entry.extra;
        return entry;
      });
      return lint(response({ v1, v2: v2Envelope(), url: RESOURCE_URL })).grade;
    };
    assert.equal(withEntries(1), withEntries(40));
  });

  test('a hostile string in the envelope is quoted back clipped, not whole', () => {
    // Every message that interpolates envelope content is a place a 2 KB field
    // becomes 2 KB of report, once per check.
    const v2 = v2Envelope();
    v2.accepts[0].network = 'x'.repeat(20_000);
    const report = lint(response({ v1: v1Envelope(), v2, url: RESOURCE_URL }));

    const finding = report.findings.find((f) => f.code === 'V2_NETWORK_CAIP2');
    assert.ok(finding, JSON.stringify(report.findings.map((f) => f.code)));
    assert.ok(finding.message.length < 600, `message is ${finding.message.length} characters`);
    assert.match(finding.message, /\+19800 more characters/);
    assert.ok(JSON.stringify(report).length < 8000, 'the whole report grew with the input');
  });

  test('no input can produce more findings than there are checks', () => {
    // THE REAL BOUND, and it is stronger than the 200-finding cap. Two limits
    // compose to give it: at most MAX_ACCEPTS_LINTED entries are read per
    // envelope, and identical faults across those entries collapse into one
    // finding that names them all.
    //
    // NOT "each code appears once", which is what this test used to assert and
    // which was never true — see 'two DIFFERENT faults under one code' above,
    // where V2_NETWORK_CAIP2 legitimately produces three findings because three
    // entries are wrong in three different ways. The values quoted out of the
    // envelope are part of a fault's identity, deliberately: two entries naming
    // two different unknown schemes are two things for the seller to look at.
    // The bound is therefore per-envelope-entry, not per code, and the old
    // assertion passed only because no hostile in this list happened to vary a
    // quoted value. One that does was added below.
    const hostiles = [
      hostile(),
      response({ v1: { x402Version: 1, accepts: Array.from({ length: 400 }, (_, i) => ({ scheme: `s${i}` })) } }),
      response({ v2: { x402Version: 2, accepts: Array.from({ length: 900 }, () => ({})) } }),
      // The case the old assertion would have caught nothing about: 400 entries
      // each naming a DIFFERENT unknown scheme, so every one is its own fault.
      // Eight are read, eight are reported, and the report stops there.
      response({
        v1: { x402Version: 1, accepts: Array.from({ length: 400 }, (_, i) => ({ scheme: `scheme-${i}` })) },
      }),
    ];
    for (const input of hostiles) {
      const report = lint(input);
      assert.ok(
        report.findings.length <= CHECKS.length,
        `${report.findings.length} findings from ${CHECKS.length} checks`
      );
      // A code appears at most once per entry actually read, across both
      // envelopes — eight per envelope, sixteen in total. Anything above that
      // means the collapse stopped working and the report is about to scale
      // with the length of an attacker's array again.
      const counts = new Map();
      for (const f of report.findings) counts.set(f.code, (counts.get(f.code) ?? 0) + 1);
      for (const [code, n] of counts) {
        assert.ok(n <= 2 * MAX_ACCEPTS_LINTED, `${code} appeared ${n} times`);
      }
    }
  });

  test('the cap notice can never change a grade', () => {
    assert.equal(CHECKS_BY_ID.get('FINDINGS_TRUNCATED').severity, 'info');
    assert.equal(grade([{ severity: 'info', code: 'FINDINGS_TRUNCATED' }]), 'A');
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
