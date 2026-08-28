// Parallax's SURFACES: the two free reads, the three paid endpoints, and the
// vocabulary all five share.
//
// The substrate suite (test/monitor-substrate.test.mjs) proves the crons write
// the right rows. This one starts from rows that are already there — seeded
// straight into D1 with the harness's own client — and asks what a caller gets
// back. NOTHING HERE TOUCHES THE NETWORK, and this time that is not even a
// discipline: the surfaces make no outbound request by construction, which is
// itself one of the assertions below.
//
// ------------------------------------------------------------------ what is actually being tested
//
// NULL IS NOT ZERO, over and over, because every one of those pairs is two
// opposite claims about somebody's business:
//
//   wrongly_dead NULL   the probe half of the day has not run. Rendering it as
//                       0 would publish "nobody is wrongly dead" every morning
//                       between 11:17 and 11:47, which is the exact finding
//                       this wing exists to sell.
//   status 0            we asked and got no HTTP answer at all.
//   status NULL         we never asked.
//   saw_v2_header 0     we looked at a response and the header was absent.
//   saw_v2_header NULL  there was no response to look at.
//   an instrument's columns all NULL — that instrument had no row for this
//   host, which is a fact about the instrument and never a zero about the host.
//
// And THIRD-PARTY TEXT IS ESCAPED. `bz_resource` is written by whoever settles
// a payment against a URL, so a seller can put anything they like in it and it
// reaches the HTML page. One fixture row below carries a script tag for exactly
// that reason.
//
// STANDALONE, and it seeds its own store: the empty-state assertions have to
// run against a database with no capture in it, which is not a state a shared
// worker could be relied on to be in.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { bootWorker, callers, client, TIER_ON_VARS } from './harness.mjs';
import { ENDPOINTS, ENDPOINTS_BY_ID, priceLabel } from '../worker/catalog.js';
import { runSample } from '../worker/envelope.js';
import { MONITOR_CONTROL } from '../worker/monitor-control.js';
import { sha256Bytes, sha256HexSync } from '../worker/sha256.js';
import {
  STALE_AFTER_HOURS,
  assembleReceipt,
  canonicalJson,
  flagsFor,
  freshness,
  instrumentViews,
  mergeSeries,
  monitorSample,
  monitorSubject,
  probeView,
} from '../worker/monitor-surfaces.js';

const ips = callers('monitor-surfaces');
let worker;
let api;

/** The day every seeded row belongs to — today, the way both crons compute it. */
const DAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/**
 * A hostile catalogue resource, of the shape a seller can actually write.
 *
 * A Bazaar row is written by SETTLEMENT: pay once against a URL you control and
 * that string is in the catalogue, in our table, and on our HTML page. This one
 * closes an attribute and opens a script tag, which is what an injection into
 * an unescaped `href` or text node would look like.
 */
const HOSTILE_RESOURCE = 'https://evil.example/x"><script>alert(1)</script>';

before(async () => {
  worker = await bootWorker({ vars: { ...TIER_ON_VARS } });
  api = client(worker);
});
after(async () => {
  await worker?.stop();
});

// ------------------------------------------------------------------ seeding

/**
 * Empty the three monitor tables in ONE round trip.
 *
 * Every `worker.d1()` is a `wrangler d1 execute` process spawn — around 700 ms
 * of the suite's wall clock each — so the seeding helpers below batch their
 * statements rather than issuing one call per row. The suite is run on every
 * commit; a helper that costs a second is a helper that costs an hour a month.
 */
const wipe = () => worker.d1('DELETE FROM monitor_readings; DELETE FROM monitor_probes; DELETE FROM monitor_days;');

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function readingSql(row) {
  const cols = {
    day: DAY,
    ae_uptime: null,
    ae_score: null,
    ae_tier: null,
    ae_settled_14d: null,
    ae_organic: null,
    ae_flag: null,
    at_score: null,
    at_down: null,
    at_endpoints: null,
    bz_calls_30d: null,
    bz_unique_payers: null,
    bz_last_called: null,
    bz_resource: null,
    bz_method: null,
    ...row,
  };
  const keys = Object.keys(cols);
  return `INSERT INTO monitor_readings (${keys.join(', ')}) VALUES (${keys.map((k) => q(cols[k])).join(', ')});`;
}

function probeSql(row) {
  const cols = {
    day: DAY,
    ts: Math.floor(Date.now() / 1000) - 600,
    declared_method: 'POST',
    declared_status: null,
    declared_ms: null,
    get_status: null,
    get_ms: null,
    saw_v2_header: null,
    saw_v1_body: null,
    ...row,
  };
  const keys = Object.keys(cols);
  return `INSERT INTO monitor_probes (${keys.join(', ')}) VALUES (${keys.map((k) => q(cols[k])).join(', ')});`;
}

