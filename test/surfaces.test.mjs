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

import { SURFACES } from '../worker/surfaces.generated.js';
import { PAYTO_TEST, ROOT, useWorker } from './harness.mjs';

const execFileAsync = promisify(execFile);
const DIST = join(ROOT, 'dist');
const SURFACE_PATHS = Object.keys(SURFACES);

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
});

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
