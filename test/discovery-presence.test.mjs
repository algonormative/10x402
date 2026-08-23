// The self-published presence surface, against mock DNS and a mock origin.
//
// Same posture as test/presence.test.mjs: the seams the surface uses in
// production (PRESENCE_DOH_BASE, PRESENCE_WK_ORIGIN) are pointed at 127.0.0.1,
// and nothing in this file resolves a real name or reads a real host.
//
// ------------------------------------------------------------ known-positive
//
// The first test is the one this file exists for. A negative control cannot
// detect a reader that returns nothing: a resolver that answers "no record" to
// every query is indistinguishable, from the outside, from a world in which
// nobody publishes — and the honest reading of this whole surface's population
// numbers depends on being able to rule that out. So the suite serves the REAL
// bytes of the one conformant record in the deployed population and requires
// `listed`. If that ever stops passing, every `not_found` this surface reports
// is unsupported, and the failure says so.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { assembleSelfPublished, observeSelfPublished, CONTROL_LABEL } from '../worker/presence-discovery.js';

/**
 * One server standing in for both seams, routed by path — which also proves the
 * module builds each URL from its own base rather than assuming a shared layout.
 *
 *   /dns-query?name=…&type=TXT   the DoH resolver
 *   /<host>/.well-known/<path>   the seller's origin
 */
async function startMocks() {
  const state = {
    txt: new Map(),        // name -> string[]   (absent = NXDOMAIN)
    dnsStatus: new Map(),  // name -> DNS rcode override
    dnsFail: new Set(),    // name -> answer 500
    wk: new Map(),         // "<host><path>" -> { status, body, contentType }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/dns-query') {
      const name = url.searchParams.get('name') || '';
      if (state.dnsFail.has(name)) {
        res.writeHead(500);
        return res.end('resolver said no');
      }
      const records = state.txt.get(name);
      const status = state.dnsStatus.has(name) ? state.dnsStatus.get(name) : records ? 0 : 3;
      const body = {
        Status: status,
        Answer: (records || []).map((data) => ({ name, type: 16, TTL: 300, data })),
      };
      res.writeHead(200, { 'content-type': 'application/dns-json' });
      return res.end(JSON.stringify(body));
    }

    const key = url.pathname.replace(/^\//, '');
    const slash = key.indexOf('/');
    const host = slash === -1 ? key : key.slice(0, slash);
    const path = slash === -1 ? '' : key.slice(slash);
    const canned = state.wk.get(`${host}${path}`);
    if (!canned) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(canned.status, { 'content-type': canned.contentType || 'application/json' });
    return res.end(canned.body ?? '');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    env: {
      PRESENCE_DOH_BASE: `http://127.0.0.1:${port}`,
      PRESENCE_WK_ORIGIN: `http://127.0.0.1:${port}`,
      FETCH_TIMEOUT_MS: '4000',
    },
    reset: () => {
      state.txt.clear();
      state.dnsStatus.clear();
      state.dnsFail.clear();
      state.wk.clear();
    },
    stop: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))),
  };
}

/** A structurally valid manifest, as JSON text. */
const manifestFor = (host, extra = {}) =>
  JSON.stringify({
    x402Version: 2,
    kind: 'resource-server',
    name: host,
    resources: [{ url: `https://${host}/api`, method: 'POST' }],
    ...extra,
  });

let mocks;
before(async () => {
  mocks = await startMocks();
});
after(async () => {
  await mocks?.stop();
});

const run = async (host) => assembleSelfPublished(await observeSelfPublished(host, mocks.env));

describe('self-published surface: the known-positive', () => {
  test('the real api.sirenic.eu record, served verbatim, reads as listed', async () => {
    mocks.reset();
    // Observed 2026-08-22. The only conformant _x402 record in a 1,609-host
    // census — copied here as bytes, not paraphrased.
    mocks.state.txt.set(
      '_x402.api.sirenic.eu',
      ['v=x402-1; wk=https://api.sirenic.eu/.well-known/x402; k=resource-server; net=eip155:8453; scheme=exact']
    );
    mocks.state.wk.set('api.sirenic.eu/.well-known/x402', { status: 200, body: manifestFor('api.sirenic.eu') });

    const got = await run('api.sirenic.eu');
    assert.equal(got.verdict, 'listed', 'the reader cannot see a record that is there — every not_found it reports is unsupported');
    assert.equal(got.evidence.dns.verdict, 'published');
    assert.equal(got.evidence.dns.record.k, 'resource-server');
    assert.deepEqual(got.evidence.dns.record.net, ['eip155:8453']);
    assert.equal(got.evidence.manifest.verdict, 'valid');
    assert.equal(got.fix, null, 'nothing to fix, so nothing to say');
  });
});