function daySql(row = {}) {
  const cols = {
    day: DAY,
    population: 2185,
    captured_ae: 1,
    captured_at: 1,
    captured_bazaar: 1,
    roster_size: null,
    wrongly_dead: null,
    contradictions: 1,
    ...row,
  };
  const keys = Object.keys(cols);
  return `INSERT INTO monitor_days (${keys.join(', ')}) VALUES (${keys.map((k) => q(cols[k])).join(', ')});`;
}

/** Wipe, then write a whole fixture — one statement list, one round trip. */
const seed = (...statements) =>
  worker.d1(
    'DELETE FROM monitor_readings; DELETE FROM monitor_probes; DELETE FROM monitor_days; ' +
      statements.join(' ')
  );

/** THE WRONGED HOST, from the 2026-08-27 capture: rated dead, settling, POST-declared. */
const WRONGED = {
  host: 'socialx402.com',
  ae_uptime: 0,
  ae_score: 0,
  ae_tier: 'D',
  ae_settled_14d: 173.76,
  ae_organic: 49,
  at_score: 100,
  at_down: 0,
  at_endpoints: 1,
  bz_calls_30d: 2,
  bz_unique_payers: 1,
  bz_last_called: '2026-08-21T05:19:03.972Z',
  bz_resource: 'https://socialx402.com/api/sc/facebook/adLibrary/company/ads',
  bz_method: 'POST',
};

const getJson = async (path, opts = {}) => {
  const res = await api.request(path, { method: 'GET', ...opts });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* the assertion will say so */
  }
  return { status: res.status, headers: res.headers, text, body };
};

const getHtml = (path, opts = {}) =>
  api.request(path, { method: 'GET', ...opts, headers: { accept: 'text/html', ...(opts.headers || {}) } });

// ------------------------------------------------------------------ pure: the digest

describe('the receipt digest', () => {
  test('SHA-256 agrees with the platform, byte for byte', async () => {
    // The hand-rolled implementation exists because sampleOutput() cannot await
    // (see worker/sha256.js). It is only allowed to exist while it agrees with
    // WebCrypto — so the platform's own digest is the oracle, not a fixture.
    for (const input of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), '10x402'.repeat(500)]) {
      const bytes = new TextEncoder().encode(input);
      const platform = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      assert.deepEqual([...sha256Bytes(bytes)], [...platform], `digest differs for a ${input.length}-byte input`);
    }
    // And the NIST vector, written out, so a change to both sides at once is
    // still caught.
    assert.equal(sha256HexSync('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('canonical JSON sorts keys at every depth and keeps array order', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, 1, 2] } }), '{"a":{"c":[3,1,2],"d":2},"b":1}');
    // Insertion order must not change the bytes: that is the whole point.
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
    assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
    assert.equal(canonicalJson([{ z: 1, a: 2 }]), '[{"a":2,"z":1}]');
  });

  test('recomputing it the way the document says to reproduces it', () => {
    // The `verify` field is an instruction, and an instruction nobody follows
    // is a decoration. This test IS the instruction, executed.
    const receipt = monitorSample('monitor-receipt');
    const { digest, ...body } = receipt;
    assert.equal(sha256HexSync(canonicalJson(body)), digest.value);
    assert.equal(digest.algorithm, 'SHA-256');
    assert.match(digest.over, /except `digest`/);
    assert.match(receipt.verify, /canonical JSON/);
    // Stated plainly, because a digest that got read as a signature would be
    // worse than no digest at all.
    assert.match(receipt.verify, /NOT a signature/);
  });

  test('one changed byte anywhere in the series changes it', () => {
    const subject = monitorSubject('10x402.com');
    const series = mergeSeries(MONITOR_CONTROL.readings, MONITOR_CONTROL.probes);
    const now = MONITOR_CONTROL.now;
    const first = assembleReceipt({ subject, series, now });

    const tampered = mergeSeries(
      [{ ...MONITOR_CONTROL.readings[0], ae_settled_14d: 1.34 }],
      MONITOR_CONTROL.probes
    );
    const second = assembleReceipt({ subject, series: tampered, now });
    assert.notEqual(first.digest.value, second.digest.value);
  });
});

// ------------------------------------------------------------------ pure: the vocabulary

