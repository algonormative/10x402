// The port is checked against the CANONICAL implementation's published
// vectors, not against itself.
//
// worker/discovery-grammar.js is a port of @flareclaw/x402-trust's
// src/discovery.ts, and a port cannot honestly claim byte-identity the way a
// vendored copy can. What it can claim is that it reproduces the published
// conformance vectors exactly — verdict, record fields, and the hint strings a
// near-miss publisher would actually be shown — and that is what this file
// asserts, field by field, with no tolerance anywhere.
//
// Six of the ten vectors are records observed in the wild with the host and
// date attached, including the two zone-wildcard replies that a naive reader
// counts as adopters. If the two implementations ever diverge on a case these
// cover, this fails and the divergence is a build event rather than a slow rot.
//
// Pure phase: no server, no network, no wrangler.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  buildTxtRecord,
  diagnoseManifest,
  diagnoseTxtRecord,
  discoveryNamesFor,
  isOneEditAway,
  isWkInDomain,
  manifestCoversHost,
  parseTxtRecord,
} from '../worker/discovery-grammar.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(HERE, 'fixtures', 'discovery-txt-vectors.json'), 'utf8'));

describe('discovery grammar: the published vectors', () => {
  test('the fixture file is the one this test claims to run', () => {
    assert.equal(VECTORS.schema, 'x402-discovery-txt-vectors/1');
    assert.equal(VECTORS.vectors.length, 10, 'a vector added or removed upstream should be a visible change here');
    // At least one of each verdict, or the suite could pass while only ever
    // exercising the easy branch.
    const kinds = new Set(VECTORS.vectors.map((v) => v.expected.kind));
    for (const k of ['conformant', 'near-miss', 'foreign', 'malformed']) {
      assert.ok(kinds.has(k), `no vector exercises "${k}"`);
    }
  });

  for (const vector of VECTORS.vectors) {
    test(`${vector.id} → ${vector.expected.kind}`, () => {
      const got = diagnoseTxtRecord(vector.txt);
      assert.equal(got.kind, vector.expected.kind, `${vector.id}: ${vector.provenance}`);

      if (vector.expected.kind === 'conformant') {
        assert.deepEqual(got.record, vector.expected.record);
      }
      if (vector.expected.kind === 'near-miss') {
        // The hints ARE the product on this branch — they are what a
        // near-miss publisher is shown — so they are compared exactly and in
        // order, not as a set and not by substring.
        assert.deepEqual(got.hints, vector.expected.hints);
        assert.equal(got.manifestUrl ?? null, vector.expected.manifestUrl ?? null);
      }
      if (vector.expected.kind === 'malformed') {
        assert.ok(got.message.length > 0, 'a malformed verdict with no message tells the operator nothing');
      }
      if (vector.expected.kind === 'foreign') {
        assert.equal(got.hints, undefined);
      }
    });
  }
});

describe('discovery grammar: the gate is unchanged by the diagnosis', () => {
  // The whole design rests on this: diagnosing near-misses generously must not
  // widen what the resolver ACCEPTS. A test that only checked the diagnosis
  // would pass just as happily if a near-miss had quietly become conformant.
  for (const vector of VECTORS.vectors) {
    test(`${vector.id}: parse agrees with diagnose`, () => {
      if (vector.expected.kind === 'conformant') {
        assert.deepEqual(parseTxtRecord(vector.txt), vector.expected.record);
      } else if (vector.expected.kind === 'malformed') {
        assert.throws(() => parseTxtRecord(vector.txt));
      } else {
        assert.equal(parseTxtRecord(vector.txt), null, 'a near-miss or foreign record must NOT parse');
      }
    });
  }
});

describe('discovery grammar: the fix string round-trips', () => {
  test('every near-miss vector that names a manifest URL produces a record that parses', () => {
    let checked = 0;
    for (const vector of VECTORS.vectors) {
      const d = diagnoseTxtRecord(vector.txt);
      if (d.kind !== 'near-miss' || !d.manifestUrl) continue;
      const fixed = buildTxtRecord({ manifestUrl: d.manifestUrl });
      const reparsed = parseTxtRecord(fixed);
      assert.ok(reparsed, `the fix offered for ${vector.id} does not itself parse: ${fixed}`);
      assert.equal(reparsed.wk, d.manifestUrl);
      checked++;
    }
    assert.ok(checked >= 4, `expected the four real near-miss publishers, exercised ${checked}`);
  });
});