describe('self-published surface: absence', () => {
  test('no record and no manifest is not_found, with both fixes', async () => {
    mocks.reset();
    const got = await run('quiet.example.com');
    assert.equal(got.verdict, 'not_found');
    assert.equal(got.evidence.dns.verdict, 'not_found');
    assert.equal(got.evidence.manifest.verdict, 'not_found');
    assert.match(got.fix, /Serve a JSON manifest/);
    assert.match(got.fix, /v=x402-1; wk=https:\/\/quiet\.example\.com\/\.well-known\/x402/);
  });

  test('the fix string it hands back is itself a conformant record', async () => {
    mocks.reset();
    const got = await run('quiet.example.com');
    // Generated, never typed — so assert it parses rather than that it matches
    // a string somebody wrote in a comment.
    const { parseTxtRecord } = await import('../worker/discovery-grammar.js');
    const value = got.fix.match(/(v=x402-1;[^—]+?)\s+—/)[1].trim();
    assert.ok(parseTxtRecord(value), `the record we told the seller to publish does not parse: ${value}`);
  });
});

describe('self-published surface: the population this exists for', () => {
  test('a manifest one edit from valid says which edit, and that it is one', async () => {
    mocks.reset();
    // 426 of 910 hosts in the census fail on nothing but `kind`.
    mocks.state.wk.set('seller.example.com/.well-known/x402', {
      status: 200,
      body: JSON.stringify({ x402Version: 2, resources: [{ url: 'https://seller.example.com/api' }] }),
    });

    const got = await run('seller.example.com');
    assert.equal(got.verdict, 'not_found');
    assert.equal(got.evidence.manifest.verdict, 'one_edit_away');
    assert.deepEqual(got.evidence.manifest.violations.map((v) => v.field), ['kind']);
    assert.equal(got.evidence.manifest.violations[0].introducedBy, 'x402-discovery');
    assert.match(got.fix, /one-line edit, not a rewrite/);
  });

  test('a core fault is reported as invalid, not as one edit away', async () => {
    mocks.reset();
    mocks.state.wk.set('seller.example.com/.well-known/x402', {
      status: 200,
      body: JSON.stringify({ kind: 'resource-server', resources: [] }),
    });
    const got = await run('seller.example.com');
    assert.equal(got.evidence.manifest.verdict, 'invalid');
    assert.ok(got.evidence.manifest.violations.some((v) => v.introducedBy === 'core'));
    assert.doesNotMatch(got.fix, /one-line edit/);
  });

  test('a near-miss record is reported as a near-miss, never as absence', async () => {
    mocks.reset();
    // tablint.dev, observed 2026-08-22. Two tokens from conformant.
    mocks.state.txt.set('_x402.tablint.dev', ['v=x4021;url=https://tablint.dev/.well-known/x402']);
    mocks.state.wk.set('tablint.dev/.well-known/x402', { status: 200, body: manifestFor('tablint.dev') });

    const got = await run('tablint.dev');
    assert.equal(got.evidence.dns.verdict, 'near_miss');
    assert.equal(got.evidence.dns.manifest_url_found, 'https://tablint.dev/.well-known/x402');
    assert.equal(got.evidence.dns.hints.length, 2);
    assert.match(got.fix, /A record IS published/);
    assert.match(got.fix, /v=x402-1; wk=https:\/\/tablint\.dev\/\.well-known\/x402/);
  });

  test('a malformed record is a fault, and is not silently skipped', async () => {
    mocks.reset();
    mocks.state.txt.set('_x402.broken.example.com', ['v=x402-1; wk=http://broken.example.com/.well-known/x402']);
    const got = await run('broken.example.com');
    assert.equal(got.evidence.dns.verdict, 'malformed');
    assert.match(got.evidence.dns.why, /HTTPS/);
  });

  test('a wk pointing off-domain is refused even though the grammar is perfect', async () => {
    mocks.reset();
    mocks.state.txt.set('_x402.seller.example.com', ['v=x402-1; wk=https://attacker.example/.well-known/x402']);
    const got = await run('seller.example.com');
    assert.equal(got.evidence.dns.verdict, 'malformed');
    assert.match(got.evidence.dns.why, /outside/);
  });
});