describe('NULL and 0 are rendered as the different claims they are', () => {
  test('a probe status of 0 is "asked, no answer" and NULL is "never asked"', () => {
    const asked = probeView({ ts: 1, declared_method: 'POST', declared_status: 0, declared_ms: 9800, get_status: 0 });
    assert.equal(asked.declared.asked, true);
    assert.equal(asked.declared.answered, false);
    assert.equal(asked.declared.status, null);
    assert.match(asked.declared.reads, /no HTTP answer/);

    const never = probeView({ ts: 1, declared_method: 'PUT', declared_status: null, get_status: 404 });
    assert.equal(never.declared.asked, false);
    assert.equal(never.declared.answered, null);
    assert.match(never.declared.reads, /not asked/);
    // The GET half of the same row was asked and answered — the two are read
    // independently, which is the whole point of storing them separately.
    assert.equal(never.get.status, 404);
  });

  test('evidence is three-valued: seen, absent, and never looked at', () => {
    const looked = probeView({ ts: 1, declared_status: 402, saw_v2_header: 1, saw_v1_body: 0 });
    assert.equal(looked.evidence.payment_required_header.seen, true);
    assert.equal(looked.evidence.v1_body_x402version.seen, false);
    assert.match(looked.evidence.v1_body_x402version.reads, /absent/);

    const blind = probeView({ ts: 1, declared_status: null, saw_v2_header: null, saw_v1_body: null });
    assert.equal(blind.evidence.payment_required_header.seen, null);
    assert.match(blind.evidence.payment_required_header.reads, /never inspected/);
  });

  test('an instrument with no row is "not observed", never a zero', () => {
    const views = instrumentViews({ ...WRONGED, at_score: null, at_down: null, at_endpoints: null });
    assert.equal(views.apistrust.observed, false);
    assert.equal(views.apistrust.score, null);
    assert.equal(views.apistrust.endpoints_down, null);
    assert.match(views.apistrust.reads, /not in the host table/);
    // …while a real zero is reported as a zero, and says so.
    assert.equal(views.agenteconomy.uptime, 0);
    assert.match(views.agenteconomy.reads, /uptime 0\.0 — dead at this instrument/);
  });

  test('no probe at all carries WHY, and the three reasons are different', () => {
    assert.match(probeView(null, { probeable: false }).reads, /wallet address/);
    assert.match(probeView(null, { hasResource: false }).reads, /no catalogue resource/);
    assert.match(probeView(null, {}).reads, /roster|has not run yet/);
  });
});

describe('the flags are the substrate\'s own predicates', () => {
  test('wrongly-dead needs the PROBE, not just the rating', () => {
    // Dead at the rater and settling money is a CANDIDATE. It becomes a finding
    // only when the endpoint itself answered 402 on its declared verb — the
    // measurement nobody else takes, and the reason this wing exists.
    const candidate = flagsFor(WRONGED, null);
    assert.deepEqual(candidate.map((f) => f.id).sort(), ['liveness-contradiction', 'wrongly-dead-candidate']);
    assert.match(candidate.find((f) => f.id === 'wrongly-dead-candidate').statement, /CANDIDATE ONLY/);

    const confirmed = flagsFor(WRONGED, { declared_status: 402, declared_method: 'POST' });
    assert.deepEqual(confirmed.map((f) => f.id).sort(), ['liveness-contradiction', 'wrongly-dead']);

    // A probe that found something else does NOT confirm it.
    const refuted = flagsFor(WRONGED, { declared_status: 500, declared_method: 'POST' });
    assert.deepEqual(refuted.map((f) => f.id).sort(), ['liveness-contradiction', 'wrongly-dead-candidate']);
    assert.match(refuted.find((f) => f.id === 'wrongly-dead-candidate').statement, /did not find a 402/);
  });

  test('a contradiction needs BOTH instruments present — a NULL is not a disagreement', () => {
    const oneEyed = { ...WRONGED, at_score: null, at_down: null };
    assert.ok(!flagsFor(oneEyed, null).some((f) => f.id === 'liveness-contradiction'));
    // And the two instruments agreeing that it is down is not one either.
    assert.ok(!flagsFor({ ...WRONGED, at_down: 1 }, null).some((f) => f.id === 'liveness-contradiction'));
  });
});

describe('freshness', () => {
  const now = Date.parse('2026-08-27T12:00:00Z');

  test('a probe older than the bound is called stale, in the payload', () => {
    const old = { ts: Math.floor(now / 1000) - (STALE_AFTER_HOURS + 5) * 3600 };
    const f = freshness({ day: '2026-08-25', probe: old, now });
    assert.equal(f.stale, true);
    assert.equal(f.stale_after_hours, STALE_AFTER_HOURS);
    assert.match(f.reads, /STALE/);
    assert.equal(f.days_behind_utc_today, 2);
  });

  test('inside the bound it is not stale, and says how old it is', () => {
    const fresh = { ts: Math.floor(now / 1000) - 3600 };
    const f = freshness({ day: '2026-08-27', probe: fresh, now });
    assert.equal(f.stale, false);
    assert.equal(f.probe_age_hours, 1);
  });

  test('with no probe, stale is NULL — not false, which would be a claim', () => {
    const f = freshness({ day: '2026-08-26', probe: null, now });
    assert.equal(f.stale, null);
    assert.equal(f.probe_age_hours, null);
    assert.match(f.reads, /no timestamp to age/);
  });
});

// ------------------------------------------------------------------ pure: the published samples

