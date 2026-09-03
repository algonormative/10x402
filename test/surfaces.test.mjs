// The machine surfaces, served from the zone Worker.
//
// WHY THE WORKER SERVES STATIC BYTES AT ALL: Cloudflare Pages applies its own
// Browser Integrity Check to every request that reaches the Pages project —
// static assets AND Pages Functions — and 403s Python-stdlib user agents with
// `error code: 1010` (measured 2026-09-03, vault-1wj82). Only paths owned by a
// Worker attached to the ZONE bypass it, so /llms.txt, /openapi.json,
// /.well-known/x402, /skill.md, /sitemap.xml and /robots.txt are baked into
// worker/surfaces.generated.js by `node build.mjs` and served from routes in
// wrangler.toml. Three claims hold that arrangement together, each its own
// test below:
//
//   1. every surface path in the module has a wrangler.toml route — without
//      one, the Worker code is dead and Pages answers the 403 anyway;
//   2. the module covers every machine surface the build emits — a new
//      surface cannot silently stay Pages-only;
//   3. the committed module is byte-identical to the built assets, and the
//      Worker serves exactly those bytes — the two copies cannot drift.
//
// Claims 2 and 3 REBUILD dist/ first (`node build.mjs`, pure local work — it
// reads worker/*.js and fonts/ and fetches nothing, so AF-06 holds), which is
// what catches a stale COMMIT of the generated module: the import below is the
// committed file, the rebuild is what it should have been.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';

import { ENDPOINTS, SITE_BASE, indefiniteArticle } from '../worker/catalog.js';
import { CHECKS } from '../worker/lint.js';
import { SURFACES } from '../worker/surfaces.generated.js';
import { PAYTO_TEST, ROOT, useWorker } from './harness.mjs';

const execFileAsync = promisify(execFile);
const DIST = join(ROOT, 'dist');
const SURFACE_PATHS = Object.keys(SURFACES);
// The free sample reports (vault-2cmy0). NOT in SURFACES: they are one per
// catalogue entry and each is a full lint report, so the Worker recomputes them
// from runSample() per request rather than carrying eight of them as bytes in
// the bundle. Everything else about them matches a machine surface — a zone
// route, GET/HEAD only, the same headers, and a body that cannot differ from
// the dist/ copy.
const SAMPLE_PATHS = ENDPOINTS.map((e) => `/samples/${e.id}.json`);

// `node build.mjs`, once, with any SITE_HOST override scrubbed — the committed
// module and the parity assertion are both claims about the PRODUCTION build,
// and a preview-host build deliberately refuses to write the module at all.
let built = null;
function ensureBuild() {
  if (!built) {
    const env = { ...process.env };
    delete env.SITE_HOST;
    built = execFileAsync(process.execPath, ['build.mjs'], { cwd: ROOT, env, maxBuffer: 32 * 1024 * 1024 });
  }
  return built;
}

describe('every Worker-served surface has a deployed route', () => {
  test('wrangler.toml publishes a pattern for each path in the generated module', () => {
    const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
    const patterns = [...toml.matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((m) => m[1].replace(/^[^/]*/, ''));
    assert.ok(patterns.length >= 3, `no routes found in wrangler.toml: ${patterns}`);

    const covered = (path) =>
      patterns.some((pattern) => new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`).test(path));

    for (const path of SURFACE_PATHS) {
      assert.ok(covered(path), `${path} is in worker/surfaces.generated.js but no wrangler.toml route sends it to the Worker`);
      // Route patterns match the WHOLE URL including the query string (the
      // /check* note in wrangler.toml) — an exact pattern here would hand the
      // first caller that appends one straight back to the Pages 403.
      assert.ok(covered(`${path}?x=1`), `a query string on ${path} falls through to Pages`);
    }
  });

  test('wrangler.toml publishes a pattern for every sample report path', () => {
    const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
    const patterns = [...toml.matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((m) => m[1].replace(/^[^/]*/, ''));
    const covered = (path) =>
      patterns.some((pattern) => new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`).test(path));

    for (const path of SAMPLE_PATHS) {
      assert.ok(covered(path), `${path} is served by the Worker but no wrangler.toml route sends it there`);
      assert.ok(covered(`${path}?x=1`), `a query string on ${path} falls through to Pages`);
    }
    // The unknown-id 404 has to reach the Worker too, or Pages answers its own
    // 403/404 to exactly the caller that most needs to be told the id is wrong.
    assert.ok(covered('/samples/not-an-endpoint.json'), 'an unknown sample id falls through to Pages');
  });
});

