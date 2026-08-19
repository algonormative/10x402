// THE POSITIVE CONTROL. Pure, no worker.
//
// Every other test in the engine phase proves a check FIRES. This one proves
// the checks stay quiet on a response that is actually correct — and it does it
// against a real 402 captured from a live production seller, headers and
// encodings and field ordering and all, rather than against something this repo
// wrote itself.
//
// It is here because the failure mode it guards is the one that would kill this
// product quietly: a linter that grades every stranger's endpoint an F is
// indistinguishable, from the outside, from a linter that has found something.
// Ground the measurement on a known-good before trusting any negative verdict.
//
// If this ever fails, the order to investigate in is: (1) this engine got
// stricter than the spec, (2) a new check is wrong, (3) — last, and only with
// evidence — the upstream seller regressed. The fixture is frozen, so option 3
// cannot be caused by anything happening today.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lint } from '../worker/lint.js';
import { POSITIVE_CONTROL } from '../worker/positive-control.js';

const asInput = () => ({
  status: POSITIVE_CONTROL.status,
  headers: POSITIVE_CONTROL.headers,
  body: POSITIVE_CONTROL.body,
  url: POSITIVE_CONTROL.url,
  method: POSITIVE_CONTROL.method,
});

describe('a real production 402', () => {
  test('grades A with zero findings', () => {
    const report = lint(asInput());
    assert.deepEqual(
      report.findings,
      [],
      `the positive control produced findings — this engine is probably stricter than the spec:\n${JSON.stringify(report.findings, null, 2)}`
    );
    assert.equal(report.grade, 'A');
  });

  test('runs a substantial share of the catalogue on it', () => {
    // A clean report from three checks would be meaningless. This is the
    // assertion that the A was earned across the whole surface.
    const report = lint(asInput());
    assert.ok(report.checks_run >= 45, `only ${report.checks_run} checks applied`);
  });

  test('reads both versions off one response', () => {
    const report = lint(asInput());
    assert.deepEqual(report.summary.versions_detected, [1, 2]);
  });

  test('reads the terms out of the envelope', () => {
    const report = lint(asInput());
    assert.match(report.summary.payTo, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(report.summary.network, 'eip155:8453');
    assert.equal(report.summary.price, '$0.001 (1000 atomic)');
  });
});

describe('the fixture itself', () => {
  test('is a real capture, not something this repo wrote', () => {
    assert.match(POSITIVE_CONTROL.captured, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(POSITIVE_CONTROL.url, /^https:\/\//);
    assert.equal(POSITIVE_CONTROL.status, 402);
  });

  test('its v2 header really is standard base64', () => {
    // The thing V2_B64_URLSAFE is about, asserted directly on real production
    // bytes rather than only on a constructed fixture.
    const header = POSITIVE_CONTROL.headers['payment-required'];
    assert.ok(header, 'no v2 header in the capture');
    assert.match(header, /^[A-Za-z0-9+/]*={0,2}$/);
    assert.ok(!/[-_]/.test(header), 'the capture contains base64url characters');
  });

  test('breaking one byte of it produces exactly the finding it should', () => {
    // VERIFY THE VERIFIER. A control that only ever passes proves the code
    // path runs, not that it discriminates — so the same real response is
    // damaged in one specific way and the engine has to notice.
    const broken = asInput();
    broken.headers = {
      ...broken.headers,
      'payment-required': broken.headers['payment-required'].replace(/\//g, '_').replace(/\+/g, '-'),
    };
    const before = POSITIVE_CONTROL.headers['payment-required'];
    assert.notEqual(broken.headers['payment-required'], before, 'the damage was a no-op');

    const report = lint(broken);
    assert.deepEqual(report.findings.map((f) => f.code), ['V2_B64_URLSAFE']);
    assert.equal(report.grade, 'F');
  });
});