describe('the published envelope samples', () => {
  for (const endpoint of ENDPOINTS.filter((e) => e.kind === 'monitor')) {
    test(`${endpoint.path} publishes a real run over the frozen control`, () => {
      const out = runSample(endpoint);
      assert.equal(out.kind, 'monitor');
      assert.equal(out.host, '10x402.com');
      // Not hand-typed: the values are the control's, and the control is a
      // capture. If the assembler changes, this changes with it.
      assert.equal(out.as_of, '2026-08-27');
    });
  }

  test('the verdict sample shows the finding the wing exists to sell', () => {
    const verdict = monitorSample('monitor-verdict');
    assert.deepEqual(verdict.flags.map((f) => f.id).sort(), ['liveness-contradiction', 'wrongly-dead']);
    assert.equal(verdict.probe.declared.status, 402);
    assert.equal(verdict.probe.get.status, 405);
    // The control recorded statuses and not latencies, and the surface renders
    // that as "not recorded" rather than as a zero.
    assert.equal(verdict.probe.declared.latency_ms, null);
    assert.match(verdict.probe.declared.reads, /latency not recorded/);
  });

  test('it is stamped with the control\'s frozen clock, so the envelope does not churn', () => {
    // Built from Date.now() the published 402 header would differ every day for
    // no reason anyone could act on.
    assert.equal(monitorSample('monitor-verdict').freshness.probe_age_hours, monitorSample('monitor-verdict').freshness.probe_age_hours);
    assert.equal(monitorSample('monitor-receipt').issued_at, new Date(MONITOR_CONTROL.now).toISOString());
  });

  test('the published sample input is one a caller could send verbatim', () => {
    for (const endpoint of ENDPOINTS.filter((e) => e.kind === 'monitor')) {
      const subject = monitorSubject(endpoint.sample.host);
      assert.ok(!subject.error, `${endpoint.path} publishes a sample host the validator refuses`);
    }
  });
});

describe('the subject validator', () => {
  test('takes a hostname, a URL, or the rater\'s bare wallet key', () => {
    assert.deepEqual(monitorSubject('SocialX402.com'), { host: 'socialx402.com', kind: 'host', probeable: true });
    assert.equal(monitorSubject('https://socialx402.com/api/x?y=1').host, 'socialx402.com');
    // 234 of the rater's rows are these. They are real rated services with real
    // settlement and nothing to probe, so they are answerable and marked.
    const wallet = monitorSubject('0x07cf5359edb7d8de42973562c54e4c8d583c2396');
    assert.equal(wallet.kind, 'wallet_key');
    assert.equal(wallet.probeable, false);
  });

  test('refuses what is not a subject, with a fix rather than a shrug', () => {
    for (const bad of ['', '   ', 'localhost', 'not a host', '../../etc/passwd', 'a/b.com', 42, null]) {
      const out = monitorSubject(bad);
      assert.ok(out.error, `${JSON.stringify(bad)} was accepted`);
      assert.match(out.fix, /host/);
    }
  });
});

// ------------------------------------------------------------------ the free surfaces

describe('GET /monitor with nothing captured yet', () => {
  test('is a working page that says so, not a 500 and not a zero', async () => {
    // A day with no capture is a real operating state — the first day, and any
    // day the cron did not run. Reporting it as zeros would be publishing that
    // the market is empty.
    await wipe();
    const { status, body } = await getJson('/monitor', { ip: ips.next() });
    assert.equal(status, 200);
    assert.equal(body.state, 'no-capture');
    assert.equal(body.as_of, null);
    assert.equal(body.counts, null);
    assert.match(body.notes[0], /NO CAPTURE HAS BEEN STORED YET/);
    // It still sells: the prices are on it either way.
    assert.equal(body.endpoints.length, 3);
  });

  test('an unknown host is a 404 that names the roster criteria', async () => {
    const { status, body } = await getJson('/monitor/nobody.example', { ip: ips.next() });
    assert.equal(status, 404);
    assert.equal(body.state, 'unknown');
    assert.match(body.criteria, /appeared in any of the three instruments/);
    assert.match(body.criteria, /roster/);
    assert.match(body.fix, /presence|lint/);
  });

  test('a host-shaped path that is not a host is refused the same way', async () => {
    const { status, body } = await getJson('/monitor/%3Cscript%3E', { ip: ips.next() });
    assert.equal(status, 404);
    assert.equal(body.state, 'unknown');
    assert.ok(body.error);
  });
});

