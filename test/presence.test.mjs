// POST /presence against mock registries. Same posture as lint-http: the
// target is a local server serving the suite's own fixture envelopes, and the
// three registry surfaces are local mocks whose base URLs ride in through the
// PRESENCE_*_BASE vars — the same seam production uses, pointed at 127.0.0.1.
// Tests never touch the live registries.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { callers, client, TIER_ON_VARS, UNSAFE_TARGET_VARS, useWorker } from './harness.mjs';
import { response, v1Envelope, v2Envelope, PAYTO, RESOURCE_URL } from './fixtures/envelopes.mjs';
import { extractIdentity, assemblePresence } from '../worker/presence.js';
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
 * One mock for all three registry surfaces, routed by path — the vars all
 * point at the same server, which also proves the module reads its base per
 * surface rather than assuming a shared host layout.
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
    hits: [],
  };
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
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

describe('the presence engine, pure', () => {
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
