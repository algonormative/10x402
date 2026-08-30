// ONE NAMED CHECK, and the price sheet that made it a product.
//
// Two claims live here and they are both pure, so this file boots nothing.
//
//   1. lintOne() answers about exactly one check and distinguishes THREE
//      outcomes. The third — the check did not apply — is the whole reason this
//      is not a filter over `findings`: a check that emitted nothing and a
//      check that never executed are indistinguishable from the outside, and
//      selling the second as a pass would be this service's most expensive
//      possible false negative.
//
//   2. The four prices, the copy that argues about them, and the routes that
//      serve them agree with each other. Every one of those is written down in
//      a different file, which is exactly the arrangement that drifts.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  BATCH_MULTIPLES,
  ENDPOINTS,
  ENDPOINTS_BY_ID,
  RAILS,
  batchAdvantageLine,
  perCheckAdvantage,
  priceLabel,
  railOf,
  singlesEdge,
} from '../worker/catalog.js';
import { CHECKS, CHECKS_BY_ID, lint, lintOne } from '../worker/lint.js';
import { atomicAmount, runSample } from '../worker/envelope.js';
import { POSITIVE_CONTROL } from '../worker/positive-control.js';
import { ROOT } from './harness.mjs';
import { response, v1Envelope, v2Envelope } from './fixtures/envelopes.mjs';

const control = () => ({
  status: POSITIVE_CONTROL.status,
  headers: POSITIVE_CONTROL.headers,
  body: POSITIVE_CONTROL.body,
  url: POSITIVE_CONTROL.url,
  method: POSITIVE_CONTROL.method,
});

/** A correct dual-stack 402, and a v1-only one — the two shapes that matter here. */
const dual = () => response({ v1: v1Envelope(), v2: v2Envelope() });
const v1Only = () => response({ v1: v1Envelope() });

describe('lintOne: the check ran and found nothing', () => {
  test('passed true, no finding, checks_run 1', () => {
    const answer = lintOne(control(), 'V2_B64_URLSAFE');
    assert.equal(answer.check, 'V2_B64_URLSAFE');
    assert.equal(answer.applied, true);
    assert.equal(answer.passed, true);
    assert.equal(answer.finding, null);
    assert.equal(answer.checks_run, 1);
    assert.equal(answer.note, undefined, 'a check that ran has nothing to explain');
  });

  test('it carries the rule’s provenance, so the verdict can be traced', () => {
    // A single-check answer IS a rule quoted at somebody. A rule quoted with no
    // citation is one they have to take on faith, which is the opposite of what
    // this catalogue is for.
    const answer = lintOne(control(), 'V2_MAX_TIMEOUT');
    assert.equal(answer.regime, CHECKS_BY_ID.get('V2_MAX_TIMEOUT').regime);
    assert.equal(answer.severity, CHECKS_BY_ID.get('V2_MAX_TIMEOUT').severity);
    assert.equal(answer.core, CHECKS_BY_ID.get('V2_MAX_TIMEOUT').core === true);
    assert.deepEqual(answer.sources, CHECKS_BY_ID.get('V2_MAX_TIMEOUT').sources);
  });
});

describe('lintOne: the check ran and emitted', () => {
  test('passed false, and the finding it carries is the whole answer', () => {
    const answer = lintOne(v1Only(), 'V2_HEADER_PRESENT');
    assert.equal(answer.applied, true);
    assert.equal(answer.passed, false);
    assert.equal(answer.checks_run, 1);
    assert.equal(answer.finding.code, 'V2_HEADER_PRESENT');
    assert.ok(answer.finding.fix.length > 40, 'the fix IS the product');
    assert.equal(answer.finding.severity, 'error');
  });

  test('the finding is byte-identical to the one the full report would carry', () => {
    // The cheap answer must be the SAME answer, not a summarised one. If these
    // ever diverge, the single-check price is buying a different product.
    const input = v1Only();
    const full = lint(input).findings.find((f) => f.code === 'V2_HEADER_PRESENT');
    assert.deepEqual(lintOne(input, 'V2_HEADER_PRESENT').finding, full);
  });

  test('one code emitting twice publishes both, because each has its own fix', () => {
    // Several checks reach a single code from branches that diagnose different
    // things. Dropping the second would hide a real fault behind a fixed one.
    const twoBadSchemes = v1Envelope();
    twoBadSchemes.accepts = [
      { ...twoBadSchemes.accepts[0], scheme: 'upto' },
      { ...twoBadSchemes.accepts[0], scheme: 'streaming' },
    ];
    const answer = lintOne(response({ v1: twoBadSchemes }), 'V1_SCHEME_KNOWN');
    assert.equal(answer.passed, false);
    assert.equal(answer.findings.length, 2, JSON.stringify(answer.findings, null, 2));
    assert.equal(answer.finding, answer.findings[0], '`finding` is the first of them, not a different object');
    assert.ok(answer.findings.every((f) => f.code === 'V1_SCHEME_KNOWN'));
  });
});

