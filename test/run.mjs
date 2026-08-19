#!/usr/bin/env node
// `npm test` — the local suite runner.
//
// Two things make this a script rather than a bare `node --test test/`.
//
// 1. PHASES. Dev vars change the product's answer, and a dev var is fixed for
//    the life of a `wrangler dev` process, so each configuration needs its own
//    worker:
//
//      FREE_TIER_DAILY      unset (production) = every call is a paid call and
//                           the FIRST unauthenticated call is the 402.
//      PAYTO                unset = 429 where a 402 would otherwise go.
//      LINT_UNSAFE_TARGETS  unset (production) = /lint refuses private and
//                           non-https targets. Set only in the phase that
//                           points /lint at a mock target on 127.0.0.1.
//
// 2. ONE WORKER PER PHASE. Booting is the expensive part, and a shared instance
//    is safe because every suite addresses its own band of `cf-connecting-ip`
//    (SUITE_OCTET in harness.mjs). Suites run with --test-concurrency=1 so the
//    tests that count D1 rows can compare a before and an after.
//
// PHASE 1 BOOTS NOTHING AT ALL. The lint engine, the JSON Schema subset and the
// SSRF URL rules are pure functions, so they are tested as pure functions —
// hundreds of assertions in a hundred milliseconds, with no server to be flaky.
// It runs FIRST on purpose: if the engine is wrong, every later phase is
// measuring the wrong thing, and finding that out in 0.1s beats finding it out
// after four worker boots.
//
// Nothing here touches the network beyond localhost, and each phase gets a
// fresh temporary D1 that is deleted on teardown. Run one file on its own with
// `node --test test/check.test.mjs` — the file boots its own worker when the
// runner has not already exported one.

import { spawn } from 'node:child_process';
import { bootWorker, PAYTO_TEST, TIER_ON_VARS, UNSAFE_TARGET_VARS, varsKey } from './harness.mjs';

const PHASES = [
  {
    // No worker. Pure functions only — see the note above.
    name: 'engine (no worker: pure functions)',
    pure: true,
    files: [
      'test/json-schema.test.mjs',
      'test/lint-engine.test.mjs',
      'test/positive-control.test.mjs',
      'test/ssrf-rules.test.mjs',
    ],
  },
  {
    // A free tier so calls are actually SERVED. With no facilitator and no
    // wallet in the loop, that is the only way to get past the 402 front door,
    // and these suites are about what comes back AFTER it.
    //
    // LINT_UNSAFE_TARGETS is deliberately NOT set here: /lint's refusals are
    // asserted against the SHIPPED guard, so those assertions mean something.
    name: `served calls (FREE_TIER_DAILY=${TIER_ON_VARS.FREE_TIER_DAILY}, production SSRF guard)`,
    vars: TIER_ON_VARS,
    files: ['test/check.test.mjs', 'test/lint-envelope.test.mjs', 'test/ssrf-worker.test.mjs'],
  },
  {
    // The only phase where the guard is relaxed, and the only one that makes an
    // outbound request at all — to mock target servers this process runs on
    // 127.0.0.1. It is a separate phase precisely so the relaxation cannot leak
    // into a suite that is asserting the guard holds.
    name: 'outbound lint (mock targets, SSRF guard relaxed)',
    vars: { ...TIER_ON_VARS, ...UNSAFE_TARGET_VARS },
    files: ['test/lint-http.test.mjs'],
  },
  {
    // THE PRODUCTION CONFIGURATION: no free tier, a receiving address set. The
    // first unauthenticated call is the 402 — which is both the product's front
    // door and the thing a discovery index probes for. self-lint runs here and
    // nowhere else: the invariant is about what this service SHIPS.
    name: 'production default (free tier off, PAYTO set)',
    vars: { PAYTO: PAYTO_TEST },
    files: ['test/x402.test.mjs', 'test/self-lint.test.mjs'],
  },
  {
    // STANDALONE, and it has to be: this suite runs a mock facilitator on a
    // port it only learns at startup, so FACILITATOR_URL cannot be known out
    // here. The file boots its own worker, on its own fresh D1.
    name: 'settlement (PAYTO + mock facilitator)',
    standalone: true,
    files: ['test/x402-settlement.test.mjs'],
  },
  {
    // STANDALONE for the same reason, twice over: a mock facilitator AND a mock
    // Telegram, both on ports learned at startup.
    name: 'alerts (mock facilitator + mock Telegram)',
    standalone: true,
    files: ['test/alerts.test.mjs'],
  },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const totals = { tests: 0, pass: 0, fail: 0, skipped: 0 };
const perPhase = [];
let failed = false;

for (const phase of PHASES) {
  const files = only.length ? phase.files.filter((f) => only.some((o) => f.includes(o))) : phase.files;
  if (!files.length) continue;

  process.stdout.write(`\n── phase: ${phase.name} ── ${files.length} file(s)\n`);
  const before = { ...totals };

  if (phase.pure) {
    process.stdout.write('   no worker: these are pure functions\n\n');
    if ((await runNodeTest(files, {})) !== 0) failed = true;
  } else if (phase.standalone) {
    process.stdout.write('   the suite boots its own worker\n\n');
    // Nothing is exported into the child, so a bootWorker() inside the file
    // cannot accidentally join a worker left over from an earlier phase.
    if ((await runNodeTest(files, {})) !== 0) failed = true;
  } else {
    const worker = await bootWorker({ vars: phase.vars });
    process.stdout.write(`   worker on ${worker.baseUrl}, fresh D1 at ${worker.persistDir}\n\n`);
    try {
      const code = await runNodeTest(files, {
        TENX402_TEST_URL: worker.baseUrl,
        // The WHOLE var set, canonically ordered: useWorker() joins this worker
        // only when the config it asked for is the config that was booted.
        TENX402_TEST_VARS: varsKey(phase.vars),
        TENX402_TEST_PERSIST: worker.persistDir,
      });
      if (code !== 0) failed = true;
    } finally {
      await worker.stop();
    }
  }

  perPhase.push({ name: phase.name, tests: totals.tests - before.tests, fail: totals.fail - before.fail });
}

process.stdout.write('\n══ by phase ══\n');
for (const p of perPhase) {
  process.stdout.write(`   ${String(p.tests).padStart(4)} tests${p.fail ? `  (${p.fail} FAILED)` : ''}  ${p.name}\n`);
}
process.stdout.write(
  `\n══ total: ${totals.pass} passed, ${totals.fail} failed` +
    `${totals.skipped ? `, ${totals.skipped} skipped` : ''} of ${totals.tests} tests ══\n`
);
process.exit(failed || totals.fail > 0 ? 1 : 0);

// ------------------------------------------------------------------ helpers

function runNodeTest(files, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files],
      { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] }
    );

    let tail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      tail = (tail + chunk).slice(-4000);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      // The spec reporter's summary block, e.g. "ℹ pass 128". Parsed so the
      // phases can be added up into one line at the end.
      for (const key of ['tests', 'pass', 'fail', 'skipped']) {
        const match = tail.match(new RegExp(`^[^\\w\\n]*${key}\\s+(\\d+)\\s*$`, 'm'));
        if (match) totals[key] += Number(match[1]);
      }
      resolve(code ?? 1);
    });
  });
}