describe('GET /monitor after a capture but BEFORE the probe', () => {
  before(async () => {
    await seed(
      daySql({ roster_size: null, wrongly_dead: null, contradictions: 1 }),
      readingSql(WRONGED),
      readingSql({ host: '0x07cf5359edb7d8de42973562c54e4c8d583c2396', ae_uptime: 0, ae_settled_14d: 500.9, ae_flag: 'UNLISTED' })
    );
  });

  test('wrongly_dead is NULL and the payload says what NULL means', async () => {
    // THE ASSERTION THIS WHOLE FILE IS FOR. Between 11:17 and 11:47 every day,
    // and on every day the probe fails, this field is NULL. A 0 here is a
    // published claim that nobody is wrongly dead.
    const { body } = await getJson('/monitor', { ip: ips.next() });
    assert.equal(body.state, 'captured');
    assert.equal(body.counts.wrongly_dead, null);
    assert.equal(body.as_of.roster_size, null);
    assert.equal(body.as_of.probe_has_run, false);
    assert.match(body.counts.wrongly_dead_reads, /NOT PROBED YET/);
    assert.match(body.counts.wrongly_dead_reads, /does NOT mean zero/i);
  });

  test('the HTML says it too, rather than printing a 0', async () => {
    const res = await getHtml('/monitor', { ip: ips.next() });
    const html = await res.text();
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(html, /not probed yet/i);
  });

  test('the population split names the wallet keys as unprobeable', async () => {
    const { body } = await getJson('/monitor', { ip: ips.next() });
    assert.equal(body.counts.rows_held, 2);
    assert.equal(body.counts.wallet_keys, 1);
    assert.equal(body.counts.with_catalogue_resource, 1);
  });

  test('a known host with no probe is the THIRD state, and it says which half is missing', async () => {
    const { status, body } = await getJson('/monitor/socialx402.com', { ip: ips.next() });
    assert.equal(status, 200);
    assert.equal(body.state, 'readings-only');
    assert.equal(body.probe.ran, false);
    assert.equal(body.freshness.stale, null);
    assert.match(body.probe.reads, /Not probed/);
    assert.equal(body.probe_absent.roster_cap, 400);
    // The readings half is all there — this is not a degraded answer, it is a
    // complete answer to half the question, saying which half.
    assert.equal(body.instruments.agenteconomy.uptime, 0);
    assert.equal(body.instruments.apistrust.endpoints_down, 0);
    assert.deepEqual(body.flags.map((f) => f.id).sort(), ['liveness-contradiction', 'wrongly-dead-candidate']);
  });

  test('a wallet key answers with its readings and says it can never be probed', async () => {
    const { status, body } = await getJson('/monitor/0x07cf5359edb7d8de42973562c54e4c8d583c2396', { ip: ips.next() });
    assert.equal(status, 200);
    assert.equal(body.subject_kind, 'wallet_key');
    assert.equal(body.probeable, false);
    assert.equal(body.instruments.agenteconomy.settled_usd_14d, 500.9);
    assert.match(body.unprobeable.reads, /wallet address/);
    assert.match(body.probe.reads, /never will be/);
  });
});

describe('GET /monitor after the probe', () => {
  before(async () => {
    await seed(
      daySql({ roster_size: 400, wrongly_dead: 249, contradictions: 127 }),
      readingSql(WRONGED),
      probeSql({
        host: 'socialx402.com',
        declared_method: 'POST',
        declared_status: 402,
        declared_ms: 118,
        get_status: 405,
        get_ms: 96,
        saw_v2_header: 1,
        saw_v1_body: 1,
      })
    );
  });

  test('the counts are numbers now, and the day says the probe ran', async () => {
    const { body } = await getJson('/monitor', { ip: ips.next() });
    assert.equal(body.state, 'probed');
    assert.equal(body.counts.wrongly_dead, 249);
    assert.equal(body.as_of.roster_size, 400);
    assert.equal(body.as_of.probe_has_run, true);
    assert.match(body.counts.wrongly_dead_reads, /answered 402/);
  });

  test('the top contradictions carry their probe and their flags', async () => {
    const { body } = await getJson('/monitor', { ip: ips.next() });
    assert.equal(body.top_contradictions.length, 1);
    const row = body.top_contradictions[0];
    assert.equal(row.host, 'socialx402.com');
    assert.equal(row.settled_usd_14d, 173.76);
    assert.equal(row.probe.declared.status, 402);
    assert.equal(row.probe.get.status, 405);
    assert.ok(row.flags.some((f) => f.id === 'wrongly-dead'));
  });

  test('the host page is the whole finding on one screen', async () => {
    const { status, body } = await getJson('/monitor/socialx402.com', { ip: ips.next() });
    assert.equal(status, 200);
    assert.equal(body.state, 'probed');
    assert.equal(body.instruments.agenteconomy.uptime, 0);
    assert.equal(body.instruments.apistrust.endpoints_down, 0);
    assert.equal(body.instruments.bazaar.declared_method, 'POST');
    assert.equal(body.probe.declared.status, 402);
    assert.equal(body.probe.get.status, 405);
    assert.equal(body.freshness.stale, false);
    assert.deepEqual(body.flags.map((f) => f.id).sort(), ['liveness-contradiction', 'wrongly-dead']);
    assert.match(body.probe.reads, /GET-only rater records as dead/);
  });

  test('the HTML renders the same three instruments and both verbs', async () => {
    const res = await getHtml('/monitor/socialx402.com', { ip: ips.next() });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /agenteconomy\.report/);
    assert.match(html, /apistrust\.com/);
    assert.match(html, /CDP Bazaar/);
    assert.match(html, />402</);
    assert.match(html, />405</);
    assert.match(html, /wrongly-dead/);
    // No script tag of our own: the page needs none, so it has none.
    assert.ok(!/<script/i.test(html), 'the page grew a script');
  });

  test('JSON is the default — an agent asking for anything else gets data', async () => {
    for (const accept of [undefined, '*/*', 'application/json', 'text/plain']) {
      const res = await api.request('/monitor/socialx402.com', {
        method: 'GET',
        ip: ips.next(),
        headers: accept ? { accept } : {},
      });
      assert.match(res.headers.get('content-type'), /application\/json/, `accept: ${accept}`);
      await res.text();
    }
  });
});

