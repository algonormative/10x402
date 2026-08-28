// POST /presence against mock registries. Same posture as lint-http: the
// target is a local server serving the suite's own fixture envelopes, and the
// four registry surfaces — Bazaar, x402scan, the EVM explorer and the Solana
// RPC — are local mocks whose base URLs ride in through the PRESENCE_*_BASE
// vars, the same seam production uses, pointed at 127.0.0.1. Tests never touch
// the live registries and never reach a public chain RPC.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { callers, client, TIER_ON_VARS, UNSAFE_TARGET_VARS, useWorker } from './harness.mjs';
import { response, v1Envelope, v2Envelope, PAYTO, RESOURCE_URL } from './fixtures/envelopes.mjs';
import { extractIdentity, assemblePresence, payToFamily } from '../worker/presence.js';
import { PRESENCE_CONTROL } from '../worker/presence-control.js';

const ips = callers('presence');
let worker;
let api;
let target;
let registries;

/** The seller under test: answers the canned 402, 404s everything else. */
async function startTarget() {
  const state = { next: null, hits: [] };
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      state.hits.push({ method: req.method, url: req.url });
      const canned = state.next || { status: 404, headers: {}, body: '{}' };
      res.writeHead(canned.status, canned.headers || {});
      res.end(canned.body ?? '');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    url: (path = '/api') => `http://127.0.0.1:${port}${path}`,
    serve: (r) => (state.next = { status: r.status, headers: r.headers, body: r.body }),
    reset: () => ((state.next = null), (state.hits.length = 0)),
    stop: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))),
  };
}

/**
 * One mock for all FOUR registry surfaces, routed by path — the vars all
 * point at the same server, which also proves the module reads its base per
 * surface rather than assuming a shared host layout.
 *
 * The Solana leg is a JSON-RPC POST rather than a GET, so its request body is
 * kept whole: what the module ASKS is half of what this suite asserts, and a
 * mock that only ever answered would let the method name or the limit drift
 * without a single test noticing.
 */
async function startRegistries() {
  const state = {
    // The catalog as pages WOULD be served: items() is called with the offset
    // so a test can prove the pagination loop really advances.
    bazaarTotal: 0,
    bazaarItems: () => [],
    bazaarStatus: 200,
    scanRecord: null,
    scanStatus: 200,
    chainRows: [],
    chainStatus: 200,
    // One-shot statuses consumed before chainStatus — lets a test serve
    // "429 then 200" without property tricks.
    chainStatuses: [],
    // The Solana JSON-RPC leg. `solanaError` is served INSIDE a 200, which is
    // how JSON-RPC reports failure and is a case the EVM leg has no analogue of.
    solanaRows: [],
    solanaStatus: 200,
    solanaStatuses: [],
    solanaError: null,
    // Every JSON-RPC request, parsed: { method, headers, body }.
    solanaRequests: [],
    hits: [],
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      state.hits.push(req.url);
      const answer = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/platform/v2/x402/discovery/resources') {
        if (state.bazaarStatus !== 200) return answer(state.bazaarStatus, {});
        const offset = Number(url.searchParams.get('offset') || 0);
        const limit = Number(url.searchParams.get('limit') || 0);
        return answer(200, {
          items: state.bazaarItems(offset),
          pagination: { limit, offset, total: state.bazaarTotal },
        });
      }
      if (url.pathname === '/api/trpc/public.resources.getResourceByAddress') {
        if (state.scanStatus !== 200) return answer(state.scanStatus, {});
        return answer(200, { result: { data: { json: state.scanRecord } } });
      }
      if (url.pathname === '/api') {
        const status = state.chainStatuses.length ? state.chainStatuses.shift() : state.chainStatus;
        if (status !== 200) return answer(status, {});
        return answer(200, { status: '1', message: 'OK', result: state.chainRows });
      }
      // The Solana RPC. A PATH on purpose: PRESENCE_SOLANA_BASE is the whole
      // endpoint URL, not a host to hang a path off, and serving it from
      // /solana proves the module posts to the var VERBATIM instead of
      // appending something the way the other three legs do.
      if (url.pathname === '/solana') {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          /* recorded as null; a test asserting on the body will say so */
        }
        state.solanaRequests.push({ method: req.method, headers: req.headers, body });
        const status = state.solanaStatuses.length ? state.solanaStatuses.shift() : state.solanaStatus;
        if (status !== 200) return answer(status, {});
        const id = body?.id ?? 1;
        if (state.solanaError) return answer(200, { jsonrpc: '2.0', id, error: state.solanaError });
        return answer(200, { jsonrpc: '2.0', id, result: state.solanaRows });
      }
      return answer(404, { error: 'no such surface' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    base: `http://127.0.0.1:${port}`,
    reset() {
      state.bazaarTotal = 0;
      state.bazaarItems = () => [];
      state.bazaarStatus = 200;
      state.scanRecord = null;
      state.scanStatus = 200;
      state.chainRows = [];
      state.chainStatus = 200;
      state.chainStatuses.length = 0;
      state.solanaRows = [];
      state.solanaStatus = 200;
      state.solanaStatuses.length = 0;
      state.solanaError = null;
      state.solanaRequests.length = 0;
      state.hits.length = 0;
    },
    stop: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))),
  };
}