describe('self-published surface: the controls', () => {
  test('a wildcard TXT zone is unknown, never an adopter', async () => {
    mocks.reset();
    // What _x402.acu.run actually returns: the zone's SPF record, because the
    // zone answers every name. Without the control this counts as a publisher
    // in a rival dialect — the first census run reported 18 of these.
    const spf = 'v=spf1 include:spf.efwd.registrar-servers.com ~all';
    mocks.state.txt.set('_x402.wild.example.com', [spf]);
    mocks.state.txt.set(`_${CONTROL_LABEL}.wild.example.com`, [spf]);

    const got = await run('wild.example.com');
    assert.equal(got.evidence.dns.verdict, 'unknown');
    assert.match(got.evidence.dns.why, /answers every name/);
    assert.equal(got.verdict, 'unknown', 'a surface with an unreadable half may not report not_found');
  });

  test('a soft-200 host is unknown, and is not graded on its own index page', async () => {
    mocks.reset();
    mocks.state.wk.set('soft.example.com/.well-known/x402', { status: 200, body: '<html>home</html>', contentType: 'text/html' });
    mocks.state.wk.set(`soft.example.com/.well-known/${CONTROL_LABEL}`, { status: 200, body: '<html>home</html>', contentType: 'text/html' });

    const got = await run('soft.example.com');
    assert.equal(got.evidence.manifest.verdict, 'unknown');
    assert.match(got.evidence.manifest.why, /answers every path/);
  });

  test('the two controls are independent — a wildcard zone does not blind the HTTP leg', async () => {
    mocks.reset();
    mocks.state.txt.set('_x402.mixed.example.com', ['v=spf1 ~all']);
    mocks.state.txt.set(`_${CONTROL_LABEL}.mixed.example.com`, ['v=spf1 ~all']);
    mocks.state.wk.set('mixed.example.com/.well-known/x402', { status: 200, body: manifestFor('mixed.example.com') });

    const got = await run('mixed.example.com');
    assert.equal(got.evidence.dns.verdict, 'unknown');
    assert.equal(got.evidence.manifest.verdict, 'valid', 'a wildcard TXT zone says nothing about the well-known path');
  });
});

describe('self-published surface: declining rather than guessing', () => {
  test('a resolver that fails is unknown, not not_found', async () => {
    mocks.reset();
    mocks.state.dnsFail.add(`_${CONTROL_LABEL}.down.example.com`);
    const got = await run('down.example.com');
    assert.equal(got.evidence.dns.verdict, 'unknown');
    assert.match(got.evidence.dns.why, /DNS-over-HTTPS lookup/);
  });

  test('SERVFAIL is a decline, not an absence', async () => {
    mocks.reset();
    mocks.state.dnsStatus.set('_x402.servfail.example.com', 2);
    const got = await run('servfail.example.com');
    assert.equal(got.evidence.dns.verdict, 'unknown');
    assert.match(got.evidence.dns.why, /DNS status 2/);
  });

  test('200 with something that is not JSON is invalid, and says so exactly', async () => {
    mocks.reset();
    mocks.state.wk.set('html.example.com/.well-known/x402', { status: 200, body: '<html>oops</html>', contentType: 'text/html' });
    const got = await run('html.example.com');
    assert.equal(got.evidence.manifest.verdict, 'invalid');
    assert.match(got.evidence.manifest.violations[0].message, /not JSON/);
  });

  test('a host with no observation at all is unknown with the reason named', () => {
    const got = assembleSelfPublished({ ok: false, why: 'the self-published surface was not observed on this run' });
    assert.equal(got.verdict, 'unknown');
    assert.match(got.why, /not observed/);
  });

  test('a hostname the surface cannot query is refused rather than guessed', async () => {
    mocks.reset();
    const got = await run('not a host/path');
    assert.equal(got.verdict, 'unknown');
  });
});