describe('third-party text on the page', () => {
  before(async () => {
    // A seller writes their own catalogue row by settling one payment against a
    // URL. Every one of these fields is theirs, and all of them reach the HTML.
    await seed(
      daySql({ roster_size: 1, wrongly_dead: 0, contradictions: 1 }),
      readingSql({
      ...WRONGED,
      host: 'hostile.example',
      ae_tier: '<b>AAA</b>',
      ae_flag: '"><img src=x onerror=alert(1)>',
        bz_resource: HOSTILE_RESOURCE,
        bz_method: '<script>POST</script>',
      })
    );
  });

  test('a script tag in a catalogue resource is escaped, not executed', async () => {
    const res = await getHtml('/monitor/hostile.example', { ip: ips.next() });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!html.includes('<script>alert(1)</script>'), 'the injected script tag survived into the page');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the resource was not rendered at all');
    // THE TEST IS FOR MARKUP, NOT FOR SCARY WORDS. `onerror=` appears in the
    // page as inert text and should — it is what the seller wrote. What must
    // never appear is a TAG they opened: escaping `<` and `"` is what makes the
    // difference, so those are what is asserted.
    assert.ok(!/<img/i.test(html), 'an injected <img> tag survived into the page');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the flag was not rendered at all');
    // The attribute-position case: both payloads close a quote and open a tag.
    // (`"><` on its own occurs in the page's own markup — `<html lang="en">` —
    // so the assertion names the injected sequences rather than the pattern.)
    assert.ok(!html.includes('x"><script'), 'the resource escaped its attribute');
    assert.ok(!html.includes('"><img'), 'the flag escaped its attribute');
  });

  test('the index page escapes it too, in the row and in the link', async () => {
    const res = await getHtml('/monitor', { ip: ips.next() });
    const html = await res.text();
    assert.ok(!/<script>alert/.test(html));
    assert.ok(!/<b>AAA<\/b>/.test(html), 'a tier string was rendered as markup');
    assert.ok(html.includes('&lt;b&gt;AAA&lt;/b&gt;'));
  });

  test('the JSON carries it verbatim, because JSON is not markup', async () => {
    const { body } = await getJson('/monitor/hostile.example', { ip: ips.next() });
    assert.equal(body.instruments.bazaar.resource, HOSTILE_RESOURCE);
  });
});

