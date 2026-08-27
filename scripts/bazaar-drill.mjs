#!/usr/bin/env node
//
//  ┌──────────────────────────────────────────────────────────────────────┐
//  │  THIS SCRIPT SPENDS REAL MONEY — up to $0.50 USDC per full run.      │
//  │                                                                      │
//  │  One paid call per named endpoint, from the HOUSE buyer wallet, to   │
//  │  keep this service's rows alive in the CDP Bazaar. It refuses to do  │
//  │  anything without --yes, and --dry-run needs no key at all.          │
//  │                                                                      │
//  │  FOR THE OWNER TO RUN, DELIBERATELY. Not for CI, not for a routine,  │
//  │  not for an agent on its own initiative.                             │
//  └──────────────────────────────────────────────────────────────────────┘
//
// WHY THIS EXISTS. Bazaar discovery rows are written by SETTLEMENT, not by
// deployment — our own guide (guides/bazaar-not-indexed) documents the
// mechanic, and the 2026-08-27 audit measured the consequence: of five paid
// resources, exactly the two with recent third-party settlements held rows
// (each row's lastUpdated equal to our latest sale on it, to the second), and
// the three without recent settlements had NO row among ~3,000 scanned. No
// settlement → not listed → not discoverable → no settlement. This script is
// the documented cure: one small self-test buy per absent endpoint.
//
// WHY THIS IS A DRILL AND NOT A WASH TRADE. The buyer address is published in
// wrangler.toml as HOUSE_PAYERS, precisely so the house's own test buys read
// as drills in the ledger and the alerts — disclosed, not disguised. It buys
// an index row, and index rows are written by the facilitator observing a
// settlement, which is the mechanism's design. It cannot buy a rating:
// adoption-scored raters (agenteconomy.report and kin) are sybil-resistant
// and score ORGANIC payers, which a declared house wallet is not and should
// never appear to be. Campaign ledger: tradewind campaign/experiments.md E7.
//
//   node scripts/bazaar-drill.mjs --dry-run          # free: plan + live 402s
//   node scripts/bazaar-drill.mjs --yes              # spends: one buy per endpoint
//   node scripts/bazaar-drill.mjs --yes --only lint  # just one endpoint
//
// The key: .buyer.env in this directory's parent (BUYER_PRIVATE_KEY=0x…), or
// point --env at the house key, which lives with the sibling service's drill
// tooling. The exact scheme pays by EIP-3009 signed authorization and the
// FACILITATOR submits the transaction — the buyer key needs USDC and no ETH.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = 'https://10x402.com';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DRY_RUN = flag('dry-run');
const YES = flag('yes');
const ONLY = value('only', null);
const ENV_PATH = value('env', join(ROOT, '.buyer.env'));

// The default set is THE THREE THE AUDIT FOUND MISSING. The two single-check
// routes are deliberately absent: third-party traffic keeps their rows alive,
// and a drill's job is to cover what organic settlement does not.
const DRILLS = [
  { id: 'lint', path: '/lint', price: '$0.25' },
  { id: 'lint-envelope', path: '/lint/envelope', price: '$0.10' },
  { id: 'presence', path: '/presence', price: '$0.15' },
];

const targets = ONLY ? DRILLS.filter((d) => d.id === ONLY) : DRILLS;
if (!targets.length) {
  console.error(`--only ${ONLY} names no drill. Choices: ${DRILLS.map((d) => d.id).join(', ')}`);
  process.exit(1);
}

if (!DRY_RUN && !YES) {
  console.error(`
  This script spends real USDC (up to $0.50 for the default set), one paid
  call per endpoint, to restore this service's Bazaar discovery rows.

    node scripts/bazaar-drill.mjs --dry-run   # see the plan, spend nothing
    node scripts/bazaar-drill.mjs --yes       # do it
`);
  process.exit(1);
}