const bazaarItemFor = (url, payTo = PAYTO) => ({
  resource: url,
  x402Version: 2,
  lastUpdated: '2026-08-21T00:00:00.000Z',
  accepts: [{ payTo }],
});

// ------------------------------------------------------------------ the Solana fixtures
//
// A base58 payTo, and the envelope that declares it. The address is the one
// test/calibration.test.mjs already uses for its spec-conformant Solana
// envelope — taken from the `exact` scheme's own SVM PaymentRequirements
// (specs/schemes/exact/scheme_exact_svm.md:53-68) — so the two suites are
// talking about the same wallet, and the CAIP-2 network string is the mainnet
// one from worker/lint.js's own table.
//
// THE ENVELOPE IS BUILT HERE rather than in test/fixtures/envelopes.mjs because
// nothing about a GRADE is being asserted: this file only cares which chain
// reader the address shape selects. The network is moved along with the payTo
// so the fixture is not a contradiction, but the dispatch never reads it — that
// is the point of dispatching on shape, and one of the tests below proves it.
const SOLANA_PAYTO = '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4';
const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function solanaV2Envelope(payTo = SOLANA_PAYTO) {
  const v2 = v2Envelope();
  v2.accepts[0].network = SOLANA_MAINNET;
  v2.accepts[0].payTo = payTo;
  v2.accepts[0].asset = USDC_SOLANA;
  return v2;
}

/**
 * One row of getSignaturesForAddress.
 *
 * `err` defaults to null (a landed transaction) and is set by the test that
 * cares. The field names are the RPC's own — `blockTime` in UNIX seconds,
 * `confirmationStatus` — so a rename on the reading side cannot pass here.
 */
const signatureRow = ({
  signature = 'sig' + '1'.repeat(60),
  blockTime = 1787000000,
  err = null,
  slot = 291470237,
} = {}) => ({
  signature,
  slot,
  err,
  memo: null,
  blockTime,
  confirmationStatus: 'finalized',
});

const chainRowTo = (payTo) => ({
  value: '150000',
  tokenSymbol: 'USDC',
  timeStamp: '1787000000',
  hash: '0x' + 'ab'.repeat(32),
  from: '0x' + '11'.repeat(20),
  to: payTo.toLowerCase(),
  contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
});

before(async () => {
  target = await startTarget();
  registries = await startRegistries();
  worker = await useWorker({
    vars: {
      ...TIER_ON_VARS,
      ...UNSAFE_TARGET_VARS,
      PRESENCE_BAZAAR_BASE: registries.base,
      PRESENCE_SCAN_BASE: registries.base,
      PRESENCE_CHAIN_BASE: registries.base,
      PRESENCE_SOLANA_BASE: `${registries.base}/solana`,
    },
  });
  api = client(worker);
});
after(async () => {
  await worker?.stop();
  await target?.stop();
  await registries?.stop();
});