describe('the free reads are read-only, and cheap to be scanned', () => {
  test('they write NOTHING — no quota row, no lint row, no counter', async () => {
    // The same argument as the 402 fast path: a public page that costs a row
    // every time a crawler looks at it is a page that costs money to have.
    const before = await storeCounts();
    for (let i = 0; i < 6; i++) {
      await getJson('/monitor', { ip: ips.next() });
      await getJson('/monitor/socialx402.com', { ip: ips.next() });
      await getJson('/monitor/nobody.example', { ip: ips.next() });
    }
    assert.deepEqual(await storeCounts(), before, 'a free monitor read wrote to the store');
  });

  test('HEAD is the same answer with no body', async () => {
    const res = await api.request('/monitor', { method: 'HEAD', ip: ips.next() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(await res.text(), '');
  });

  test('a write verb is a 405 that points at the paid routes', async () => {
    for (const path of ['/monitor', '/monitor/socialx402.com']) {
      const res = await api.post(path, {}, { ip: ips.next() });
      assert.equal(res.status, 405, `${path}: ${res.text}`);
      assert.equal(res.headers.get('allow'), 'GET, HEAD');
      assert.match(res.body.fix, /monitor\/verdict/);
      assert.ok(res.body.see.catalog.endsWith('/check'));
    }
  });

  test('OPTIONS is answered for both', async () => {
    for (const path of ['/monitor', '/monitor/socialx402.com']) {
      const res = await api.request(path, { method: 'OPTIONS', ip: ips.next() });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
    }
  });

  test('they are CORS-open, because a browser is a legitimate caller', async () => {
    const { headers } = await getJson('/monitor', { ip: ips.next() });
    assert.equal(headers.get('access-control-allow-origin'), '*');
  });
});

/** Every table a request could write to. The free reads must move none of them. */
async function storeCounts() {
  const [rows] = await worker.d1(
    'SELECT (SELECT COUNT(*) FROM settlements) AS settlements, ' +
      '(SELECT COUNT(*) FROM call_quota) AS call_quota, ' +
      '(SELECT COUNT(*) FROM lints) AS lints, ' +
      '(SELECT COUNT(*) FROM counters) AS counters, ' +
      '(SELECT COUNT(*) FROM monitor_readings) AS readings, ' +
      '(SELECT COUNT(*) FROM monitor_probes) AS probes;'
  );
  return rows;
}

// ------------------------------------------------------------------ the paid routes
//
// Served here through the FREE TIER, which is how every other suite gets past
// the 402 front door without a facilitator in the loop. The 402-first behaviour
// of these three routes is asserted in the production phase
// (test/x402.test.mjs), where there is no free tier at all.

describe('the paid routes, served', () => {
  before(async () => {
    await seed(
      daySql({ roster_size: 400, wrongly_dead: 249, contradictions: 127 }),
      readingSql(WRONGED),
      probeSql({
        host: 'socialx402.com',
        declared_status: 402,
        declared_ms: 118,
        get_status: 405,
        get_ms: 96,
        saw_v2_header: 1,
        saw_v1_body: 1,
      }),
      // A second day, so the series is a series.
      readingSql({
        day: YESTERDAY,
        host: 'socialx402.com',
        ae_uptime: 0,
        ae_settled_14d: 170.0,
        at_score: 100,
        at_down: 0,
        bz_resource: 'https://socialx402.com/api/x',
        bz_method: 'POST',
      })
    );
  });

  test('/monitor/verdict answers the latest day, stamped and flagged', async () => {
    const res = await api.post('/monitor/verdict', { host: 'socialx402.com' }, { ip: ips.next() });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.endpoint, 'verdict');
    assert.equal(res.body.as_of, DAY);
    assert.equal(res.body.state, 'probed');
    assert.equal(res.body.probe.declared.status, 402);
    assert.ok(res.body.flags.some((f) => f.id === 'wrongly-dead'));
  });

  test('/monitor/history returns every day held, oldest first', async () => {
    const res = await api.post('/monitor/history', { host: 'socialx402.com' }, { ip: ips.next() });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.days_held, 2);
    assert.equal(res.body.first_day, YESTERDAY);
    assert.equal(res.body.last_day, DAY);
    assert.equal(res.body.probed_days, 1);
    assert.deepEqual(res.body.series.map((d) => d.state), ['readings-only', 'probed']);
  });

  test('/monitor/receipt carries the statement, the attestation and a digest that verifies', async () => {
    const res = await api.post('/monitor/receipt', { host: 'socialx402.com' }, { ip: ips.next() });
    assert.equal(res.status, 200, res.text);
    const { digest, ...rest } = res.body;
    // The document, verified the way its own `verify` field says to — over the
    // bytes a buyer actually received, not over an object we built here.
    assert.equal(sha256HexSync(canonicalJson(rest)), digest.value);

    assert.equal(res.body.contradiction.days_held, 2);
    assert.equal(res.body.contradiction.days_wrongly_dead, 1);
    assert.match(res.body.contradiction.statement, /disagreed about whether socialx402\.com was alive/);
    assert.match(res.body.contradiction.statement, /answered 402/);

    // The attestation names the method, the UA and the no-payment rule — the UA
    // verbatim, because its value is that a rater can grep their own log for it.
    assert.equal(res.body.attestation.user_agent, '10x402-monitor/0.1 (+https://10x402.com/monitor)');
    assert.match(res.body.attestation.statement, /10x402-monitor\/0\.1/);
    assert.match(res.body.attestation.statement, /NO PAYMENT WAS SENT/);
    assert.match(res.body.attestation.no_payment, /X-PAYMENT/);
    // Literals on purpose — the attestation is built from the constants, so
    // asserting the constants back would be circular; this pins the PUBLISHED
    // schedule a disputing seller quotes. Bumped daily → 6-hourly 2026-08-28.
    assert.equal(res.body.attestation.schedule.capture, '17 */6 * * *');
    assert.equal(res.body.attestation.schedule.probe, '47 */6 * * *');
  });

  test('a stale stored probe is reported as stale rather than as current', async () => {
    // The freshness rule is not decoration: a verdict read as current when its
    // probe is two days old is the same mistake the raters make.
    await worker.d1(
      `UPDATE monitor_probes SET ts = ${Math.floor(Date.now() / 1000) - (STALE_AFTER_HOURS + 6) * 3600} ` +
        `WHERE day = '${DAY}' AND host = 'socialx402.com'`
    );
    const res = await api.post('/monitor/verdict', { host: 'socialx402.com' }, { ip: ips.next() });
    assert.equal(res.body.freshness.stale, true);
    assert.match(res.body.freshness.reads, /STALE/);
    await worker.d1(
      `UPDATE monitor_probes SET ts = ${Math.floor(Date.now() / 1000) - 600} WHERE day = '${DAY}' AND host = 'socialx402.com'`
    );
  });

  test('a URL is accepted where a host is expected, and reduced to the host', async () => {
    const res = await api.post(
      '/monitor/verdict',
      { host: 'https://socialx402.com/api/sc/tiktok/song/videos' },
      { ip: ips.next() }
    );
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.host, 'socialx402.com');
  });

  test('a bad subject is a 400 with a fix, and serves nothing', async () => {
    for (const host of [undefined, '', 'not a host', 42]) {
      const res = await api.post('/monitor/verdict', { host }, { ip: ips.next() });
      assert.equal(res.status, 400, `${JSON.stringify(host)}: ${res.text}`);
      assert.match(res.body.fix, /socialx402\.com/);
    }
  });

  test('a host this wing does not hold is a 400 naming the roster criteria', async () => {
    const res = await api.post('/monitor/history', { host: 'nobody.example' }, { ip: ips.next() });
    assert.equal(res.status, 400, res.text);
    assert.match(res.body.error, /no readings are held/);
    assert.match(res.body.fix, /appeared in any of the three instruments/);
  });

  test('the telemetry row records the SHAPE of the answer and never the host', async () => {
    const before = await worker.d1("SELECT COUNT(*) AS n FROM lints WHERE endpoint = 'monitor-verdict'");
    await api.post('/monitor/verdict', { host: 'socialx402.com' }, { ip: ips.next() });
    const rows = await worker.d1("SELECT grade FROM lints WHERE endpoint = 'monitor-verdict' ORDER BY rowid DESC LIMIT 1");
    const after = await worker.d1("SELECT COUNT(*) AS n FROM lints WHERE endpoint = 'monitor-verdict'");
    assert.equal(Number(after[0].n), Number(before[0].n) + 1);
    assert.equal(rows[0].grade, 'monitor:probed');
    // What a caller looked up is their business. Nothing in this table names it.
    const any = await worker.d1("SELECT COUNT(*) AS n FROM lints WHERE grade LIKE '%socialx402%'");
    assert.equal(Number(any[0].n), 0);
  });

  test('the paid paths beat the dynamic one: /monitor/verdict is never a host lookup', async () => {
    // ENDPOINTS_BY_PATH resolves first in route(). With no PAYTO configured in
    // this phase, a GET on a paid route is the 405 signpost — which is proof
    // enough that it routed to handlePaid and not to the host page.
    const res = await api.request('/monitor/verdict', { method: 'GET', ip: ips.next() });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });

  test('the monitor path serves no outbound request — it is D1 or nothing', async () => {
    // Structural rather than observational: the module that serves these routes
    // must not be able to fetch. A `fetch(` appearing in it would mean a paid
    // answer could depend on a third party being up at buy time.
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { ROOT } = await import('./harness.mjs');
    const source = await readFile(join(ROOT, 'worker', 'monitor-surfaces.js'), 'utf8');
    assert.ok(!/\bfetch\s*\(/.test(source), 'worker/monitor-surfaces.js contains a fetch call');
    for (const endpoint of ENDPOINTS.filter((e) => e.kind === 'monitor')) {
      assert.equal(endpoint.fetches, false, `${endpoint.path} claims to fetch`);
    }
  });
});