// The sample INPUT for each endpoint comes from the live catalogue — the same
// documented body every reader of GET /check sees, so a drill is a real,
// servable request and never a 400 (which would settle nothing and list
// nothing).
const check = await fetch(`${BASE}/check`);
if (check.status !== 200) {
  console.error(`GET /check answered ${check.status} — not drilling against a service in that state.`);
  process.exit(1);
}
const catalogue = await check.json();
const sampleFor = (path) => catalogue.endpoints.find((e) => e.path === path)?.sample;

let payFetch = null;
if (!DRY_RUN) {
  let privateKeyToAccount, wrapFetchWithPayment;
  try {
    ({ privateKeyToAccount } = await import('viem/accounts'));
    ({ wrapFetchWithPayment } = await import('x402-fetch'));
  } catch (err) {
    console.error(`Missing a client dependency (${err.message}).\n\nviem and x402-fetch are devDependencies:\n\n  npm install\n`);
    process.exit(1);
  }
  if (!existsSync(ENV_PATH)) {
    console.error(`No buyer key at ${ENV_PATH}.\n\nPoint --env at the house .buyer.env (it lives with the sibling service's\ndrill tooling), or create one and fund it with ~$1 USDC on Base.`);
    process.exit(1);
  }
  const env = Object.fromEntries(
    readFileSync(ENV_PATH, 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
  );
  if (!env.BUYER_PRIVATE_KEY) {
    console.error(`${ENV_PATH} has no BUYER_PRIVATE_KEY.`);
    process.exit(1);
  }
  const account = privateKeyToAccount(env.BUYER_PRIVATE_KEY);
  console.log(`\n  buyer   ${account.address}  (must be listed in wrangler.toml HOUSE_PAYERS)`);
  payFetch = wrapFetchWithPayment(fetch, account);
}

console.log(`  mode    ${DRY_RUN ? 'DRY RUN — nothing will be spent' : 'LIVE — this spends real USDC'}
  drills  ${targets.map((d) => `${d.path} (${d.price})`).join(', ')}
`);

for (const drill of targets) {
  const body = sampleFor(drill.path);
  if (!body) {
    console.error(`  ${drill.path}: the live catalogue publishes no sample — stopping before anything is spent.`);
    process.exit(1);
  }
  const input = JSON.stringify(body);

  // The free look first, every time: the 402 proves the paywall is up and the
  // envelope parseable BEFORE any signature exists. 429 means no PAYTO; 200
  // means a free tier is on — both are states a drill must refuse to touch.
  const probe = await fetch(`${BASE}${drill.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: input,
  });
  if (probe.status !== 402) {
    console.error(`  ${drill.path}: expected 402 on the unpaid call, got ${probe.status}. Nothing spent. Stopping.`);
    process.exit(1);
  }
  console.log(`  ${drill.path}  402 ✓ envelope up`);

  if (DRY_RUN) continue;

  const paid = await payFetch(`${BASE}${drill.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: input,
  });
  const verified = paid.headers.get('x-payment-verified');
  const text = await paid.text();
  if (paid.status !== 200 || verified !== 'true') {
    console.error(`  ${drill.path}: paid call answered ${paid.status}, x-payment-verified=${verified}.
    A non-200 settles nothing (the claim is released), so at most one price is
    in flight. Body: ${text.slice(0, 200)}
    Stopping.`);
    process.exit(1);
  }
  let signal = '';
  try {
    const r = JSON.parse(text);
    signal = r.grade ? `grade ${r.grade}` : r.registries ? 'presence report' : 'report';
  } catch { /* the receipt printed enough */ }
  console.log(`  ${drill.path}  PAID ✓ 200, x-payment-verified: true — ${signal}`);
}

console.log(`
  ${DRY_RUN ? 'Dry run complete: every envelope is up and payable. Re-run with --yes.' : `Done. Settlement lands in the D1 ledger (verify_ok/settle_ok) and the
  Bazaar crawl typically follows in ~2–11 minutes. Re-scan the discovery
  API for all five resources before calling E7 supported.`}
`);
