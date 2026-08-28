// Parallax's substrate: the three instrument parsers, the join, the roster, the
// probe, and the two crons end to end through the Worker's real `scheduled()`
// handler.
//
// NOTHING HERE TOUCHES THE LIVE NETWORK. The three instruments are one local
// mock addressed through the same MONITOR_AE_BASE / MONITOR_AT_BASE /
// PRESENCE_BAZAAR_BASE seam production uses, and the probed "sellers" are a
// second local server. The fixtures are excerpts of real 2026-08-27 captures
// (see test/fixtures/monitor.mjs and the shape note in its header).
//
// STANDALONE, and it has to be: the worker's MONITOR_*_BASE vars are the mock
// servers' ports, which are only known at startup. It also boots with
// `--test-scheduled`, which is what makes `wrangler dev` serve
// `/__scheduled?cron=…` — the only way to invoke the REAL scheduled() dispatch
// locally rather than a hand-rolled imitation of it. The cron assertions
// therefore run against the shipped handler, the shipped D1 schema and the
// shipped SQL, and the pure assertions run against the same module with no
// worker at all.
//
// ------------------------------------------------------------------ the safety interlock
//
// The instrument fixtures name REAL hosts (socialx402.com, agents.chain.link,
// 10x402.com …) because they are real captures. A probe cron run against
// readings written by a capture cron would therefore go and probe the actual
// internet — the one thing this suite may never do. So the probe-cron block
// seeds its own readings pointing at the local mock, and asserts that EVERY
// bz_resource in the table starts with the mock's base BEFORE it triggers
// anything. If a stray real-host row ever survives into that table, the
// assertion fails and no request is made.

import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ROOT, bootWorker, isSqlNull } from './harness.mjs';
import {
  AE_ROWS,
  AT_ROWS,
  BAZAAR_ITEMS,
  apistrustPage,
  bareArrayDocument,
  bazaarPage,
  metaWrappedDocument,
  ratingsDocument,
} from './fixtures/monitor.mjs';
import {
  CAPTURE_CRON,
  MONITOR_UA,
  PROBE_CRON,
  captureAgenteconomy,
  captureApistrust,
  captureBazaar,
  deriveRoster,
  distill,
  extractHostTable,
  houseHosts,
  looksLikeHost,
  probeCap,
  probeHost,
  ratingsRows,
} from '../worker/monitor.js';

let instruments;
let sellers;
let worker;

/** Today, the way both crons compute it. */
const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ the mock instruments
//
// One server for all three surfaces, routed by path — the vars all point at it,
// which also proves the module reads its base PER instrument rather than
// assuming they share a host layout.

async function startInstruments() {
  const state = {
    aeStatus: 200,
    aeBody: () => JSON.stringify(ratingsDocument()),
    atStatus: 200,
    atBody: () => apistrustPage(),
    bazaarStatus: 200,
    bazaarTotal: BAZAAR_ITEMS.length,
    bazaarItems: () => BAZAAR_ITEMS,
    hits: [],
    uas: [],
  };
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      state.hits.push(req.url);
      state.uas.push(req.headers['user-agent'] || '');
      const send = (status, type, body) => {
        res.writeHead(status, { 'content-type': type });
        res.end(body);
      };
      if (url.pathname === '/s/ratings.json') {
        if (state.aeStatus !== 200) return send(state.aeStatus, 'application/json', '{}');
        return send(200, 'application/json', state.aeBody());
      }
      if (url.pathname === '/') {
        if (state.atStatus !== 200) return send(state.atStatus, 'text/html', '');
        return send(200, 'text/html', state.atBody());
      }
      if (url.pathname === '/platform/v2/x402/discovery/resources') {
        if (state.bazaarStatus !== 200) return send(state.bazaarStatus, 'application/json', '{}');
        const limit = Number(url.searchParams.get('limit') || 0);
        const offset = Number(url.searchParams.get('offset') || 0);
        return send(
          200,
          'application/json',
          JSON.stringify(bazaarPage(state.bazaarItems(offset), { limit, offset, total: state.bazaarTotal }))
        );
      }
      return send(404, 'application/json', '{"error":"no such surface"}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    base: `http://127.0.0.1:${port}`,
    reset() {
      state.aeStatus = 200;
      state.aeBody = () => JSON.stringify(ratingsDocument());
      state.atStatus = 200;
      state.atBody = () => apistrustPage();
      state.bazaarStatus = 200;
      state.bazaarTotal = BAZAAR_ITEMS.length;
      state.bazaarItems = () => BAZAAR_ITEMS;
      state.hits.length = 0;
      state.uas.length = 0;
    },
    stop: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))),
  };
}

// ------------------------------------------------------------------ the mock sellers
//
// Three shapes on three paths, taken from what the 2026-08-27 two-verb probe
// actually measured:
//
//   /wronged  POST 402 with a PAYMENT-REQUIRED header and a v1 body, GET 405.
//             socialx402.com's exact answer, and the whole thesis of the wing:
//             a GET-only rater reads this host as dead.
//   /healthy  GET 402, POST 405. stabletravel.dev — the verb runs the other way.
//   /slow     never answers at all, so the timeout path is real.

const V1_BODY = JSON.stringify({
  x402Version: 1,
  error: 'X-PAYMENT header is required',
  accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '60000' }],
});