describe('/check describes the wing it now has', () => {
  test('lists all three paid monitor routes with their prices', async () => {
    const { body } = await api.check({ ip: ips.next() });
    const byPath = Object.fromEntries(body.endpoints.map((e) => [e.path, e]));
    for (const id of ['monitor-verdict', 'monitor-history', 'monitor-receipt']) {
      const endpoint = ENDPOINTS_BY_ID.get(id);
      const listed = byPath[endpoint.path];
      assert.ok(listed, `${endpoint.path} is not listed`);
      assert.equal(listed.price, priceLabel(endpoint.price_usd));
      assert.equal(listed.fetches, false);
      assert.equal(listed.scope, 'one host, from stored daily observations');
      assert.deepEqual(listed.sample, { host: '10x402.com' });
    }
  });

  test('describes the FREE monitor routes too, including the parameterised one', async () => {
    const { body } = await api.check({ ip: ips.next() });
    const byPath = Object.fromEntries(body.endpoints.map((e) => [e.path, e]));
    assert.equal(byPath['/monitor'].price, 'free');
    assert.equal(byPath['/monitor/{host}'].price, 'free');
    assert.match(byPath['/monitor'].description, /index/i);
    assert.ok(body.notes.some((n) => /\/monitor/.test(n)), '/check never mentions the wing in its notes');
  });

  test('a 404 names the monitor routes, paid and free', async () => {
    const res = await api.post('/monitorr', {}, { ip: ips.next() });
    assert.equal(res.status, 404);
    assert.ok(res.body.routes.some((r) => r === 'GET /monitor — free'));
    assert.ok(res.body.routes.some((r) => r === 'GET /monitor/{host} — free'));
    assert.ok(res.body.routes.some((r) => r.includes('/monitor/verdict')));
  });
});