const presence = () => api.post('/presence', { url: target.url() }, { ip: ips.next() });

describe('POST /presence', () => {
  test('listed everywhere: three verdicts, each carrying its evidence', async () => {
    target.reset();
    registries.reset();
    target.serve(response({ v1: v1Envelope(), v2: v2Envelope() }));
    // The fixture declares RESOURCE_URL in its envelope; the catalog row is
    // written under that declared spelling, not the probed 127.0.0.1 URL —
    // which is exactly the apex-vs-www class of situation the dual search is
    // for, so this test is also the proof the declared URL is searched.
    registries.state.bazaarTotal = 1;
    registries.state.bazaarItems = () => [bazaarItemFor(RESOURCE_URL)];
    registries.state.scanRecord = {
      resource: RESOURCE_URL,
      method: 'POST',
      x402Version: 2,
      lastUpdated: '2026-08-21T00:00:00.000Z',
    };
    registries.state.chainRows = [chainRowTo(PAYTO)];

    const res = await presence();
    assert.equal(res.status, 200, res.text);
    const r = res.body;
    assert.equal(r.registries.bazaar.verdict, 'listed');
    assert.equal(r.registries.bazaar.evidence.matches[0].resource, RESOURCE_URL);
    assert.equal(r.registries.x402scan.verdict, 'listed');
    assert.equal(r.onchain.verdict, 'active');
    assert.equal(r.onchain.evidence.latest.tokenSymbol, 'USDC');
    assert.deepEqual(r.summary, { listed: 2, of: 2, unknown: 0, settlement_seen: true });
    assert.equal(r.identity.payTo[0], PAYTO);
  });

  test('nowhere: not_found verdicts carry the way in, never a bare no', async () => {
    target.reset();
    registries.reset();
    target.serve(response({ v1: v1Envelope(), v2: v2Envelope() }));
    registries.state.bazaarTotal = 1;
    registries.state.bazaarItems = () => [bazaarItemFor('https://someone-else.example/api', '0x' + '99'.repeat(20))];

    const res = await presence();
    assert.equal(res.status, 200, res.text);
    const r = res.body;
    assert.equal(r.registries.bazaar.verdict, 'not_found');
    assert.match(r.registries.bazaar.fix, /written by SETTLEMENT/);
    assert.equal(r.registries.x402scan.verdict, 'not_found');
    assert.match(r.registries.x402scan.fix, /resources\/register/);
    assert.equal(r.onchain.verdict, 'none_seen');
    assert.match(r.onchain.fix, /different address/);
    assert.deepEqual(r.summary, { listed: 0, of: 2, unknown: 0, settlement_seen: false });
  });

  test('the catalog scan really pages: the match on page two is found', async () => {
    target.reset();
    registries.reset();
    target.serve(response({ v1: v1Envelope(), v2: v2Envelope() }));
    registries.state.bazaarTotal = 1001; // two pages at the production page size
    registries.state.bazaarItems = (offset) =>
      offset === 0
        ? Array.from({ length: 1000 }, (_, i) => bazaarItemFor(`https://filler.example/${i}`, '0x' + '22'.repeat(20)))
        : [bazaarItemFor(RESOURCE_URL)];

    const res = await presence();
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.registries.bazaar.verdict, 'listed');
    const pages = registries.state.hits.filter((h) => h.includes('/discovery/resources'));
    assert.equal(pages.length, 2, pages.join('\n'));
  });

  test('a registry that cannot be read is unknown, and only that registry', async () => {
    target.reset();
    registries.reset();
    target.serve(response({ v1: v1Envelope(), v2: v2Envelope() }));
    registries.state.bazaarStatus = 500;
    registries.state.scanRecord = { resource: RESOURCE_URL, method: 'POST', x402Version: 2, lastUpdated: null };
    registries.state.chainRows = [chainRowTo(PAYTO)];

    const res = await presence();
    assert.equal(res.status, 200, res.text);
    const r = res.body;
    assert.equal(r.registries.bazaar.verdict, 'unknown');
    assert.match(r.registries.bazaar.why, /answered 500/);
    assert.equal(r.registries.bazaar.fix, null, 'an unreadable surface must not hand out a fix');
    assert.equal(r.registries.x402scan.verdict, 'listed');
    assert.equal(r.onchain.verdict, 'active');
    assert.equal(r.summary.unknown, 1);
  });

  test('an unreadable chain makes settlement_seen null — a non-claim, not a no', async () => {
    // The first production presence call hit a Blockscout 429. `false` would
    // have said "nothing has settled here"; the explorer said no such thing.
    target.reset();
    registries.reset();
    target.serve(response({ v1: v1Envelope(), v2: v2Envelope() }));
    registries.state.chainStatus = 500;

    const res = await presence();
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.onchain.verdict, 'unknown');
    assert.equal(res.body.summary.settlement_seen, null);
  });

  test('a chain 429 is retried once, and the retry answer stands', async () => {
    target.reset();
    registries.reset();
    target.serve(response({ v1: v1Envelope(), v2: v2Envelope() }));
    registries.state.chainRows = [chainRowTo(PAYTO)];
    registries.state.chainStatuses.push(429);

    const res = await presence();
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.onchain.verdict, 'active', JSON.stringify(res.body.onchain));
    const chainHits = registries.state.hits.filter((h) => h.startsWith('/api?'));
    assert.equal(chainHits.length, 2, 'the 429 was not retried exactly once');
  });

  test('a target with no readable payTo is a refusal that points at /lint', async () => {
    target.reset();
    registries.reset();
    target.serve({ status: 402, headers: { 'content-type': 'text/html' }, body: '<html>pay me</html>' });

    const res = await presence();
    assert.equal(res.status, 400, res.text);
    assert.match(res.body.error, /no readable payTo/);
    assert.match(res.body.fix, /POST \/lint/);
    // And no registry was asked about a target we could not identify.
    assert.equal(registries.state.hits.length, 0, registries.state.hits.join('\n'));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The Solana chain leg
// ═══════════════════════════════════════════════════════════════════════
//
// WHAT WAS WRONG. The chain leg was hardcoded to Blockscout's EVM tokentx and
// lowercase-compared 0x addresses, so a Solana seller's base58 payTo went into
// `address=` anyway, matched nothing, and rendered as `none_seen` — "no USDC
// transfers to this payTo were observed on Base" — about a wallet that has
// never been on Base. A whole chain family got a confident wrong answer from
// the endpoint whose entire job is evidence.
//
// WHAT THESE ASSERT. Two halves, and the second is the one worth the tests: the
// right surface is called with the right question, AND what comes back is
// reported as what it actually is. Signatures are not transfers, so the whole
// vocabulary of the EVM leg — transfer, tokenSymbol, value, "settled" — is
// wrong here, and one test below reads the serialised report to prove none of
// it leaked across.

describe('POST /presence on a Solana payTo', () => {
  const servePresence = async ({ rows = [], payTo = SOLANA_PAYTO } = {}) => {
    target.reset();
    registries.reset();
    target.serve(response({ v2: solanaV2Envelope(payTo) }));
    registries.state.solanaRows = rows;
    const res = await presence();
    assert.equal(res.status, 200, res.text);
    return res.body;
  };

  test('the base58 payTo is asked of Solana, with the request this leg documents', async () => {
    const r = await servePresence({ rows: [signatureRow()] });

    assert.equal(registries.state.solanaRequests.length, 1, 'the Solana RPC was not called exactly once');
    const [asked] = registries.state.solanaRequests;
    assert.equal(asked.method, 'POST');
    assert.equal(asked.headers['content-type'], 'application/json');
    assert.equal(asked.headers.accept, 'application/json');
    // The same identity every other read in this module sends: a rate limiter
    // deciding to throttle us should be looking at ONE caller, not four.
    assert.equal(asked.headers['user-agent'], '10x402-presence/0.1 (+https://10x402.com)');
    assert.equal(asked.body.jsonrpc, '2.0');
    assert.equal(asked.body.method, 'getSignaturesForAddress');
    assert.deepEqual(asked.body.params, [SOLANA_PAYTO, { limit: 25 }]);

    // And the EVM explorer was never asked about an address that is not on it.
    assert.deepEqual(
      registries.state.hits.filter((h) => h.startsWith('/api?')),
      []
    );
    assert.equal(r.onchain.verdict, 'active');
    assert.equal(r.onchain.evidence.signatures_in_window, 1);
  });

  test('the evidence says it measured activity, and borrows no transfer language', async () => {
    const r = await servePresence({ rows: [signatureRow()] });

    assert.match(r.onchain.evidence.source, /Solana/);
    assert.match(r.onchain.evidence.source, /getSignaturesForAddress/);
    assert.match(r.onchain.evidence.measures, /signatures/i);
    assert.match(r.onchain.evidence.measures, /[Nn]ot incoming payments/);
    assert.match(r.onchain.evidence.window, /signatures/);
    // The EVM field names must not appear under any spelling.
    assert.equal(r.onchain.evidence.incoming_transfers_in_window, undefined);
    // THE WHOLE ONCHAIN BLOCK, READ AS TEXT. A field renamed honestly but
    // described in borrowed prose would pass every assertion above. `transfer`
    // is banned outright; `failed_transactions_in_window` is the near miss the
    // ban must not catch, and does not — a transaction is not a transfer.
    const asText = JSON.stringify(r.onchain);
    for (const banned of [/transfer/i, /tokenSymbol/i, /\bsettle/i]) {
      assert.ok(!banned.test(asText), `the Solana report borrows EVM transfer language (${banned}): ${asText}`);
    }
    // And the notes carry the same statement where a reader of the summary
    // will find it.
    assert.ok(
      r.notes.some((n) => /SIGNATURES/.test(n) && /not incoming payments/.test(n)),
      JSON.stringify(r.notes)
    );
  });

  test('settlement_seen is null on an ACTIVE Solana address — a non-claim, not a yes', async () => {
    // The sharpest edge in this change. Signature activity is not settlement,
    // so `true` would be an answer to a question this leg never asked. The
    // registries' own verdicts are unaffected and still counted.
    const r = await servePresence({ rows: [signatureRow(), signatureRow({ signature: 'sig2' + '1'.repeat(40) })] });
    assert.equal(r.onchain.verdict, 'active');
    assert.deepEqual(r.summary, { listed: 0, of: 2, unknown: 0, settlement_seen: null });
  });

  test('a failed transaction still counts as activity, and is counted beside the total', async () => {
    // It was built, signed, submitted and paid for by somebody. That IS
    // evidence the address is alive on chain, which is the whole of the claim.
    const r = await servePresence({
      rows: [
        signatureRow({ signature: 'a' + '1'.repeat(60), err: { InstructionError: [0, { Custom: 1 }] } }),
        signatureRow({ signature: 'b' + '1'.repeat(60) }),
      ],
    });
    assert.equal(r.onchain.verdict, 'active');
    assert.equal(r.onchain.evidence.signatures_in_window, 2);
    assert.equal(r.onchain.evidence.failed_transactions_in_window, 1);
    assert.equal(r.onchain.evidence.latest.failed, true, 'the newest row errored and the report should say so');
  });

  test('an ALL-errored window is still active, never none_seen', async () => {
    const r = await servePresence({ rows: [signatureRow({ err: { InstructionError: [0, 'InvalidAccountData'] } })] });
    assert.equal(r.onchain.verdict, 'active');
    assert.equal(r.onchain.evidence.failed_transactions_in_window, 1);
  });

  test('the latest blockTime is rendered as ISO, and a missing one stays null', async () => {
    const r = await servePresence({ rows: [signatureRow({ blockTime: 1787000000 })] });
    // Both spellings on purpose: the computed one says the conversion is right,
    // the literal one pins the ANSWER, so a change to the conversion cannot
    // stay green by changing both sides of a comparison at once.
    assert.equal(r.onchain.evidence.latest.block_time, new Date(1787000000 * 1000).toISOString());
    assert.equal(r.onchain.evidence.latest.block_time, '2026-08-17T20:53:20.000Z');
    assert.equal(r.onchain.evidence.latest.confirmation_status, 'finalized');
    assert.equal(r.onchain.evidence.latest.slot, 291470237);

    // A node with no block time for that slot returns null. Null is reported as
    // null rather than as an epoch date.
    const none = await servePresence({ rows: [signatureRow({ blockTime: null })] });
    assert.equal(none.onchain.evidence.latest.block_time, null);
  });

  test('the window names the bound only when the bound was reached', async () => {
    const short = await servePresence({ rows: [signatureRow()] });
    assert.equal(short.onchain.evidence.window, 'all signatures');
    const full = await servePresence({
      rows: Array.from({ length: 25 }, (_, i) => signatureRow({ signature: `s${i}` + '1'.repeat(50) })),
    });
    assert.equal(full.onchain.evidence.window, 'the 25 most recent signatures');
  });

  test('an unused Solana address is none_seen, with the Solana fix and not the Base one', async () => {
    const r = await servePresence({ rows: [] });
    assert.equal(r.onchain.verdict, 'none_seen');
    assert.match(r.onchain.fix, /Solana/);
    assert.match(r.onchain.fix, /SIGNATURES, not incoming payments/);
    assert.ok(!/USDC transfers/.test(r.onchain.fix), r.onchain.fix);
    assert.equal(r.summary.settlement_seen, null);
  });

  test('a Solana 429 is retried once, and the retry answer stands', async () => {
    target.reset();
    registries.reset();
    target.serve(response({ v2: solanaV2Envelope() }));
    registries.state.solanaRows = [signatureRow()];
    registries.state.solanaStatuses.push(429);

    const res = await presence();
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.onchain.verdict, 'active', JSON.stringify(res.body.onchain));
    assert.equal(registries.state.solanaRequests.length, 2, 'the 429 was not retried exactly once');
  });

  test('a JSON-RPC error inside a 200 is unknown, not zero activity', async () => {
    // The case the EVM leg has no analogue of: JSON-RPC reports failure on an
    // OK status, so reading `result` off it would count a failed read as a
    // quiet address.
    target.reset();
    registries.reset();
    target.serve(response({ v2: solanaV2Envelope() }));
    registries.state.solanaError = { code: -32602, message: 'Invalid param: WrongSize' };

    const res = await presence();
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.onchain.verdict, 'unknown');
    assert.match(res.body.onchain.why, /JSON-RPC error: Invalid param/);
    assert.equal(res.body.onchain.fix, null, 'an unreadable surface must not hand out a fix');
    assert.equal(res.body.summary.settlement_seen, null);
  });

  test('an unreachable Solana RPC is unknown, and only the chain leg', async () => {
    target.reset();
    registries.reset();
    target.serve(response({ v2: solanaV2Envelope() }));
    registries.state.solanaStatus = 500;
    registries.state.scanRecord = { resource: RESOURCE_URL, method: 'POST', x402Version: 2, lastUpdated: null };

    const res = await presence();
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.onchain.verdict, 'unknown');
    assert.match(res.body.onchain.why, /Solana RPC answered 500/);
    assert.equal(res.body.registries.x402scan.verdict, 'listed');
  });

  test('a payTo of neither shape declines: unknown, and no chain surface is touched', async () => {
    // `merchant` is not invented for this test — it is the literal payTo of the
    // cloudflare:402 scheme, a role constant the v2 PaymentRequirements table
    // explicitly allows. There is no address to look up on any chain, so the
    // only honest answer is that we did not look.
    target.reset();
    registries.reset();
    target.serve(response({ v2: solanaV2Envelope('merchant') }));

    const res = await presence();
    assert.equal(res.status, 200, res.text);
    const r = res.body;
    assert.equal(r.onchain.verdict, 'unknown');
    assert.equal(r.onchain.why, 'no chain reader for this address family');
    assert.equal(r.onchain.evidence, null);
    assert.equal(r.onchain.fix, null);
    assert.equal(r.summary.settlement_seen, null);
    // Neither chain surface was called: the registries still were, so this is a
    // declined leg rather than an abandoned report.
    assert.equal(registries.state.solanaRequests.length, 0);
    assert.deepEqual(
      registries.state.hits.filter((h) => h.startsWith('/api?')),
      []
    );
    assert.ok(registries.state.hits.some((h) => h.includes('/discovery/resources')));
  });
});