describe('the module covers every machine surface the build emits', () => {
  test('each built machine surface has an entry in the generated module', async () => {
    await ensureBuild();
    const expected = [
      // The fixed machine surfaces this build CAN emit. catalog.json and
      // llms-full.txt are not built today; they are in this list so that the
      // day one appears in dist/, this test demands its Worker entry (and,
      // via the route test above, its wrangler.toml route).
      ...['llms.txt', 'openapi.json', 'skill.md', 'sitemap.xml', 'robots.txt', 'catalog.json', 'llms-full.txt']
        .filter((f) => existsSync(join(DIST, f)))
        .map((f) => `/${f}`),
      // The whole .well-known/ tree, enumerated rather than assumed to be x402.
      ...readdirSync(join(DIST, '.well-known')).map((f) => `/.well-known/${f}`),
    ];
    assert.ok(expected.includes('/llms.txt'), `dist/ looks wrong — built surfaces: ${expected}`);
    assert.ok(expected.includes('/.well-known/x402'), `dist/.well-known looks wrong — built surfaces: ${expected}`);
    for (const path of expected) {
      assert.ok(
        Object.hasOwn(SURFACES, path),
        `the build emits ${path} but worker/surfaces.generated.js does not serve it — Pages would 403 it to Python UAs`
      );
    }
  });

  test('every built sample report is one the Worker serves, and vice versa', async () => {
    await ensureBuild();
    // The sample half of claim 2, and it runs both ways on purpose. The Worker
    // resolves an id through the catalogue, so a dist/samples/ file with no
    // catalogue entry would be Pages-only and invisible here otherwise — and a
    // catalogue entry with no built file would mean the two lists had drifted.
    const built = readdirSync(join(DIST, 'samples')).sort();
    assert.deepEqual(
      built,
      ENDPOINTS.map((e) => `${e.id}.json`).sort(),
      'dist/samples/ and the catalogue disagree — one of them would be served and the other would not'
    );
  });

  test('content parity: the COMMITTED module is byte-identical to the built assets', async () => {
    await ensureBuild();
    for (const path of SURFACE_PATHS) {
      const distBytes = readFileSync(join(DIST, path.slice(1)));
      const moduleBytes = Buffer.from(SURFACES[path].body, 'utf8');
      assert.ok(
        distBytes.equals(moduleBytes),
        `${path}: the committed module differs from the built asset — run \`node build.mjs\` and commit worker/surfaces.generated.js`
      );
    }
  });
});

describe('the hero lede agrees with the number it is counting', () => {
  // "A 82-check catalogue" shipped in the SECOND SENTENCE A BUYER READS, on a
  // page whose entire argument is that this service is careful about details.
  // The fix is computed rather than hardcoded, so the two tests below are a
  // pair: the rule, and the rendering that uses it.
  test('indefiniteArticle picks the article from how the number is SPOKEN', () => {
    // "an eight", "an eighty-two", "an eight hundred", "an eight thousand".
    for (const n of [8, 80, 82, 89, 800, 888, 8000]) {
      assert.equal(indefiniteArticle(n), 'an', `${n}`);
    }
    // "an eleven", "an eighteen" — the two spelled-out exceptions.
    assert.equal(indefiniteArticle(11), 'an');
    assert.equal(indefiniteArticle(18), 'an');
    // And NOT a prefix test: 110 is "one hundred ten", 180 is "one hundred
    // eighty". Both start with a consonant sound despite the leading digits.
    for (const n of [110, 180, 1100, 1800]) {
      assert.equal(indefiniteArticle(n), 'a', `${n}`);
    }
    // Every other leading digit reads as a consonant.
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 19, 42, 79, 90, 100]) {
      assert.equal(indefiniteArticle(n), 'a', `${n}`);
    }
    // Nothing that is not a whole non-negative count can produce a wrong
    // article — it produces the safe one.
    for (const n of [-8, 8.5, NaN, undefined, null, '8']) {
      assert.equal(indefiniteArticle(n), 'a', `${n}`);
    }
  });

  test('the built page opens with the right article for the catalogue size', async () => {
    await ensureBuild();
    const page = readFileSync(join(DIST, 'index.html'), 'utf8');
    const article = indefiniteArticle(CHECKS.length) === 'an' ? 'An' : 'A';
    assert.ok(
      page.includes(`${article} ${CHECKS.length}-check catalogue`),
      `the lede does not render "${article} ${CHECKS.length}-check catalogue"`
    );
    // The inverse, so a regression cannot pass by rendering both.
    const wrong = article === 'An' ? 'A' : 'An';
    assert.ok(
      !page.includes(`${wrong} ${CHECKS.length}-check catalogue`),
      `the lede still renders "${wrong} ${CHECKS.length}-check catalogue"`
    );
  });
});