describe('self-published surface: the resolution order', () => {
  test("an ancestor's record is used only when its manifest names the host", async () => {
    mocks.reset();
    // The platform publishes at the apex and names exactly one tenant.
    mocks.state.txt.set('_x402.platform.example', ['v=x402-1; wk=https://platform.example/.well-known/x402']);
    mocks.state.wk.set('platform.example/.well-known/x402', {
      status: 200,
      body: JSON.stringify({
        x402Version: 2,
        kind: 'resource-server',
        resources: [{ url: 'https://tenant-a.platform.example/api' }],
      }),
    });

    // Tenant B publishes nothing of its own and is not named. A record found at
    // the ancestor must not make it an adopter.
    const tenantB = await run('tenant-b.platform.example');
    assert.equal(tenantB.verdict, 'not_found', 'one platform record would otherwise vouch for every tenant beneath it');
  });

  test('the walk stops at the first name that answers, so a broken host record is not masked by a good parent', async () => {
    mocks.reset();
    mocks.state.txt.set('_x402.api.example.com', ['v=x402-1; wk=http://api.example.com/.well-known/x402']); // broken: HTTP
    mocks.state.txt.set('_x402.example.com', ['v=x402-1; wk=https://example.com/.well-known/x402']);        // fine

    const got = await run('api.example.com');
    assert.equal(got.evidence.dns.verdict, 'malformed', "the host's own broken record is the answer, not its parent's good one");
    assert.equal(got.evidence.dns.found_at, 'api.example.com');
  });

  test('the apex arrangement the draft was corrected for: record at the apex, manifest on a subdomain', async () => {
    mocks.reset();
    // The census recorded the draft's own author as a non-publisher because of
    // exactly this shape — one DNS zone in front of several hosts.
    mocks.state.txt.set('_x402.flareclaw.app', ['v=x402-1; wk=https://api.flareclaw.app/.well-known/x402; k=facilitator']);
    mocks.state.wk.set('flareclaw.app/.well-known/x402', { status: 200, body: manifestFor('flareclaw.app') });

    const got = await run('flareclaw.app');
    assert.equal(got.evidence.dns.verdict, 'published');
    assert.equal(got.evidence.dns.record.wk, 'https://api.flareclaw.app/.well-known/x402');
  });
});

describe('self-published surface: DNS wire details', () => {
  test('a chunked TXT record concatenates rather than splitting into two', async () => {
    mocks.reset();
    // A single RR longer than 255 bytes arrives as several quoted strings. They
    // join with NO separator; splitting on the space would shred a long wk URL
    // into two records and diagnose both as foreign.
    mocks.state.txt.set('_x402.long.example.com', ['"v=x402-1; wk=https://long.example.com/.wel" "l-known/x402"']);
    mocks.state.wk.set('long.example.com/.well-known/x402', { status: 200, body: manifestFor('long.example.com') });

    const got = await run('long.example.com');
    assert.equal(got.evidence.dns.verdict, 'published');
    assert.equal(got.evidence.dns.record.wk, 'https://long.example.com/.well-known/x402');
  });

  test('a foreign record at the name is an absence of an x402 record, not a fault', async () => {
    mocks.reset();
    mocks.state.txt.set('_x402.other.example.com', ['google-site-verification=abc123']);
    const got = await run('other.example.com');
    assert.equal(got.evidence.dns.verdict, 'not_found');
    assert.match(got.evidence.dns.note, /none of them about x402/);
  });

  test('two conformant records at one name is refused, not resolved by picking', async () => {
    mocks.reset();
    mocks.state.txt.set('_x402.two.example.com', [
      'v=x402-1; wk=https://two.example.com/.well-known/x402',
      'v=x402-1; wk=https://two.example.com/other.json',
    ]);
    const got = await run('two.example.com');
    assert.equal(got.evidence.dns.verdict, 'malformed');
    assert.match(got.evidence.dns.why, /ambiguous/);
  });
});