describe('lintOne: the check DID NOT APPLY — the outcome that is not a pass', () => {
  test('passed null, applied false, checks_run 0, and a note saying so', () => {
    const answer = lintOne(v1Only(), 'V2_B64_URLSAFE');
    assert.equal(answer.applied, false);
    assert.equal(answer.passed, null, 'a check that never ran must NEVER report true');
    assert.equal(answer.finding, null);
    assert.equal(answer.checks_run, 0, 'checks_run is how many APPLIED, on both report shapes');
    assert.match(answer.note, /did not apply/i);
    assert.match(answer.note, /NOT a pass/);
    assert.match(answer.note, /no v2 envelope/i);
  });

  test('a v1 check against a v2-only endpoint gets the mirror answer', () => {
    const answer = lintOne(response({ v2: v2Envelope(), bodyRaw: 'not an envelope' }), 'V1_PAYTO');
    assert.equal(answer.applied, false);
    assert.equal(answer.passed, null);
    assert.match(answer.note, /no v1 envelope/i);
  });

  test('a partial report explains itself in the note rather than reporting a pass', () => {
    // A 405 to this linter's POST carries no envelope, so no envelope check
    // ran. "V2_B64_URLSAFE passed" here would be a sentence about a response
    // nobody read.
    const answer = lintOne({ status: 405, headers: {}, body: '' }, 'V2_B64_URLSAFE');
    assert.equal(answer.applied, false);
    assert.equal(answer.passed, null);
    assert.match(answer.note, /405/);
    assert.equal(answer.summary.partial, lint({ status: 405, headers: {}, body: '' }).summary.partial);
  });

  test('every check in the catalogue can be asked about without throwing', () => {
    // A check whose id is published but whose lintOne answer explodes would be
    // a paid 500 on a route whose input is a public enum.
    for (const check of CHECKS) {
      const answer = lintOne(dual(), check.id);
      assert.equal(answer.check, check.id);
      assert.ok(
        answer.passed === true || answer.passed === false || answer.passed === null,
        `${check.id} answered ${JSON.stringify(answer.passed)}`
      );
      if (answer.applied === false) assert.ok(answer.note, `${check.id} did not apply and said nothing`);
    }
  });
});

describe('lintOne: what it deliberately does NOT include', () => {
  test('no bazaar_ready and no blockers — that verdict is a whole-report answer', () => {
    // Computed over EVERY bazaar-regime check. Publishing it beside one check
    // would hand over a whole-report verdict at the single-check price, and let
    // the blockers list imply the rest of the report.
    const answer = lintOne(v1Only(), 'V2_HEADER_PRESENT');
    assert.equal('bazaar_ready' in answer.summary, false);
    assert.equal('blockers' in answer.summary, false);
    assert.equal(answer.grade, undefined, 'a letter grade from one check would be a fabricated verdict');
    assert.equal(answer.findings, undefined, 'one finding, so no findings array');
  });

  test('but the envelope description stays, because it is context for the answer', () => {
    const answer = lintOne(dual(), 'V2_PAYTO');
    const full = lint(dual()).summary;
    assert.deepEqual(answer.summary.versions_detected, full.versions_detected);
    assert.equal(answer.summary.payTo, full.payTo);
    assert.equal(answer.summary.network, full.network);
    assert.equal(answer.summary.price, full.price);
  });
});

describe('lintOne: an unknown id is the caller’s mistake, and it throws here', () => {
  test('the engine refuses rather than inventing an answer', () => {
    // The Worker validates first and answers 400, refunding the payment claim.
    // Reaching this throw means that validation was removed, and a throw is the
    // right way to find that out.
    assert.throws(() => lintOne(dual(), 'V2_B64_URLSAF'), /unknown check id/);
    assert.throws(() => lintOne(dual(), ''), /unknown check id/);
  });
});