describe('the Worker answers the surface paths', () => {
  let worker;
  before(async () => {
    worker = await useWorker({ payTo: PAYTO_TEST });
  });
  after(async () => {
    await worker?.stop();
  });

  test('GET each surface: 200, the declared content-type, the module bytes — on a Python-stdlib UA', async () => {
    for (const path of SURFACE_PATHS) {
      // The UA the whole fix exists for. Locally nothing filters on it; it is
      // pinned here so the request shape in the suite is the request shape
      // that was being 403'd in production.
      const res = await fetch(`${worker.baseUrl}${path}`, { headers: { 'user-agent': 'Python-urllib/3.14' } });
      assert.equal(res.status, 200, `${path} answered ${res.status}`);
      assert.equal(res.headers.get('content-type'), SURFACES[path].contentType, `${path} content-type`);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=300', `${path} cache-control`);
      assert.equal(await res.text(), SURFACES[path].body, `${path}: served bytes differ from the module`);
    }
  });

  test('HEAD answers 200 with no body; a write verb is a 405 that names the allowed ones', async () => {
    const head = await fetch(`${worker.baseUrl}/llms.txt`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const post = await fetch(`${worker.baseUrl}/llms.txt`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD, OPTIONS');
    await post.text();
  });

  test('GET each sample report: 200 and the build\'s bytes — on a Python-stdlib UA', async () => {
    await ensureBuild();
    for (const path of SAMPLE_PATHS) {
      const res = await fetch(`${worker.baseUrl}${path}`, { headers: { 'user-agent': 'Python-urllib/3.14' } });
      assert.equal(res.status, 200, `${path} answered ${res.status}`);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8', `${path} content-type`);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=300', `${path} cache-control`);

      const served = await res.text();
      const onDisk = readFileSync(join(DIST, path.slice(1)), 'utf8');
      // The acceptance is deep-equality of the REPORT; byte-equality is the
      // stronger claim and the one that actually holds, because build.mjs and
      // handleSample serialize the same runSample() the same way.
      assert.deepEqual(JSON.parse(served), JSON.parse(onDisk), `${path}: the served report differs from the built one`);
      assert.equal(served, onDisk, `${path}: served bytes differ from dist/samples/`);
    }
  });

  test('an unknown sample id is a JSON 404 naming the free catalogue; a write verb is a 405', async () => {
    const missing = await fetch(`${worker.baseUrl}/samples/not-an-endpoint.json`);
    assert.equal(missing.status, 404);
    const body = await missing.json();
    assert.match(body.error, /not-an-endpoint\.json/);
    assert.deepEqual(body.samples, ENDPOINTS.map((e) => `${SITE_BASE}/samples/${e.id}.json`));

    // `.json` is not optional — the extensionless form must not quietly work,
    // or `sample_report` stops being the one URL that names the resource.
    const bare = await fetch(`${worker.baseUrl}/samples/${ENDPOINTS[0].id}`);
    assert.equal(bare.status, 404);
    await bare.text();

    const head = await fetch(`${worker.baseUrl}${SAMPLE_PATHS[0]}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const post = await fetch(`${worker.baseUrl}${SAMPLE_PATHS[0]}`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD, OPTIONS');
    await post.text();
  });
});

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