describe('discovery grammar: which name to query', () => {
  test('the host first, then bounded ancestors, never below two labels', () => {
    assert.deepEqual(discoveryNamesFor('api.example.com'), ['api.example.com', 'example.com']);
    assert.deepEqual(discoveryNamesFor('a.b.c.example.com'), ['a.b.c.example.com', 'b.c.example.com', 'c.example.com']);
    assert.deepEqual(discoveryNamesFor('example.com'), ['example.com']);
  });

  test('a URL, a trailing dot and a port all reduce to the same host', () => {
    for (const input of ['https://api.example.com/thing', 'API.Example.com.', 'api.example.com:8443']) {
      assert.deepEqual(discoveryNamesFor(input), ['api.example.com', 'example.com'], input);
    }
  });

  test('junk yields no names rather than a guess', () => {
    for (const bad of ['', '   ', '.example.com', 'a b', 'not a host/path']) {
      assert.deepEqual(discoveryNamesFor(bad), [], JSON.stringify(bad));
    }
  });

  test('an address literal yields no names — the dots are not delegation', () => {
    // Without this the walk asks for _x402.0.0.1 and _x402.0.1, which are
    // other people's zones and nothing to do with the target.
    for (const literal of ['127.0.0.1', '203.0.113.9', 'https://198.51.100.7/api', '[::1]', '2001:db8::1']) {
      assert.deepEqual(discoveryNamesFor(literal), [], literal);
    }
  });

  test("an ancestor's manifest applies only if it NAMES the host", () => {
    const platform = { x402Version: 2, kind: 'resource-server', resources: [{ url: 'https://tenant-a.pages.dev/api' }] };
    // Found at the host itself: always authoritative.
    assert.equal(manifestCoversHost(platform, 'tenant-a.pages.dev', 'tenant-a.pages.dev'), true);
    // Found at the parent, and it names this tenant.
    assert.equal(manifestCoversHost(platform, 'pages.dev', 'tenant-a.pages.dev'), true);
    // Found at the parent, and it does NOT name this tenant. Without this rule
    // one platform record makes every tenant beneath it an adopter.
    assert.equal(manifestCoversHost(platform, 'pages.dev', 'tenant-b.pages.dev'), false);
    // A manifest cannot vouch for a host outside its own zone either.
    const overreach = { x402Version: 2, kind: 'resource-server', resources: [{ url: 'https://victim.example/api' }] };
    assert.equal(manifestCoversHost(overreach, 'pages.dev', 'victim.example'), false);
  });
});

describe('discovery grammar: wk stays in the domain', () => {
  test('same host and subdomains pass, a neighbour does not', () => {
    assert.equal(isWkInDomain('https://example.com/.well-known/x402', 'example.com'), true);
    assert.equal(isWkInDomain('https://api.example.com/.well-known/x402', 'example.com'), true);
    assert.equal(isWkInDomain('https://evil.com/.well-known/x402', 'example.com'), false);
    // The suffix trap: notexample.com ends with "example.com" as a STRING.
    assert.equal(isWkInDomain('https://notexample.com/.well-known/x402', 'example.com'), false);
    assert.equal(isWkInDomain('not a url', 'example.com'), false);
  });
});

describe('discovery grammar: manifest diagnosis names who introduced the rule', () => {
  test("10x402's own published manifest is one edit away, and the edit is `kind`", () => {
    // THE LIVE CASE, and the reason this contribution exists. Captured from
    // https://10x402.com/.well-known/x402 on 2026-08-22 and trimmed to the
    // fields the diagnosis reads. This repository's flagship invariant is that
    // it passes its own lint — and it cannot see this, because the lint
    // engine's input is the 402 response and the discovery surface is not in
    // it. One field, and it becomes the second host in the world publishing a
    // conformant discovery document.
    const captured = {
      x402Version: 2,
      service: { name: '10x402', url: 'https://10x402.com' },
      resources: [{ url: 'https://10x402.com/lint', method: 'POST' }],
    };
    const d = diagnoseManifest(captured);
    assert.equal(d.ok, false);
    assert.equal(d.violations.length, 1);
    assert.equal(d.violations[0].field, 'kind');
    assert.equal(d.violations[0].introducedBy, 'x402-discovery');
    assert.equal(isOneEditAway(captured), true);
    // And with the one field added it validates outright.
    assert.equal(diagnoseManifest({ ...captured, kind: 'resource-server' }).ok, true);
  });

  test('a core fault is not reported as one edit away', () => {
    const noVersion = { kind: 'resource-server', resources: [] };
    const d = diagnoseManifest(noVersion);
    assert.equal(d.ok, false);
    assert.ok(d.violations.some((v) => v.field === 'x402Version' && v.introducedBy === 'core'));
    assert.equal(isOneEditAway(noVersion), false, 'a missing x402Version predates this extension and is not its cost');
  });

  test('every violation is collected, not just the first', () => {
    const d = diagnoseManifest({ kind: 'facilitator' });
    // x402Version, plus the whole missing facilitator block.
    assert.ok(d.violations.length >= 2, 'a first-throw validator makes the operator debug one field per round trip');
    assert.ok(d.violations.some((v) => v.field === 'x402Version'));
    assert.ok(d.violations.some((v) => v.field === 'facilitator'));
  });

  test('a facilitator endpoint may not inject an authority', () => {
    const base = {
      x402Version: 2,
      kind: 'facilitator',
      facilitator: {
        baseUrl: 'https://f.example.com',
        endpoints: { supported: '/supported', verify: '/verify', settle: '/settle' },
        kinds: [{ scheme: 'exact', network: 'eip155:8453' }],
      },
    };
    assert.equal(diagnoseManifest(base).ok, true);

    // Each of these aims a conforming crawler at somebody else.
    for (const hostile of ['//victim.com/x', 'https://victim.com/x', '/@victim.com/x', '/a\\b', '/a b']) {
      const m = structuredClone(base);
      m.facilitator.endpoints.settle = hostile;
      const d = diagnoseManifest(m);
      assert.equal(d.ok, false, `accepted a hostile endpoint value: ${JSON.stringify(hostile)}`);
      assert.ok(d.violations.some((v) => v.field === 'facilitator.endpoints.settle'));
    }
  });

  test('a non-object is a core fault, not a crash', () => {
    for (const junk of [null, undefined, 42, 'a string', []]) {
      const d = diagnoseManifest(junk);
      assert.equal(d.ok, false, JSON.stringify(junk));
      assert.equal(d.violations[0].introducedBy, 'core');
    }
  });
});