async function startSellers() {
  const state = { requests: [], holdOpen: [] };
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const path = new URL(req.url, 'http://x').pathname;
      state.requests.push({
        method: req.method,
        path,
        headers: { ...req.headers },
      });
      const four02 = () => {
        res.writeHead(402, {
          'content-type': 'application/json',
          'payment-required': 'eyJ4NDAyVmVyc2lvbiI6Mn0=',
        });
        res.end(V1_BODY);
      };
      const four05 = () => {
        res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
        res.end('{"error":"method not allowed"}');
      };
      if (path === '/wronged') return req.method === 'POST' ? four02() : four05();
      if (path === '/healthy') return req.method === 'GET' ? four02() : four05();
      if (path === '/plain') {
        // A 402 with NO header and a non-JSON body: both evidence flags 0
        // rather than null, which is a different claim from "not probed".
        res.writeHead(402, { 'content-type': 'text/html' });
        return res.end('<html>pay me</html>');
      }
      if (path === '/slow') {
        // Held open deliberately. The sockets are collected so teardown can
        // free them — an unanswered request keeps the server alive otherwise.
        state.holdOpen.push(res);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    base: `http://127.0.0.1:${port}`,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    reset: () => (state.requests.length = 0),
    stop: () =>
      new Promise((resolve) => {
        for (const res of state.holdOpen) {
          try {
            res.destroy();
          } catch {
            /* already gone */
          }
        }
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

before(async () => {
  instruments = await startInstruments();
  sellers = await startSellers();
  worker = await bootWorker({
    vars: {
      MONITOR_AE_BASE: instruments.base,
      MONITOR_AT_BASE: instruments.base,
      // The catalogue base is presence.js's, shared on purpose — one seam, one
      // production default, two readers.
      PRESENCE_BAZAAR_BASE: instruments.base,
      // The probed sellers are on 127.0.0.1 and on a port that is not 443, so
      // the guard has to be relaxed for the cron half of this suite. The pure
      // half asserts the SHIPPED guard refuses exactly those targets.
      LINT_UNSAFE_TARGETS: '1',
      MONITOR_TIMEOUT_MS: '700',
      MONITOR_PROBE_CAP: '10',
    },
    args: ['--test-scheduled'],
  });
});

after(async () => {
  await worker?.stop();
  await sellers?.stop();
  await instruments?.stop();
});

/** Fire one cron through the Worker's real scheduled() dispatch. */
async function runCron(cron) {
  const res = await fetch(`${worker.baseUrl}/__scheduled?cron=${encodeURIComponent(cron)}`);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return text;
}

/** The env a pure call gets: the mock bases, and the guard relaxed only where
 *  the test is not about the guard. */
const pureEnv = (extra = {}) => ({
  MONITOR_AE_BASE: instruments.base,
  MONITOR_AT_BASE: instruments.base,
  PRESENCE_BAZAAR_BASE: instruments.base,
  MONITOR_TIMEOUT_MS: 700,
  ...extra,
});

// ==================================================================
describe('instrument 1 — the rater', () => {
  test('the assumed live shape parses into rows and meta', async () => {
    instruments.reset();
    const ae = await captureAgenteconomy(pureEnv());
    assert.equal(ae.ok, true, ae.why);
    assert.equal(ae.rows.length, AE_ROWS.length);
    assert.equal(ae.as_of, '2026-08-27');
    // The RATER's own count, not ours — they are deliberately different here so
    // that a parse which dropped rows would be visible rather than self-consistent.
    assert.equal(ae.count, 1194);
    assert.equal(ae.distribution.D, 330);
    assert.equal(ae.api.price_usd, 0.005, 'the incumbent price card is captured, not remembered');

    const wronged = ae.rows.find((r) => r.host === 'socialx402.com');
    assert.deepEqual(wronged, {
      host: 'socialx402.com',
      tier: 'D',
      score: 0,
      uptime: 0,
      organic_paying_agents: 49,
      paying_wallets_raw: 64,
      settled_usd_14d: 173.76,
      centrality: 0.132,
      flag: null,
      above_trust_line: false,
      outlook: 'negative',
      as_of: '2026-08-27',
    });
  });

  test('flag null, NEW, UNLISTED and CAPTIVE all survive as themselves', async () => {
    instruments.reset();
    const ae = await captureAgenteconomy(pureEnv());
    const flag = (host) => ae.rows.find((r) => r.host === host).flag;
    assert.equal(flag('socialx402.com'), null, 'unflagged is null, never a string');
    assert.equal(flag('10x402.com'), 'NEW');
    assert.equal(flag('api.onesource.io'), 'CAPTIVE');
    assert.equal(flag('0x07cf5359edb7d8de42973562c54e4c8d583c2396'), 'UNLISTED');
  });

  test('a bare array and a _meta-wrapped document parse the same rows', async () => {
    instruments.reset();
    instruments.state.aeBody = () => JSON.stringify(bareArrayDocument());
    const bare = await captureAgenteconomy(pureEnv());
    assert.equal(bare.ok, true, bare.why);
    assert.equal(bare.rows.length, AE_ROWS.length);
    // A bare array carries no meta, and the parser must say so rather than invent one.
    assert.equal(bare.as_of, null);

    instruments.state.aeBody = () => JSON.stringify(metaWrappedDocument());
    const wrapped = await captureAgenteconomy(pureEnv());
    assert.equal(wrapped.ok, true, wrapped.why);
    assert.equal(wrapped.rows.length, AE_ROWS.length);
    assert.equal(wrapped.as_of, '2026-08-27', 'meta hoisted under _meta is still meta');
  });

  test('ratingsRows finds the array under any plausible key, pure', () => {
    const rows = [{ host: 'a.example' }];
    for (const key of ['services', 'ratings', 'rows', 'data', 'items', 'whatever_they_call_it']) {
      assert.deepEqual(ratingsRows({ as_of: 'x', [key]: rows }), rows, key);
    }
    assert.deepEqual(ratingsRows(rows), rows, 'a bare array is itself');
    // An array of things that are not service rows is not the service rows.
    assert.equal(ratingsRows({ scale: ['AAA', 'AA'] }), null);
    assert.equal(ratingsRows('nope'), null);
  });

  test('an unreadable rater is a NAMED failure, never an empty population', async () => {
    instruments.reset();
    instruments.state.aeStatus = 500;
    const down = await captureAgenteconomy(pureEnv());
    assert.equal(down.ok, false);
    assert.match(down.why, /agenteconomy answered 500/);

    instruments.state.aeStatus = 200;
    instruments.state.aeBody = () => 'not json at all';
    const garbage = await captureAgenteconomy(pureEnv());
    assert.equal(garbage.ok, false);
    assert.match(garbage.why, /not JSON/);

    instruments.state.aeBody = () => JSON.stringify({ as_of: '2026-08-27', total: 3 });
    const unknown = await captureAgenteconomy(pureEnv());
    assert.equal(unknown.ok, false);
    assert.match(unknown.why, /no recognisable array of service rows/);
  });

  test('every instrument read carries the monitor UA verbatim', async () => {
    instruments.reset();
    await captureAgenteconomy(pureEnv());
    assert.equal(instruments.state.uas.length, 1);
    assert.equal(instruments.state.uas[0], '10x402-monitor/0.1 (+https://10x402.com/monitor)');
    assert.equal(instruments.state.uas[0], MONITOR_UA);
  });
});

// ==================================================================
describe('instrument 2 — the second prober', () => {
  test('the host table comes out of the served HTML, decoys and all', async () => {
    instruments.reset();
    const at = await captureApistrust(pureEnv());
    assert.equal(at.ok, true, at.why);
    assert.equal(at.rows.length, AT_ROWS.length);

    const chainlink = at.rows.find((r) => r.host === 'agents.chain.link');
    assert.deepEqual(chainlink, {
      host: 'agents.chain.link',
      score: 67,
      endpoints: 3,
      min_score: 0,
      down: 1,
      price_findings: 0,
    });
    // down: 0 is a REAL reading and must not be confused with "not observed".
    assert.equal(at.rows.find((r) => r.host === 'socialx402.com').down, 0);
  });

  test('extractHostTable takes the LARGEST parseable array, not the first', () => {
    const small = [{ h: 'one.example', s: 1 }];
    const big = Array.from({ length: 40 }, (_, i) => ({ h: `host-${i}.example`, s: i }));
    const html = `<script>a=${JSON.stringify(small)}</script><script>b=${JSON.stringify(big)}</script>`;
    assert.equal(extractHostTable(html).length, 40);
    // …and the order on the page does not decide it.
    const reversed = `<script>b=${JSON.stringify(big)}</script><script>a=${JSON.stringify(small)}</script>`;
    assert.equal(extractHostTable(reversed).length, 40);
  });

  test('a bracket inside a string value cannot close the array early', () => {
    const rows = [{ h: 'a.example', note: 'brackets ] and [ in a value' }, { h: 'b.example' }, { h: 'c.example' }];
    assert.equal(extractHostTable(`<script>x=${JSON.stringify(rows)}</script>`).length, 3);
  });

  test('a page with no table is a named failure', async () => {
    instruments.reset();
    instruments.state.atBody = () => '<html><body><p>maintenance</p></body></html>';
    const at = await captureApistrust(pureEnv());
    assert.equal(at.ok, false);
    assert.match(at.why, /no readable host table/);

    instruments.state.atStatus = 503;
    const down = await captureApistrust(pureEnv());
    assert.equal(down.ok, false);
    assert.match(down.why, /apistrust answered 503/);
  });
});

// ==================================================================
describe('instrument 3 — the catalogue', () => {
  test('one row per host: the most recently called resource wins', async () => {
    instruments.reset();
    const bz = await captureBazaar(pureEnv());
    assert.equal(bz.ok, true, bz.why);

    const byHost = new Map(bz.rows.map((r) => [r.host, r]));
    assert.equal(byHost.size, 7, [...byHost.keys()].join(', '));
    // socialx402.com carries two resources and the older one arrives FIRST, so
    // this is a real choice rather than last-write-wins.
    assert.equal(byHost.get('socialx402.com').resource, 'https://socialx402.com/api/sc/facebook/adLibrary/company/ads');
    assert.equal(byHost.get('socialx402.com').last_called_at, '2026-08-21T05:19:03.972Z');
    assert.equal(byHost.get('10x402.com').resource, 'https://10x402.com/lint/one');
  });

  test('the quality block and the declared verb are read where they actually live', async () => {
    instruments.reset();
    const bz = await captureBazaar(pureEnv());
    const byHost = new Map(bz.rows.map((r) => [r.host, r]));

    assert.equal(byHost.get('agents.chain.link').calls_30d, 16069);
    assert.equal(byHost.get('api.onesource.io').unique_payers_30d, 910);
    // accepts[0].outputSchema.input.method — inside outputSchema.input, not one
    // level up. This is the field the whole wing turns on.
    assert.equal(byHost.get('socialx402.com').method, 'POST');
    assert.equal(byHost.get('stabletravel.dev').method, 'GET');
    // Absent verb defaults to POST, which is what an x402 client sends when told nothing.
    assert.equal(byHost.get('aura.adex.network').method, 'POST');
    // A row with no quality block gets NULLs, NEVER zeros — 60 of 14,732 real
    // rows carried only lastCalledAt, and a zero there is a claim about demand.
    assert.equal(byHost.get('aura.adex.network').calls_30d, null);
    assert.equal(byHost.get('aura.adex.network').unique_payers_30d, null);
    assert.equal(byHost.get('aura.adex.network').last_called_at, null);
  });

  test('a row whose resource is not a URL is dropped, not thrown over', async () => {
    instruments.reset();
    const bz = await captureBazaar(pureEnv());
    assert.equal(bz.resources, BAZAAR_ITEMS.length - 1, 'exactly the one malformed row was dropped');
    assert.equal(bz.ok, true);
  });

  test('the catalogue scan really pages', async () => {
    instruments.reset();
    instruments.state.bazaarTotal = 1500; // two pages at the production page size
    instruments.state.bazaarItems = (offset) =>
      offset === 0
        ? BAZAAR_ITEMS
        : [
            {
              resource: 'https://page-two.example/api/thing',
              accepts: [{ outputSchema: { input: { method: 'POST' } } }],
              quality: { l30DaysTotalCalls: 5, l30DaysUniquePayers: 2, lastCalledAt: '2026-08-27T00:00:00.000Z' },
            },
          ];

    const bz = await captureBazaar(pureEnv());
    assert.equal(bz.ok, true, bz.why);
    assert.equal(bz.total, 1500);
    assert.ok(bz.rows.some((r) => r.host === 'page-two.example'), 'the host on page two was not found');
    const pages = instruments.state.hits.filter((h) => h.includes('/discovery/resources'));
    assert.equal(pages.length, 2, pages.join('\n'));
  });

  test('a page that cannot be read fails the whole capture, naming the offset', async () => {
    instruments.reset();
    instruments.state.bazaarStatus = 502;
    const bz = await captureBazaar(pureEnv());
    assert.equal(bz.ok, false);
    assert.match(bz.why, /bazaar page at offset 0 answered 502/);
  });
});

// ==================================================================
describe('the join', () => {
  const capture = async () => {
    instruments.reset();
    const [ae, at, bazaar] = await Promise.all([
      captureAgenteconomy(pureEnv()),
      captureApistrust(pureEnv()),
      captureBazaar(pureEnv()),
    ]);
    return distill('2026-08-27', { ae, at, bazaar });
  };

  test('membership is a UNION: a host in any one instrument gets a row', async () => {
    const { readings, day } = await capture();
    const byHost = new Map(readings.map((r) => [r.host, r]));
    assert.equal(day.population, 12, [...byHost.keys()].sort().join(', '));

    // In all three.
    const both = byHost.get('socialx402.com');
    assert.equal(both.ae_uptime, 0);
    assert.equal(both.at_down, 0);
    assert.equal(both.bz_method, 'POST');

    // Catalogue + second prober, absent from the rater.
    const vaaya = byHost.get('vaaya.ai');
    assert.equal(vaaya.ae_uptime, null, 'an absent instrument is NULL, never 0');
    assert.equal(vaaya.ae_tier, null);
    assert.equal(vaaya.at_score, 99);
    assert.equal(vaaya.bz_resource, 'https://vaaya.ai/api/run/courtlistener/dockets');

    // Catalogue only.
    const aura = byHost.get('aura.adex.network');
    assert.equal(aura.ae_score, null);
    assert.equal(aura.at_score, null);
    assert.equal(aura.bz_method, 'POST');

    // Rater only, and it is a wallet address rather than a host.
    const wallet = byHost.get('0x07cf5359edb7d8de42973562c54e4c8d583c2396');
    assert.equal(wallet.ae_settled_14d, 500.9, 'an UNLISTED wallet row is counted — its money is real');
    assert.equal(wallet.bz_resource, null);
    assert.equal(wallet.at_score, null);
  });

  test('contradictions need BOTH instruments present, and a NULL is not a disagreement', async () => {
    const { day } = await capture();
    // socialx402.com (ae 0.0 / at down 0) and 10x402.com (ae 0.0 / at down 0)
    // contradict. agents.chain.link does NOT — ae 0.0 but at saw down 1, so the
    // two probers agree. The 0x… wallet row has no apistrust reading at all.
    assert.equal(day.contradictions, 2);
  });

  test('the day row leaves the probe cron its own columns', async () => {
    const { day } = await capture();
    assert.deepEqual(day, {
      day: '2026-08-27',
      population: 12,
      captured_ae: 1,
      captured_at: 1,
      captured_bazaar: 1,
      // NULL, not 0. Capture cannot know either of these — wrongly_dead needs a
      // probe that has not happened yet, and a 0 there would publish "nobody is
      // wrongly dead today" every single morning at 11:17.
      roster_size: null,
      wrongly_dead: null,
      contradictions: 2,
    });
  });

  test('a failed instrument NULLs only its own columns', () => {
    const ae = { ok: false, why: 'agenteconomy answered 500' };
    const at = { ok: true, rows: [{ host: 'a.example', score: 100, down: 0, endpoints: 2 }] };
    const bazaar = {
      ok: true,
      rows: [{ host: 'a.example', resource: 'https://a.example/x', calls_30d: 3, unique_payers_30d: 1, last_called_at: 'z', method: 'POST' }],
    };
    const { readings, day } = distill('2026-08-27', { ae, at, bazaar });
    assert.equal(readings.length, 1);
    assert.equal(readings[0].ae_uptime, null);
    assert.equal(readings[0].at_score, 100);
    assert.equal(readings[0].bz_calls_30d, 3);
    assert.equal(day.captured_ae, 0);
    assert.equal(day.captured_at, 1);
    assert.equal(day.captured_bazaar, 1);
    // With no rater reading there is nothing to contradict.
    assert.equal(day.contradictions, 0);
  });

  test('all three failing is a day row with a population of zero, not a throw', () => {
    const dead = { ok: false, why: 'unreachable' };
    const { readings, day } = distill('2026-08-27', { ae: dead, at: dead, bazaar: dead });
    assert.equal(readings.length, 0);
    assert.deepEqual(day, {
      day: '2026-08-27',
      population: 0,
      captured_ae: 0,
      captured_at: 0,
      captured_bazaar: 0,
      roster_size: null,
      wrongly_dead: null,
      contradictions: 0,
    });
  });
});

// ==================================================================
describe('the roster', () => {
  const readingsFor = async () => {
    instruments.reset();
    const [ae, at, bazaar] = await Promise.all([
      captureAgenteconomy(pureEnv()),
      captureApistrust(pureEnv()),
      captureBazaar(pureEnv()),
    ]);
    return distill('2026-08-27', { ae, at, bazaar }).readings;
  };

  test('priority order: house, then wrongly-dead-and-settling, then contradictions', async () => {
    const roster = await readingsFor().then((r) => deriveRoster(r, 100));
    const hosts = roster.map((r) => r.host);
    // 10x402.com is the house and comes first whatever else is true.
    assert.equal(hosts[0], '10x402.com');
    // Then dead-at-the-rater-and-settling, biggest first: chain.link $278.07
    // ahead of socialx402 $173.76.
    assert.deepEqual(hosts.slice(1, 3), ['agents.chain.link', 'socialx402.com']);
    // Then the settlers, then the healthy fill. Every eligible host is in, once.
    assert.equal(new Set(hosts).size, hosts.length, 'a host appeared twice');
    assert.deepEqual(hosts.slice(3), ['stabletravel.dev', 'api.onesource.io', 'vaaya.ai', 'aura.adex.network']);
  });

  test('the cap truncates in priority order', async () => {
    const readings = await readingsFor();
    assert.deepEqual(deriveRoster(readings, 2).map((r) => r.host), ['10x402.com', 'agents.chain.link']);
    assert.deepEqual(deriveRoster(readings, 1).map((r) => r.host), ['10x402.com']);
    assert.deepEqual(deriveRoster(readings, 0), []);
  });

  test('MONITOR_HOUSE_HOSTS joins the house and jumps the queue', async () => {
    const readings = await readingsFor();
    const roster = deriveRoster(readings, 3, { MONITOR_HOUSE_HOSTS: 'vaaya.ai, AURA.ADEX.NETWORK' });
    assert.deepEqual(new Set(roster.map((r) => r.host)), new Set(['10x402.com', 'vaaya.ai', 'aura.adex.network']));
    assert.deepEqual(houseHosts({ MONITOR_HOUSE_HOSTS: 'a.example,,b.example' }), [
      '10x402.com',
      'a.example',
      'b.example',
    ]);
  });

  test('a bare wallet row is never probed, however much it settles', async () => {
    const readings = await readingsFor();
    const wallet = readings.find((r) => r.host === '0x07cf5359edb7d8de42973562c54e4c8d583c2396');
    assert.equal(wallet.ae_settled_14d, 500.9, 'it is the biggest settler in the fixture');
    assert.ok(!deriveRoster(readings, 100).some((r) => r.host === wallet.host));
    // …and even if the catalogue somehow handed it a resource.
    assert.ok(!deriveRoster([{ ...wallet, bz_resource: 'https://x.example/y' }], 100).length);
    assert.equal(looksLikeHost('0x07cf5359edb7d8de42973562c54e4c8d583c2396'), false);
    assert.equal(looksLikeHost('socialx402.com'), true);
    assert.equal(looksLikeHost('localhost'), false, 'no dot is not a host we can join on');
  });

  test('a host with no catalogue resource has nothing to probe', () => {
    const rows = [{ host: 'rated-only.example', bz_resource: null, ae_uptime: 0, ae_settled_14d: 9999 }];
    assert.deepEqual(deriveRoster(rows, 100), []);
  });

  test('the cap is clamped so a typo cannot ask for a subrequest-ceiling breach', () => {
    assert.equal(probeCap({}), 400);
    assert.equal(probeCap({ MONITOR_PROBE_CAP: '25' }), 25);
    assert.equal(probeCap({ MONITOR_PROBE_CAP: '100000' }), 900);
    assert.equal(probeCap({ MONITOR_PROBE_CAP: 'banana' }), 400);
    assert.equal(probeCap({ MONITOR_PROBE_CAP: '0' }), 400);
  });
});

// ==================================================================
describe('the probe', () => {
  const unsafe = (extra = {}) => ({ LINT_UNSAFE_TARGETS: '1', MONITOR_TIMEOUT_MS: 700, ...extra });

  test('the wronged shape: 402 on the declared verb, 405 on GET', async () => {
    sellers.reset();
    const p = await probeHost({ host: 'wronged.example', bz_resource: sellers.url('/wronged'), bz_method: 'POST' }, unsafe());
    assert.equal(p.refused, undefined);
    assert.equal(p.declared_method, 'POST');
    assert.equal(p.declared_status, 402);
    assert.equal(p.get_status, 405, 'this is exactly what a GET-only rater sees');
    assert.equal(p.saw_v2_header, 1);
    assert.equal(p.saw_v1_body, 1);
    assert.ok(p.declared_ms >= 0 && p.declared_ms < 5000);
    assert.equal(sellers.state.requests.length, 2, 'two verbs, two requests');
  });

  test('the healthy shape: one request, because the declared verb IS GET', async () => {
    sellers.reset();
    const p = await probeHost({ host: 'healthy.example', bz_resource: sellers.url('/healthy'), bz_method: 'GET' }, unsafe());
    assert.equal(p.declared_status, 402);
    assert.equal(p.get_status, 402);
    assert.equal(p.declared_ms, p.get_ms, 'the same observation, filling both column pairs');
    assert.equal(sellers.state.requests.length, 1, 'the same request must not be sent twice');
    assert.equal(sellers.state.requests[0].method, 'GET');
  });

  test('NO PROBE EVER CARRIES AN X-PAYMENT HEADER', async () => {
    sellers.reset();
    await probeHost({ host: 'a', bz_resource: sellers.url('/wronged'), bz_method: 'POST' }, unsafe());
    await probeHost({ host: 'b', bz_resource: sellers.url('/healthy'), bz_method: 'GET' }, unsafe());
    await probeHost({ host: 'c', bz_resource: sellers.url('/plain'), bz_method: 'POST' }, unsafe());
    assert.ok(sellers.state.requests.length >= 4);
    for (const req of sellers.state.requests) {
      for (const name of ['x-payment', 'payment-signature', 'authorization', 'cookie']) {
        assert.equal(req.headers[name], undefined, `a probe carried ${name} to ${req.path}`);
      }
      assert.equal(req.headers['user-agent'], MONITOR_UA);
    }
  });

  test('a POST probe sends the smallest body a JSON endpoint accepts, and a GET sends none', async () => {
    sellers.reset();
    await probeHost({ host: 'a', bz_resource: sellers.url('/wronged'), bz_method: 'POST' }, unsafe());
    const post = sellers.state.requests.find((r) => r.method === 'POST');
    const get = sellers.state.requests.find((r) => r.method === 'GET');
    assert.equal(post.headers['content-type'], 'application/json');
    assert.equal(post.headers['content-length'], '2', 'the body is `{}` and nothing else');
    assert.equal(get.headers['content-type'], undefined);
  });

  test('a 402 with neither envelope reads 0 for both, which is not the same as NULL', async () => {
    sellers.reset();
    const p = await probeHost({ host: 'plain.example', bz_resource: sellers.url('/plain'), bz_method: 'POST' }, unsafe());
    assert.equal(p.declared_status, 402);
    assert.equal(p.saw_v2_header, 0, '0 = we looked and it was not there');
    assert.equal(p.saw_v1_body, 0);
  });

  test('a host that never answers is status 0 — asked, no HTTP response', async () => {
    sellers.reset();
    const p = await probeHost({ host: 'slow.example', bz_resource: sellers.url('/slow'), bz_method: 'POST' }, unsafe());
    assert.equal(p.declared_status, 0, '0 is not a status any server can return');
    assert.equal(p.get_status, 0);
    assert.ok(p.declared_ms >= 600, `timed out too fast: ${p.declared_ms}ms`);
    assert.equal(p.saw_v2_header, 0);
  });

  test('a verb this service will not send is skipped, and only the GET half runs', async () => {
    sellers.reset();
    const p = await probeHost({ host: 'del.example', bz_resource: sellers.url('/wronged'), bz_method: 'DELETE' }, unsafe());
    assert.equal(p.declared_method, 'DELETE', 'what the catalogue declared is still recorded');
    assert.equal(p.declared_status, null, 'NULL = we never asked');
    assert.equal(p.saw_v2_header, null);
    assert.equal(p.get_status, 405);
    assert.deepEqual(sellers.state.requests.map((r) => r.method), ['GET']);
    assert.ok(!sellers.state.requests.some((r) => r.method === 'DELETE'), 'a DELETE was sent at a stranger');
  });

  test('SSRF: a private target is refused with NO request made', async () => {
    sellers.reset();
    // The same URL the tests above probe happily — the ONLY difference is that
    // the relaxation var is absent, i.e. the SHIPPED guard is in force. It is
    // refused on the scheme, which is the FIRST rule the guard applies; the
    // loopback rule below proves the address half separately.
    const p = await probeHost({ host: 'evil.example', bz_resource: sellers.url('/wronged'), bz_method: 'POST' }, {});
    assert.match(p.refused, /must be https/);
    assert.equal(p.declared_status, null);
    assert.equal(p.get_status, null);
    assert.equal(sellers.state.requests.length, 0, 'the guard let a request through');

    const refusals = [
      ['https://127.0.0.1/x', /loopback/],
      ['https://169.254.169.254/latest/meta-data/', /link-local/],
      ['http://example.com/plain-http', /must be https/],
      ['https://[::1]/x', /loopback/],
      ['https://10.0.0.5/internal', /RFC 1918/],
      ['https://example.com:22/ssh', /only 443 and 8443/],
      ['https://redis/keys', /bare hostname/],
      ['https://user:pw@example.com/x', /credentials/],
    ];
    for (const [url, why] of refusals) {
      const refused = await probeHost({ host: 'x', bz_resource: url, bz_method: 'GET' }, {});
      assert.ok(refused.refused, `${url} was not refused`);
      assert.match(refused.refused, why, url);
    }
    assert.equal(sellers.state.requests.length, 0);
  });

  test('a catalogue row with no resource at all is refused, not fetched', async () => {
    sellers.reset();
    const p = await probeHost({ host: 'x.example', bz_resource: null, bz_method: 'POST' }, unsafe());
    assert.ok(p.refused);
    assert.equal(sellers.state.requests.length, 0);
  });
});

// ==================================================================
describe('the capture cron, through the Worker', () => {
  test('a full capture writes the readings and the capture half of the day', async () => {
    instruments.reset();
    await worker.d1('DELETE FROM monitor_readings');
    await worker.d1('DELETE FROM monitor_days');
    await runCron(CAPTURE_CRON);

    const day = today();
    const [meta] = await worker.d1(`SELECT * FROM monitor_days WHERE day = '${day}'`);
    assert.ok(meta, 'no day row was written');
    assert.equal(meta.population, 12);
    assert.equal(meta.captured_ae, 1);
    assert.equal(meta.captured_at, 1);
    assert.equal(meta.captured_bazaar, 1);
    assert.equal(meta.contradictions, 2);
    assert.ok(isSqlNull(meta.roster_size), 'capture must not claim a roster it did not probe');
    assert.ok(isSqlNull(meta.wrongly_dead), 'wrongly_dead is unknowable before the probe cron runs');

    const rows = await worker.d1(`SELECT * FROM monitor_readings WHERE day = '${day}' ORDER BY host`);
    assert.equal(rows.length, 12);
    const wronged = rows.find((r) => r.host === 'socialx402.com');
    assert.equal(wronged.ae_uptime, 0);
    assert.equal(wronged.ae_settled_14d, 173.76);
    assert.equal(wronged.at_down, 0);
    assert.equal(wronged.bz_method, 'POST');
    assert.equal(wronged.bz_resource, 'https://socialx402.com/api/sc/facebook/adLibrary/company/ads');
    // The union rows really do carry SQL NULLs, not zeros or empty strings.
    const aura = rows.find((r) => r.host === 'aura.adex.network');
    assert.ok(isSqlNull(aura.ae_uptime));
    assert.ok(isSqlNull(aura.at_score));
    assert.ok(isSqlNull(aura.bz_calls_30d));
  });

  test('re-running the same day REPLACES, never duplicates', async () => {
    instruments.reset();
    const day = today();
    const before = await worker.d1(`SELECT COUNT(*) AS n FROM monitor_readings WHERE day = '${day}'`);
    await runCron(CAPTURE_CRON);
    await runCron(CAPTURE_CRON);
    const after = await worker.d1(`SELECT COUNT(*) AS n FROM monitor_readings WHERE day = '${day}'`);
    assert.equal(after[0].n, before[0].n, 'a re-run doubled the day');
    const days = await worker.d1(`SELECT COUNT(*) AS n FROM monitor_days WHERE day = '${day}'`);
    assert.equal(days[0].n, 1);
  });

  test('a shrunken population leaves no orphan rows behind', async () => {
    instruments.reset();
    const day = today();
    instruments.state.aeBody = () => JSON.stringify(ratingsDocument(AE_ROWS.slice(0, 1)));
    instruments.state.atBody = () => apistrustPage(AT_ROWS.slice(0, 1));
    instruments.state.bazaarTotal = 2;
    instruments.state.bazaarItems = () => BAZAAR_ITEMS.slice(1, 2);
    await runCron(CAPTURE_CRON);

    const rows = await worker.d1(`SELECT host FROM monitor_readings WHERE day = '${day}'`);
    assert.deepEqual(rows.map((r) => r.host), ['socialx402.com']);
    const [meta] = await worker.d1(`SELECT population FROM monitor_days WHERE day = '${day}'`);
    assert.equal(meta.population, 1);
  });

  test('one instrument down: the other two are written, and the day says which is missing', async () => {
    instruments.reset();
    instruments.state.aeStatus = 500;
    const day = today();
    await runCron(CAPTURE_CRON);

    const [meta] = await worker.d1(`SELECT * FROM monitor_days WHERE day = '${day}'`);
    assert.equal(meta.captured_ae, 0, 'the rater was down');
    assert.equal(meta.captured_at, 1);
    assert.equal(meta.captured_bazaar, 1);
    // apistrust's 10 hosts ∪ the catalogue's 7 = 11 distinct; the rater's rows
    // are simply not there, and nothing else changed.
    assert.equal(meta.population, 11);
    assert.equal(meta.contradictions, 0, 'with no rater reading there is nothing to contradict');

    const rows = await worker.d1(`SELECT * FROM monitor_readings WHERE day = '${day}' AND host = 'socialx402.com'`);
    assert.equal(rows.length, 1, 'the surviving instruments still wrote their rows');
    assert.ok(isSqlNull(rows[0].ae_uptime));
    assert.ok(isSqlNull(rows[0].ae_tier));
    assert.equal(rows[0].at_down, 0);
    assert.equal(rows[0].bz_method, 'POST');
  });

  test('all three down: an honest empty day rather than a crash', async () => {
    instruments.reset();
    instruments.state.aeStatus = 500;
    instruments.state.atStatus = 500;
    instruments.state.bazaarStatus = 500;
    const day = today();
    await runCron(CAPTURE_CRON);

    const [meta] = await worker.d1(`SELECT * FROM monitor_days WHERE day = '${day}'`);
    assert.equal(meta.population, 0);
    assert.equal(meta.captured_ae + meta.captured_at + meta.captured_bazaar, 0);
    const rows = await worker.d1(`SELECT COUNT(*) AS n FROM monitor_readings WHERE day = '${day}'`);
    assert.equal(rows[0].n, 0);
  });

  test('an unrecognised cron writes nothing and does not throw', async () => {
    instruments.reset();
    await worker.d1('DELETE FROM monitor_readings');
    await worker.d1('DELETE FROM monitor_days');
    await runCron('0 0 1 1 *');
    const rows = await worker.d1('SELECT COUNT(*) AS n FROM monitor_days');
    assert.equal(rows[0].n, 0);
  });
});

// ==================================================================
describe('the probe cron, through the Worker', () => {
  const day = today();

  /**
   * The day's readings, seeded to point ONLY at the local mock.
   *
   * The interlock described at the top of this file: the instrument fixtures
   * name real hosts, so a probe cron run against capture-written readings would
   * probe the real internet. Every test in this block asserts the table holds
   * nothing but mock URLs before it fires anything.
   */
  const seed = async () => {
    await worker.d1('DELETE FROM monitor_readings');
    await worker.d1('DELETE FROM monitor_probes');
    await worker.d1('DELETE FROM monitor_days');
    const rows = [
      // dead at the rater, settling, POST-declared → the wrongly-dead case
      ['wronged.example', 0, 173.76, 0, sellers.url('/wronged'), 'POST'],
      // healthy and GET-declared
      ['healthy.example', 1, 73.68, 0, sellers.url('/healthy'), 'GET'],
      // dead at the rater but genuinely unreachable — settles nothing either
      ['slow.example', 0, 0, 1, sellers.url('/slow'), 'POST'],
    ];
    for (const [host, uptime, settled, down, resource, method] of rows) {
      await worker.d1(
        `INSERT INTO monitor_readings (day, host, ae_uptime, ae_settled_14d, at_down, at_score, bz_resource, bz_method)
         VALUES ('${day}', '${host}', ${uptime}, ${settled}, ${down}, 100, '${resource}', '${method}')`
      );
    }
    const held = await worker.d1(`SELECT bz_resource FROM monitor_readings WHERE day = '${day}'`);
    for (const r of held) {
      assert.ok(
        String(r.bz_resource).startsWith(sellers.base),
        `INTERLOCK: a non-mock resource reached the probe roster (${r.bz_resource})`
      );
    }
  };

  test('the roster is probed on both verbs and written', async () => {
    sellers.reset();
    await seed();
    await runCron(PROBE_CRON);

    const probes = await worker.d1(`SELECT * FROM monitor_probes WHERE day = '${day}' ORDER BY host`);
    assert.equal(probes.length, 3, JSON.stringify(probes));
    const byHost = new Map(probes.map((p) => [p.host, p]));

    const wronged = byHost.get('wronged.example');
    assert.equal(wronged.declared_method, 'POST');
    assert.equal(wronged.declared_status, 402);
    assert.equal(wronged.get_status, 405);
    assert.equal(wronged.saw_v2_header, 1);
    assert.equal(wronged.saw_v1_body, 1);
    assert.ok(wronged.ts > 1_700_000_000, 'the probe is stamped with when it ran');

    const healthy = byHost.get('healthy.example');
    assert.equal(healthy.declared_status, 402);
    assert.equal(healthy.get_status, 402);

    assert.equal(byHost.get('slow.example').declared_status, 0);
  });

  test('the probe cron fills the OTHER half of the day row and leaves capture alone', async () => {
    sellers.reset();
    await seed();
    // Capture's columns, written as capture would have written them.
    await worker.d1(
      `INSERT INTO monitor_days (day, population, captured_ae, captured_at, captured_bazaar, contradictions)
       VALUES ('${day}', 3, 1, 1, 1, 1)`
    );
    await runCron(PROBE_CRON);

    const [meta] = await worker.d1(`SELECT * FROM monitor_days WHERE day = '${day}'`);
    assert.equal(meta.roster_size, 3);
    // Dead at the rater AND answering 402 on the declared verb. healthy.example
    // answers 402 too but is not dead at the rater; slow.example is dead at the
    // rater but answers nothing.
    assert.equal(meta.wrongly_dead, 1);
    // …and capture's columns are untouched by the update.
    assert.equal(meta.population, 3);
    assert.equal(meta.captured_ae, 1);
    assert.equal(meta.contradictions, 1);
  });

  test('re-running the probe for the same day REPLACES, never duplicates', async () => {
    sellers.reset();
    await seed();
    await runCron(PROBE_CRON);
    const before = await worker.d1(`SELECT COUNT(*) AS n FROM monitor_probes WHERE day = '${day}'`);
    await runCron(PROBE_CRON);
    await runCron(PROBE_CRON);
    const after = await worker.d1(`SELECT COUNT(*) AS n FROM monitor_probes WHERE day = '${day}'`);
    assert.equal(after[0].n, before[0].n);
    const days = await worker.d1(`SELECT COUNT(*) AS n FROM monitor_days WHERE day = '${day}'`);
    assert.equal(days[0].n, 1);
  });

  test('NOT ONE probe the cron sent carried a payment header', async () => {
    sellers.reset();
    await seed();
    await runCron(PROBE_CRON);
    assert.ok(sellers.state.requests.length >= 4, 'the cron did not probe');
    for (const req of sellers.state.requests) {
      assert.equal(req.headers['x-payment'], undefined, `X-PAYMENT was sent to ${req.path}`);
      assert.equal(req.headers['payment-signature'], undefined);
      assert.equal(req.headers['user-agent'], MONITOR_UA);
    }
  });

  test('a host whose URL fails the guard is DROPPED, not recorded as dead', async () => {
    sellers.reset();
    await seed();
    // The worker runs with LINT_UNSAFE_TARGETS=1 so the mock is reachable, which
    // means the guard here has to be tripped by something it refuses even
    // relaxed: a URL that is not a URL at all.
    await worker.d1(
      `INSERT INTO monitor_readings (day, host, ae_uptime, bz_resource, bz_method)
       VALUES ('${day}', 'garbage.example', 0, 'not-a-url-at-all', 'POST')`
    );
    await runCron(PROBE_CRON);
    const probes = await worker.d1(`SELECT host FROM monitor_probes WHERE day = '${day}'`);
    assert.ok(!probes.some((p) => p.host === 'garbage.example'), 'a refusal was written as a fact about the host');
    const [meta] = await worker.d1(`SELECT roster_size FROM monitor_days WHERE day = '${day}'`);
    assert.equal(meta.roster_size, 3, 'roster_size counts probes written, not hosts considered');
  });

  test('a probe cron with no readings for the day writes nothing', async () => {
    sellers.reset();
    await worker.d1('DELETE FROM monitor_readings');
    await worker.d1('DELETE FROM monitor_probes');
    await worker.d1('DELETE FROM monitor_days');
    await runCron(PROBE_CRON);
    assert.equal(sellers.state.requests.length, 0);
    const days = await worker.d1('SELECT COUNT(*) AS n FROM monitor_days');
    assert.equal(days[0].n, 0, 'an empty day must not fabricate a day row');
  });

  test('a re-capture after a probe does not wipe the probe half of the day row', async () => {
    // The two-phase write, end to end and in the order production runs it.
    // Deliberately LAST in this file: it leaves real-hostname readings in the
    // table, and nothing may probe after it.
    sellers.reset();
    instruments.reset();
    await seed();
    await runCron(PROBE_CRON);
    const [probed] = await worker.d1(`SELECT roster_size, wrongly_dead FROM monitor_days WHERE day = '${day}'`);
    assert.equal(probed.roster_size, 3);
    assert.equal(probed.wrongly_dead, 1);

    await runCron(CAPTURE_CRON);
    const [after] = await worker.d1(`SELECT * FROM monitor_days WHERE day = '${day}'`);
    assert.equal(after.roster_size, 3, 'the re-capture clobbered the probe cron');
    assert.equal(after.wrongly_dead, 1);
    assert.equal(after.population, 12, 'and it did rewrite its own columns');
    assert.equal(after.contradictions, 2);
  });
});

// ==================================================================
describe('the schedule itself', () => {
  test('wrangler.toml fires exactly the crons scheduled() dispatches on', async () => {
    // The dispatch is on the cron STRING, so a schedule in the TOML that no
    // branch matches would deploy as a silent no-op every day forever.
    const toml = await readFile(join(ROOT, 'wrangler.toml'), 'utf8');
    const block = toml.match(/^crons\s*=\s*\[([^\]]*)\]/m);
    assert.ok(block, 'no [triggers] crons array in wrangler.toml');
    const crons = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(crons, [CAPTURE_CRON, PROBE_CRON]);
  });

  test('the two crons share an hour schedule, probe thirty minutes after capture', () => {
    // The hour field went from a literal (11) to a step (*/6) on 2026-08-28
    // when the owner bumped the cadence — so the assertion is in two parts:
    // identical hour expressions (whatever their shape, both crons fire in the
    // same hours), and a 30-minute gap in the minute field, capture first.
    // The gap is what the probe depends on: its roster is derived from the
    // capture that just ran.
    const fields = (cron) => cron.split(' ');
    assert.equal(fields(CAPTURE_CRON)[1], fields(PROBE_CRON)[1], 'the crons fire in different hours');
    assert.equal(Number(fields(PROBE_CRON)[0]) - Number(fields(CAPTURE_CRON)[0]), 30);
  });
});