describe('the presence engine, pure', () => {
  test('payToFamily dispatches on address SHAPE, and the two shapes are disjoint', () => {
    assert.equal(payToFamily(PAYTO), 'evm');
    // Mixed case, i.e. an EIP-55 checksummed address — the form most envelopes
    // actually carry.
    assert.equal(payToFamily('0x885E7BEF433eb78F5976b28A7c10739c98DB11E5'), 'evm');
    assert.equal(payToFamily(SOLANA_PAYTO), 'svm');
    // Base58 excludes `0`, so an EVM address can never read as a Solana one —
    // which is why the dispatch needs no tie-break.
    assert.notEqual(payToFamily(PAYTO), 'svm');
    // 32 and 44 are the inclusive bounds x402's SvmAddressRegex sets.
    assert.equal(payToFamily('1'.repeat(32)), 'svm');
    assert.equal(payToFamily('1'.repeat(44)), 'svm');
    assert.equal(payToFamily('1'.repeat(31)), 'unknown');
    assert.equal(payToFamily('1'.repeat(45)), 'unknown');
    // Neither shape: a role constant, an ENS name, a truncated address, and the
    // non-string a hostile envelope can put in the field.
    assert.equal(payToFamily('merchant'), 'unknown');
    assert.equal(payToFamily('treasury.example.eth'), 'unknown');
    assert.equal(payToFamily('0x' + 'ab'.repeat(19)), 'unknown');
    assert.equal(payToFamily([PAYTO]), 'unknown');
    assert.equal(payToFamily(undefined), 'unknown');
  });


  test('extractIdentity reads both envelopes and dedupes payTo', () => {
    const input = response({ v1: v1Envelope(), v2: v2Envelope() });
    const id = extractIdentity(input);
    assert.deepEqual(id.payTo, [PAYTO]);
    assert.equal(id.declaredUrl, RESOURCE_URL);
  });

  test('extractIdentity yields nothing on garbage, not a throw', () => {
    assert.deepEqual(extractIdentity({ headers: { 'payment-required': '!!!' }, body: 'not json' }), {
      payTo: [],
      declaredUrl: null,
    });
  });

  test('the frozen control assembles to the report the envelope sample publishes', () => {
    // The same call runSample makes — so the published output example is
    // provably this code over these observations, and a change to either
    // fails here before it ships.
    const report = assemblePresence({
      target: { url: PRESENCE_CONTROL.target.url, method: 'POST', status: 402 },
      identity: { payTo: PRESENCE_CONTROL.target.payTo, declaredUrl: PRESENCE_CONTROL.target.url },
      bazaar: PRESENCE_CONTROL.bazaar,
      scan: PRESENCE_CONTROL.scan,
      chain: PRESENCE_CONTROL.chain,
    });
    assert.equal(report.registries.bazaar.verdict, 'listed');
    assert.equal(report.registries.x402scan.verdict, 'listed');
    assert.equal(report.onchain.verdict, 'active');
    assert.deepEqual(report.summary, { listed: 2, of: 2, unknown: 0, settlement_seen: true });
  });
});