describe('the published samples are worked examples, computed by the real engine', () => {
  test('the live single-check sample names a real check and PASSES on the control', () => {
    const endpoint = ENDPOINTS_BY_ID.get('lint-one');
    assert.ok(CHECKS_BY_ID.has(endpoint.sample.check));
    const sample = runSample(endpoint);
    assert.equal(sample.check, endpoint.sample.check);
    assert.equal(sample.applied, true);
    assert.equal(sample.passed, true);
  });

  test('the pasted single-check sample shows a finding, with its fix', () => {
    const endpoint = ENDPOINTS_BY_ID.get('lint-envelope-one');
    assert.ok(CHECKS_BY_ID.has(endpoint.sample.check));
    const sample = runSample(endpoint);
    assert.equal(sample.check, endpoint.sample.check);
    assert.equal(sample.passed, false);
    assert.ok(sample.finding.fix);
  });

  test('the full-report samples are still full reports', () => {
    for (const id of ['lint', 'lint-envelope']) {
      const sample = runSample(ENDPOINTS_BY_ID.get(id));
      assert.ok(sample.grade, `${id} sample lost its grade`);
      assert.ok(Array.isArray(sample.findings));
      assert.equal(sample.check, undefined);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE PRICE SHEET
// ═══════════════════════════════════════════════════════════════════════════

describe('the eight prices, and the atomic math underneath them', () => {
  test('the sheet is what it is meant to be', () => {
    // WRITTEN OUT, not derived. A test that computed these from the same
    // constants the Worker reads would agree with any re-price, including one
    // nobody decided on.
    assert.deepEqual(
      Object.fromEntries(ENDPOINTS.map((e) => [e.path, e.price_usd])),
      {
        '/lint': 0.1,
        '/lint/one': 0.008,
        '/presence': 0.06,
        // The monitoring wing. $0.005 is the incumbent rater's own published
        // price for a rating read, matched deliberately; $0.03 and $0.12 are
        // the series and the dispute pack.
        '/monitor/verdict': 0.005,
        '/monitor/history': 0.03,
        '/monitor/receipt': 0.12,
        '/lint/envelope': 0.04,
        '/lint/envelope/one': 0.004,
      }
    );
  });

  test('dollars become atomic units of a 6-decimal USDC, exactly', () => {
    // $0.10 is 100000, NOT 10000. A missing zero here is a tenfold mispricing
    // that reads as plausible in every other assertion in this suite.
    assert.deepEqual(
      Object.fromEntries(ENDPOINTS.map((e) => [e.path, atomicAmount(e.price_usd)])),
      {
        '/lint': '100000',
        '/lint/one': '8000',
        '/presence': '60000',
        '/monitor/verdict': '5000',
        '/monitor/history': '30000',
        '/monitor/receipt': '120000',
        '/lint/envelope': '40000',
        '/lint/envelope/one': '4000',
      }
    );
    // Float division is not exact — 0.1 * 1e6 is 100000.00000000001 — so the
    // conversion has to round rather than truncate. This is that assertion.
    assert.equal(atomicAmount(0.1), '100000');
    assert.equal(atomicAmount(0.07), '70000');
  });

  test('a price never renders shorter than cents', () => {
    // "$0.1" on a sheet that also says "$0.02" is a 10x misread a buyer only
    // notices after paying.
    assert.deepEqual(
      ENDPOINTS.map((e) => priceLabel(e.price_usd)),
      ['$0.10', '$0.008', '$0.06', '$0.005', '$0.03', '$0.12', '$0.04', '$0.004']
    );
    assert.equal(priceLabel(0), 'free');
    assert.equal(priceLabel(0.005), '$0.005', 'sub-cent prices keep the digits they need');
  });
});

describe('the copy cannot drift from the sheet', () => {
  test('the batch multiple is derived from the prices, ONE PER RAIL', () => {
    // WRITTEN OUT, like the sheet itself. The rails genuinely differ — the full
    // report moved and the single checks did not — and a single averaged number
    // would be true of neither, which is worse than two numbers.
    assert.deepEqual(BATCH_MULTIPLES, { live: 12.5, pasted: 10 });

    for (const one of ENDPOINTS.filter((e) => e.single)) {
      const full = ENDPOINTS_BY_ID.get(one.pairedWith);
      assert.equal(railOf(full), railOf(one), `${one.path} is paired across rails`);
      assert.equal(
        Math.round((full.price_usd / one.price_usd) * 1000) / 1000,
        BATCH_MULTIPLES[railOf(one)],
        `${one.path} and ${full.path} disagree with their rail's published multiple`
      );
    }
  });

  test('EVERY PRICE ON THE SHEET IS UNIQUE, in dollars and in atomic units', () => {
    // THE AMOUNT IS THE ATTRIBUTION MECHANISM, and this is the assertion that
    // keeps it one. A settlement read from a bare chain explorer shows a
    // transfer amount and a payer; it does not show which route earned it. As
    // long as no two routes cost the same, every settlement is attributable to
    // its endpoint with no other data — no ledger, no logs, no correlation. The
    // day two routes share a price, that stops being true silently, and the
    // revenue records of both become guesses.
    //
    // Asserted in ATOMIC units as well as dollars because atomic is what
    // actually moves: two prices that differ in the seventh decimal would round
    // to one transfer amount, and it is the transfer an explorer shows.
    // (Sorted COPIES in the failure messages: Array#sort MUTATES, and sorting
    // `atomic` in place would misalign the index walk below — a test that fails
    // on the wrong endpoint while its message describes a real problem.)
    const dollars = ENDPOINTS.map((e) => e.price_usd);
    assert.equal(new Set(dollars).size, dollars.length, `duplicate price: ${[...dollars].sort().join(', ')}`);

    const atomic = ENDPOINTS.map((e) => atomicAmount(e.price_usd));
    assert.equal(new Set(atomic).size, atomic.length, `duplicate atomic amount: ${[...atomic].sort().join(', ')}`);

    // And every one is a positive whole number of atomic units. USDC has six
    // decimals, so a price finer than that is a price nobody can actually pay.
    for (const [i, endpoint] of ENDPOINTS.entries()) {
      assert.ok(Number(atomic[i]) > 0, `${endpoint.path} is priced at zero`);
      assert.equal(
        Number(atomic[i]),
        Math.round(endpoint.price_usd * 1e6),
        `${endpoint.path} is priced finer than USDC's six decimals`
      );
    }
  });

  test('a full report costs MORE than one check on its own rail', () => {
    // The invariant the catalogue asserts at module load, made visible: a rail
    // where this stopped holding would print a confident batch-advantage
    // sentence recommending the more expensive buy.
    for (const one of ENDPOINTS.filter((e) => e.single)) {
      const full = ENDPOINTS_BY_ID.get(one.pairedWith);
      assert.ok(full.price_usd > one.price_usd, `${full.path} does not cost more than ${one.path}`);
      assert.ok(BATCH_MULTIPLES[railOf(one)] > 1);
    }
  });

  test('the per-check advantage the copy claims is the catalogue divided by that rail', () => {
    // Six numbers, all computed: two multiples, two per-check advantages, two
    // crossover counts. A re-price or a new check rewrites the sentence instead
    // of falsifying it.
    // ROUNDED TO ONE DECIMAL, because it is a number inside a sentence and
    // "6.32x" is not how anybody says it. This assertion used to compare
    // against the RAW quotient, which passed only because 75 checks happened to
    // divide evenly by both rails — a coincidence that stopped holding the
    // moment the catalogue grew, and which until then would have hidden any
    // real rounding drift between the sheet and the copy. The rounding is
    // stated here now instead of being assumed away.
    const toOneDecimal = (n) => Math.round(n * 10) / 10;
    assert.equal(perCheckAdvantage(CHECKS.length, 'live'), toOneDecimal(CHECKS.length / BATCH_MULTIPLES.live));
    assert.equal(perCheckAdvantage(CHECKS.length, 'pasted'), toOneDecimal(CHECKS.length / BATCH_MULTIPLES.pasted));

    const line = batchAdvantageLine(CHECKS.length);
    assert.match(line, new RegExp(`A full ${CHECKS.length}-check report`));
    assert.match(line, new RegExp(`costs ${BATCH_MULTIPLES.live}x one check on a live URL`));
    assert.match(line, new RegExp(`${BATCH_MULTIPLES.pasted}x on a pasted response`));
    assert.match(
      line,
      new RegExp(
        `a ${perCheckAdvantage(CHECKS.length, 'live')}x and ` +
          `${perCheckAdvantage(CHECKS.length, 'pasted')}x per-check advantage`
      )
    );
    assert.match(line, new RegExp(`through ${singlesEdge('live')} questions live and ${singlesEdge('pasted')} pasted`));
  });

  test('the crossover the copy publishes is the one a calculator agrees with', () => {
    // THE NUMBER HAS TO SURVIVE BEING CHECKED. At `singlesEdge` singles are
    // strictly cheaper; one more and the full report is at least as cheap. A
    // crossover that flattered the report by one would be found by any buyer
    // who multiplied, and this is the assertion that stops it shipping.
    for (const rail of RAILS) {
      const one = ENDPOINTS.find((e) => e.single && railOf(e) === rail);
      const full = ENDPOINTS_BY_ID.get(one.pairedWith);
      const edge = singlesEdge(rail);
      assert.ok(edge * one.price_usd < full.price_usd, `${rail}: ${edge} singles are not cheaper than the report`);
      assert.ok(
        (edge + 1) * one.price_usd >= full.price_usd,
        `${rail}: ${edge + 1} singles are still cheaper — the published crossover is too low`
      );
    }
  });

  test('the pasted rail is cheaper than the live rail, at both scopes', () => {
    // The stated reason is a cost we do not incur — no outbound probe — so it
    // has to hold at BOTH scopes or the reason is decoration. It is no longer a
    // fixed fraction: the full report is priced for an incident and the single
    // check for CI, and those two moved apart.
    for (const [live, pasted] of [['lint', 'lint-envelope'], ['lint-one', 'lint-envelope-one']]) {
      assert.ok(
        ENDPOINTS_BY_ID.get(pasted).price_usd < ENDPOINTS_BY_ID.get(live).price_usd,
        `${pasted} is not cheaper than ${live}`
      );
      assert.equal(ENDPOINTS_BY_ID.get(live).fetches, true);
      assert.equal(ENDPOINTS_BY_ID.get(pasted).fetches, false);
    }
  });

  test('no hand-written surface still quotes a superseded price', () => {
    // The classic launch bug: the sheet moves and one file keeps the old
    // number. These four files type their prices as prose — nothing generates
    // them — so they are the ones that drift. $0.05 is the tell: it was a price
    // here and is now nobody's. ($0.10 is not a tell — it is still on the
    // sheet, on the other rail. $0.005 STOPPED being a tell when the monitoring
    // wing landed and took it as /monitor/verdict's price, deliberately
    // matching the incumbent rater's own published rate for a rating read.)
    for (const file of ['README.md', 'build.mjs', 'mcp/server.mjs', 'skills/10x402/SKILL.md', 'worker/catalog.js']) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      assert.ok(!text.includes('$0.05'), `${file} still quotes the superseded $0.05 price`);
    }

    // And the three that type their prices as PROSE — build.mjs generates every
    // one of its own from priceLabel() and so cannot drift — each name all four
    // of the prices actually on the sheet.
    for (const file of ['README.md', 'mcp/server.mjs', 'skills/10x402/SKILL.md']) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const endpoint of ENDPOINTS) {
        const price = priceLabel(endpoint.price_usd);
        assert.ok(text.includes(price), `${file} never mentions ${endpoint.path}'s ${price}`);
      }
    }
  });
});

describe('the deployed routes cover every path the catalogue sells', () => {
  test('wrangler.toml already publishes a pattern for all four', () => {
    // /lint/* was added long before /lint/one existed and covers it — a `*` in
    // a route pattern matches `/` too. That is a claim worth checking rather
    // than believing, because getting it wrong is a live 404 on a paid route
    // that every local test would still pass.
    const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
    const patterns = [...toml.matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((m) => m[1].replace(/^[^/]*/, ''));
    assert.ok(patterns.length >= 3, `no routes found in wrangler.toml: ${patterns}`);

    const covered = (path) =>
      patterns.some((pattern) => new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`).test(path));

    for (const endpoint of ENDPOINTS) {
      assert.ok(covered(endpoint.path), `${endpoint.path} is not covered by any route in wrangler.toml`);
    }
    assert.ok(covered('/check'), '/check is not covered');
    assert.ok(covered('/check?x=1'), 'a query string on /check is not covered');

    // The monitoring wing's FREE reads are not in the catalogue — nothing is
    // sold at them — and one of them has a DYNAMIC segment, so there is no
    // finite set of exact paths to enumerate. A pattern that covered the three
    // paid /monitor routes but not the host lookup would be a live 404 on the
    // free page every one of them points at.
    assert.ok(covered('/monitor'), 'the monitor index is not covered');
    assert.ok(covered('/monitor?x=1'), 'a query string on the monitor index is not covered');
    for (const host of ['socialx402.com', '0x07cf5359edb7d8de42973562c54e4c8d583c2396', 'a.very.long.sub.domain.example']) {
      assert.ok(covered(`/monitor/${host}`), `/monitor/${host} is not covered`);
    }

    assert.ok(!covered('/lintt'), 'the patterns match something they should not');
  });
});

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
