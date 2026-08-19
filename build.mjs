#!/usr/bin/env node
// The static read surface. `node build.mjs` writes dist/.
//
// Everything here is GENERATED from worker/catalog.js and worker/lint.js — the
// same modules the Worker runs. There is no second copy of a price, a check
// summary or an endpoint description anywhere in this repo, which is the only
// way a page, an OpenAPI document, an llms.txt and a live 402 stay in
// agreement. When they disagree, the one a buyer trusts is whichever they read
// first, and it is even money which that is.
//
// dist/ is served by Cloudflare Pages with ZERO Functions. The Worker owns
// /check, /lint and /lint/envelope through routes; everything else on the
// domain is these files.
//
// SURFACES, and why each one exists:
//
//   index.html        the human page, and the SEO artefact. The check catalogue
//                     rendered as a readable table IS the guide content — the
//                     thing someone searching "x402 402 not showing in bazaar"
//                     needs to land on.
//   openapi.json      the machine contract, for a client generator or an agent
//                     framework that ingests OpenAPI.
//   .well-known/x402  x402 discovery. A crawler that knows the convention finds
//                     the paid resources without being told where to look.
//   llms.txt          the short form, for an agent that wants the whole service
//                     in one fetch and does not want to parse HTML.
//   skill.md          drop-in instructions for a coding agent: what to call,
//                     what a 402 means, and what to do with the report.
//   robots.txt        allow everything. It exists so a prober gets a real 200
//                     rather than a fallback, which is indistinguishable from a
//                     misconfigured site to anything that checks.
//
// They are cheap. A service whose entire market is agents should be legible to
// every convention an agent might already know.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENDPOINTS,
  FREE_ENDPOINT,
  MAX_BODY_BYTES,
  NETWORK_V1,
  NETWORK_V2,
  RESOURCE_TAGS,
  SERVICE_NAME,
  SERVICE_TAGLINE,
  SITE_BASE as CANONICAL_BASE,
  SITE_HOST as CANONICAL_HOST,
  SUPPORT_EMAIL,
  USDC_BASE,
  priceLabel,
} from './worker/catalog.js';
import { CHECKS, GRADE_RULES } from './worker/lint.js';
import { atomicAmount, runSample, sampleInputBody } from './worker/envelope.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');

// Overridable so a local preview can render against a dev host. Production is
// the bare default, and a build that used an override warns loudly at the end —
// committing a dist/ that points at localhost is the kind of mistake that is
// invisible until someone else opens the page.
const HOST = process.env.SITE_HOST || CANONICAL_HOST;
const SCHEME = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(HOST) ? 'http' : 'https';
const BASE = `${SCHEME}://${HOST}`;

const AREAS = {
  http: 'HTTP layer',
  v2: 'x402 v2 envelope (the PAYMENT-REQUIRED header)',
  v1: 'x402 v1 envelope (the 402 body)',
  dual: 'Dual-stack consistency',
  version: 'Version-detection hygiene',
  report: 'The report’s own bounds',
};
// EVERY AREA IN THE CATALOGUE IS LISTED HERE. An area missing from this list is
// a set of checks the page, llms.txt and skill.md silently do not mention while
// the total above still counts them — so the published count and the published
// list disagree, which is the one thing a check catalogue may not do.
const AREA_ORDER = ['http', 'v2', 'v1', 'dual', 'version', 'report'];
for (const area of new Set(CHECKS.map((c) => c.area))) {
  if (!AREA_ORDER.includes(area)) throw new Error(`build: check area "${area}" is not in AREA_ORDER`);
}

const SEVERITY_BLURB = {
  error: 'a client, a facilitator or the discovery index will reject or mis-read this',
  warn: 'it works, but it costs you something you probably want',
  info: 'a nit; never affects the grade',
};

// ---------------------------------------------------------------- helpers

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Escaped, with `backticks` turned into <code>. Summaries use them. */
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

const byArea = (area) => CHECKS.filter((c) => c.area === area);

// ---------------------------------------------------------------- the page
//
// Plain, and deliberately so. This is a workshop, not a launch: no hero, no
// gradient, no testimonial from a company that does not exist. The most
// valuable thing on the page is a table of sixty checks, and the second most
// valuable is a curl command that works.

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf7; --fg: #1b1a17; --muted: #5f5b52; --rule: #ddd8cc;
  --accent: #7a3d00; --code-bg: #f1eee6; --warn: #8a6100; --err: #99201a; --ok: #1f6b2e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16150f; --fg: #ece7db; --muted: #a49d8d; --rule: #34312a;
    --accent: #e0a45c; --code-bg: #211f18; --warn: #d0a03a; --err: #e07a72; --ok: #7cc48c;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0 1.25rem 5rem; background: var(--bg); color: var(--fg);
  font: 16px/1.6 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
main { max-width: 62rem; margin: 0 auto; }
header { padding: 3.5rem 0 2rem; border-bottom: 1px solid var(--rule); }
h1 { font-size: 2.1rem; margin: 0 0 .3rem; letter-spacing: -.02em; }
h1 .say { color: var(--muted); font-size: .95rem; font-weight: normal; letter-spacing: 0; }
h2 { font-size: 1.15rem; margin: 3rem 0 .75rem; padding-top: 1.25rem; border-top: 1px solid var(--rule); }
h3 { font-size: .95rem; margin: 2rem 0 .5rem; color: var(--accent); }
p { max-width: 46rem; }
a { color: var(--accent); }
.lede { font-size: 1.05rem; color: var(--fg); max-width: 44rem; }
.muted { color: var(--muted); }
code { background: var(--code-bg); padding: .1em .35em; border-radius: 3px; font-size: .9em; }
pre {
  background: var(--code-bg); padding: .9rem 1rem; border-radius: 5px;
  overflow-x: auto; font-size: .85rem; line-height: 1.5;
}
pre code { background: none; padding: 0; font-size: 1em; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .85rem; }
th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { color: var(--muted); font-weight: normal; text-transform: uppercase; letter-spacing: .06em; font-size: .72rem; }
td.code { white-space: nowrap; font-weight: 600; }
.scroll { overflow-x: auto; }
.sev { font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; }
.sev-error { color: var(--err); } .sev-warn { color: var(--warn); } .sev-info { color: var(--muted); }
.core::after { content: " core"; color: var(--muted); font-size: .72rem; }
.grade { font-weight: 700; }
ul { max-width: 46rem; padding-left: 1.2rem; }
li { margin: .35rem 0; }
footer { margin-top: 4rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); color: var(--muted); font-size: .85rem; }
`;

function checkTable(area) {
  const rows = byArea(area)
    .map(
      (c) => `        <tr>
          <td class="code">${esc(c.id)}</td>
          <td class="sev sev-${c.severity}${c.core ? ' core' : ''}">${c.severity}</td>
          <td>${inline(c.summary)}</td>
        </tr>`
    )
    .join('\n');
  return `      <table>
        <thead><tr><th>code</th><th>severity</th><th>what it checks</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>`;
}

function endpointSection(endpoint) {
  const sample = sampleInputBody(endpoint);
  const report = runSample(endpoint);
  return `      <h3>${endpoint.method} ${esc(endpoint.path)} &mdash; ${priceLabel(endpoint.price_usd)}</h3>
      <p>${esc(endpoint.long)}</p>
      <div class="scroll"><pre><code>curl -sS -X POST ${esc(BASE)}${esc(endpoint.path)} \\
  -H 'content-type: application/json' \\
  -d '${esc(sample)}'</code></pre></div>
      <p class="muted">That call really returns this &mdash; the example is computed by running it, not written by hand:</p>
      <div class="scroll"><pre><code>${esc(JSON.stringify(report, null, 2))}</code></pre></div>`;
}

// `<meta charset>` FIRST, before the title, and it has to be in the first 1024
// bytes or the browser has already guessed. Caught by looking at the rendered
// page: the tab read "10x402 â€” x402 conformance…" because a host serving
// `text/html` with no charset parameter leaves the browser to fall back to
// latin-1, and this page is full of em dashes and curly quotes. Cloudflare
// Pages would have sent the charset and hidden it; the file should be right on
// its own.
const html = `<meta charset="utf-8">
<title>${esc(SERVICE_NAME)} — ${esc(SERVICE_TAGLINE)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(
  `${SERVICE_NAME} lints x402 payment envelopes for conformance: ${CHECKS.length} checks over the v1 body envelope, the v2 PAYMENT-REQUIRED header, dual-stack consistency and CDP Bazaar discovery. Paid per call over x402.`
)}">
<link rel="canonical" href="${CANONICAL_BASE}/">
<style>${CSS}</style>
<main>
  <header>
    <h1>${esc(SERVICE_NAME)} <span class="say">(&ldquo;ten-ex-four-oh-two&rdquo;)</span></h1>
    <p class="lede">${esc(SERVICE_TAGLINE)}. Point it at a paid endpoint and it tells you,
    in ${CHECKS.length} checks, everything a client, a facilitator or a discovery index will
    quietly refuse to tell you.</p>
    <p class="muted">Shovels for x402 sellers: the conformance tuition we paid, sold per call.</p>
  </header>

  <h2>What goes wrong</h2>
  <p>An x402 endpoint fails silently in every direction at once. A url-safe base64 envelope is
  discarded by the client before it is decoded, so you look like a seller who published nothing.
  A <code>bazaar.info</code> that does not validate against its own <code>bazaar.schema</code> is
  declined by the facilitator without a word, and your listing simply never appears. A missing
  <code>extra.name</code> makes every genuine payment fail as
  <code>invalid_exact_evm_payload_signature</code> with nothing in your logs to explain it. A free
  tier hands the discovery prober a 200 and delists an endpoint that was already indexed.</p>
  <p>None of those produce an error you will see. They produce an absence &mdash; of buyers, of a
  listing, of anything at all &mdash; and an absence is very hard to debug.</p>

  <h2>The endpoints</h2>
${ENDPOINTS.map(endpointSection).join('\n\n')}

  <h3>GET ${esc(FREE_ENDPOINT.path)} &mdash; free</h3>
  <p>${esc(FREE_ENDPOINT.description)} No payment, no account, no key.</p>
  <div class="scroll"><pre><code>curl -sS ${esc(BASE)}${esc(FREE_ENDPOINT.path)}</code></pre></div>

  <h2>Paying</h2>
  <p>Every paid call answers <code>402</code> first, with an x402 envelope in
  <strong>both</strong> protocol versions: v1 as the JSON body, v2 as standard base64 in a
  <code>PAYMENT-REQUIRED</code> response header. Retry through any x402-capable client
  (<code>x402-fetch</code>, the x402 SDK, Coinbase AgentKit) holding a wallet with USDC on Base.
  There is no login and no account &mdash; the payment is the auth.</p>
  <ul>
    <li>Asset: USDC on Base, <code>${USDC_BASE}</code></li>
    <li>Network: <code>${NETWORK_V1}</code> in v1, <code>${NETWORK_V2}</code> in v2 &mdash; one chain, two legal spellings</li>
    <li>Prices: ${ENDPOINTS.map((e) => `<code>${esc(e.path)}</code> ${priceLabel(e.price_usd)} (${atomicAmount(e.price_usd)} atomic)`).join(', ')}</li>
    <li>There is no free tier, on purpose. A free tier would fail this service&rsquo;s own
    <code>HTTP_FREE_TIER_200</code> check.</li>
    <li>You are only charged for reports that are actually served. A bad URL or a malformed paste
    settles nothing, even when the payment verified.</li>
  </ul>

  <h2>The grade</h2>
  <div class="scroll"><table>
    <thead><tr><th>grade</th><th>when</th></tr></thead>
    <tbody>
${GRADE_RULES.map((g) => `      <tr><td class="grade">${g.grade}</td><td>${esc(g.when)}</td></tr>`).join('\n')}
    </tbody>
  </table></div>
  <p><strong>Core</strong> checks are the ones whose failure makes the envelope unusable as
  published, rather than merely impoverished. One core error is an F: the endpoint does not work.
  Ordinary errors are a D: it works, and something about it is wrong.</p>
  <p class="muted">Severities: ${Object.entries(SEVERITY_BLURB)
    .map(([k, v]) => `<strong class="sev-${k}">${k}</strong> &mdash; ${esc(v)}`)
    .join('; ')}.</p>

  <h2>The ${CHECKS.length} checks</h2>
  <p>Published in full, before you spend anything. Every finding in a report carries one of these
  codes plus a <code>fix</code> saying exactly what to change.</p>
${AREA_ORDER.map((area) => `      <h3>${esc(AREAS[area])} &mdash; ${byArea(area).length} checks</h3>\n<div class="scroll">\n${checkTable(area)}\n</div>`).join('\n')}

  <h2>It lints itself</h2>
  <p>10x402&rsquo;s own <code>402</code> &mdash; for both paid endpoints, in the production
  configuration &mdash; is run through 10x402&rsquo;s own engine on every build. It must grade
  <strong>A</strong> with zero findings, info included, or the build fails. A conformance linter
  that does not pass its own lint is a shop with a broken sign.</p>
  <p>The suite also holds a real 402 captured from a live production seller, frozen, as a positive
  control: a linter that grades every stranger&rsquo;s endpoint an F is indistinguishable, from the
  outside, from a linter that has found something.</p>

  <h2>Limits, stated plainly</h2>
  <ul>
    <li><code>POST /lint</code> sends exactly one unauthenticated request, carrying no payment
    header of either version, and follows no redirects. A redirect is reported as a finding, because
    it is one.</li>
    <li>It reads at most ${MAX_BODY_BYTES / 1024}&nbsp;KB of the response, and one 10s deadline
    covers the whole call &mdash; the connection, the headers and the body read. A target that
    answers and then dribbles is cut off on the same clock as one that never answers at all.</li>
    <li>It refuses plain http, private and reserved addresses, private-network names, and any port
    but 443 and 8443. For an endpoint that is not deployed yet, or on another port, use
    <code>/lint/envelope</code> and paste the response.</li>
    <li>The report is bounded: at most 8 <code>accepts[]</code> entries are linted, at most 200
    findings come back, and anything quoted out of your envelope is clipped. Each bound reports
    itself, so a short report is never a quietly truncated one.</li>
    <li>It does not resolve DNS, so it cannot defend against DNS rebinding. It is a public-URL
    linter and should not be deployed anywhere its egress can see a private network.</li>
    <li>It does not make a payment, so it cannot tell you whether your facilitator would accept
    one. It checks the envelope, which is where the failures actually are.</li>
    <li>Revenue to date: zero.</li>
  </ul>

  <footer>
    <p>${esc(SERVICE_NAME)} &middot; <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> &middot;
    machine surfaces: <a href="/openapi.json">openapi.json</a>,
    <a href="/llms.txt">llms.txt</a>, <a href="/skill.md">skill.md</a>,
    <a href="/.well-known/x402">.well-known/x402</a></p>
  </footer>
</main>
`;

// ---------------------------------------------------------------- openapi

const reportSchema = {
  type: 'object',
  required: ['grade', 'summary', 'findings', 'checks_run'],
  properties: {
    grade: { type: 'string', enum: GRADE_RULES.map((g) => g.grade), description: GRADE_RULES.map((g) => `${g.grade}: ${g.when}`).join('; ') },
    summary: {
      type: 'object',
      properties: {
        versions_detected: { type: 'array', items: { type: 'integer', enum: [1, 2] } },
        payTo: { type: ['string', 'null'] },
        network: { type: ['string', 'null'] },
        price: { type: ['string', 'null'] },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'code', 'message', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['error', 'warn', 'info'] },
          code: { type: 'string', enum: CHECKS.map((c) => c.id) },
          message: { type: 'string', description: 'what is wrong, in this envelope' },
          fix: { type: 'string', description: 'exactly how to fix it' },
        },
      },
    },
    checks_run: {
      type: 'integer',
      description:
        'how many checks APPLIED. A v1-only endpoint legitimately skips every v2 check, so this ' +
        'is the denominator a caller needs before comparing two reports.',
    },
  },
};

const paidResponses = {
  200: { description: 'the lint report', content: { 'application/json': { schema: reportSchema } } },
  400: {
    description: 'the request could not be linted. Nothing is charged for a call that was not served.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: { error: { type: 'string' }, fix: { type: 'string' } },
        },
      },
    },
  },
  402: {
    description:
      'Payment required — the ordinary answer to an unauthenticated call, and NOT an error. The ' +
      'body is the x402 v1 envelope; the PAYMENT-REQUIRED response header carries the v2 envelope ' +
      'as standard base64.',
    headers: {
      'PAYMENT-REQUIRED': { schema: { type: 'string' }, description: 'the x402 v2 envelope, standard base64' },
    },
  },
  413: { description: 'the request body is larger than the limit' },
  429: { description: 'the daily ceiling for this caller, or a deployment with no receiving address' },
};

const openapi = {
  openapi: '3.1.0',
  info: {
    title: SERVICE_NAME,
    version: '0.1.0',
    summary: SERVICE_TAGLINE,
    description:
      `${SERVICE_NAME} checks an x402 402 for conformance: ${CHECKS.length} checks over the v1 body ` +
      'envelope, the v2 PAYMENT-REQUIRED header envelope, dual-stack consistency between them, and ' +
      'the CDP Bazaar discovery requirements. Every finding carries the exact fix. Paid per call ' +
      'over x402 itself, in USDC on Base; there is no account and no API key — the payment is the auth.',
    contact: { email: SUPPORT_EMAIL },
  },
  servers: [{ url: CANONICAL_BASE }],
  paths: {
    [FREE_ENDPOINT.path]: {
      get: {
        operationId: 'check',
        summary: FREE_ENDPOINT.description,
        description: 'Free. Call this before paying for anything.',
        responses: {
          200: {
            description: 'service info, prices, the grade ladder and the full check catalogue',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    ...Object.fromEntries(
      ENDPOINTS.map((endpoint) => [
        endpoint.path,
        {
          post: {
            operationId: endpoint.id.replace(/-/g, '_'),
            summary: `${endpoint.description} (${priceLabel(endpoint.price_usd)})`,
            description: endpoint.long,
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema:
                    endpoint.id === 'lint'
                      ? {
                          type: 'object',
                          required: ['url'],
                          properties: {
                            url: { type: 'string', format: 'uri', description: 'the https URL of the paid endpoint to lint' },
                            method: { type: 'string', enum: ['POST', 'GET'], default: 'POST' },
                          },
                        }
                      : {
                          type: 'object',
                          required: ['status'],
                          properties: {
                            status: { type: 'integer', description: 'the HTTP status the endpoint answered with' },
                            headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'response headers; names are matched case-insensitively' },
                            body: { type: 'string', description: 'the response body, as text' },
                            url: { type: 'string', format: 'uri', description: 'optional: the URL it came from' },
                          },
                        },
                  example: endpoint.sample,
                },
              },
            },
            responses: paidResponses,
          },
        },
      ])
    ),
  },
  'x-x402': {
    versions: [1, 2],
    asset: USDC_BASE,
    networks: { 1: NETWORK_V1, 2: NETWORK_V2 },
    prices: Object.fromEntries(
      ENDPOINTS.map((e) => [e.path, { usd: priceLabel(e.price_usd), atomic: atomicAmount(e.price_usd) }])
    ),
    free_tier: false,
  },
};

// ---------------------------------------------------------------- .well-known/x402
//
// The discovery document. `payTo` is deliberately ABSENT: it is a runtime var
// the build has no access to, and publishing a stale or guessed receiving
// address in a static file is the single worst thing this repo could ship. The
// live 402 is the authority on terms, and this says so.

const wellKnown = {
  x402Version: 2,
  service: {
    name: SERVICE_NAME,
    description: SERVICE_TAGLINE,
    url: CANONICAL_BASE,
    tags: RESOURCE_TAGS,
    contact: SUPPORT_EMAIL,
  },
  resources: ENDPOINTS.map((e) => ({
    url: `${CANONICAL_BASE}${e.path}`,
    method: e.method,
    description: e.description,
    mimeType: e.mimeType,
    accepts: [
      {
        scheme: 'exact',
        network: NETWORK_V2,
        amount: atomicAmount(e.price_usd),
        asset: USDC_BASE,
      },
    ],
  })),
  free: [{ url: `${CANONICAL_BASE}${FREE_ENDPOINT.path}`, method: FREE_ENDPOINT.method, description: FREE_ENDPOINT.description }],
  note:
    'The authoritative terms — including payTo — are in the 402 each resource answers with. This ' +
    'document is static and deliberately carries no receiving address: a stale one in a file is ' +
    'worse than none. GET /check for the live catalogue.',
};

// ---------------------------------------------------------------- llms.txt

const llms = `# ${SERVICE_NAME} ("ten-ex-four-oh-two")

${SERVICE_TAGLINE}.

${CHECKS.length} conformance checks over an x402 402: the v1 body envelope, the v2
PAYMENT-REQUIRED header envelope, dual-stack consistency between them, and CDP
Bazaar discovery requirements. Every finding carries the exact fix.

## Endpoints

GET ${FREE_ENDPOINT.path} — free. Service info, prices, the grade ladder, the full check catalogue.
${ENDPOINTS.map((e) => `${e.method} ${e.path} — ${priceLabel(e.price_usd)}. ${e.description}.\n  takes: ${e.inputDescription}\n  returns: ${e.outputDescription}`).join('\n')}

## Paying

Every paid call answers 402 first, with an x402 envelope in both protocol
versions: v1 as the JSON body, v2 as standard base64 in a PAYMENT-REQUIRED
response header. A 402 IS NOT AN ERROR — it is the price, quoted in a form a
client can pay. Retry through an x402-capable client holding a wallet with USDC
on Base. No account, no API key.

asset    USDC on Base, ${USDC_BASE}
network  ${NETWORK_V1} (v1) / ${NETWORK_V2} (v2)
prices   ${ENDPOINTS.map((e) => `${e.path} ${priceLabel(e.price_usd)}`).join(', ')}
free tier  none, deliberately — one would fail this service's own HTTP_FREE_TIER_200 check

You are only charged for reports that are served. A bad URL or a malformed paste
settles nothing, even when the payment verified.

## The report

{"grade": "A".."F", "summary": {...}, "findings": [{"severity","code","message","fix"}], "checks_run": N}

checks_run is how many checks APPLIED, not how many exist: a v1-only endpoint
legitimately skips every v2 check.

## Grades

${GRADE_RULES.map((g) => `${g.grade}  ${g.when}`).join('\n')}

Core checks are the ones whose failure makes the envelope unusable as published.

## Checks

${AREA_ORDER.map(
  (area) =>
    `### ${AREAS[area]}\n${byArea(area)
      .map((c) => `${c.id}  [${c.severity}${c.core ? ', core' : ''}]  ${c.summary}`)
      .join('\n')}`
).join('\n\n')}

## Limits

POST /lint sends exactly one unauthenticated request with no payment header,
follows no redirects, reads at most ${MAX_BODY_BYTES / 1024} KB, and gives the whole call — connect,
headers and body read — one 10s deadline. It refuses plain http,
private/reserved addresses, private-network names, and any port but 443 and
8443. It does not resolve DNS, so it cannot defend against DNS rebinding. It
does not make a payment, so it cannot tell you whether your facilitator would
accept one.

The report is bounded: at most 8 accepts[] entries are linted, at most 200
findings are returned, and anything quoted back out of your envelope is
clipped. Every bound reports itself as an info finding, so a short report is
never a quietly truncated one. A non-402 response (a redirect, a free-tier 200,
a 405 to the POST this sends) skips the envelope checks entirely and says so in
summary.partial — there was never going to be an envelope there.

For an endpoint that is not deployed yet, POST /lint/envelope with the response
pasted in — same checks, no outbound request.

## Self-lint

10x402's own 402, for both paid endpoints, is run through 10x402's own engine on
every build and must grade A with zero findings.

Contact: ${SUPPORT_EMAIL}
`;

// ---------------------------------------------------------------- skill.md

const skill = `# ${SERVICE_NAME} — x402 conformance linting

Use this when an x402 endpoint "works" but nothing is happening: no buyers, no
listing in a discovery index, or payments that fail with a signature error you
cannot reproduce. Those are the failures x402 produces, and none of them raise
an error you will see.

## Call it

Free, no payment:

\`\`\`bash
curl -sS ${CANONICAL_BASE}${FREE_ENDPOINT.path}
\`\`\`

Lint a live endpoint (${priceLabel(ENDPOINTS[0].price_usd)}):

\`\`\`bash
curl -sS -X POST ${CANONICAL_BASE}/lint \\
  -H 'content-type: application/json' \\
  -d '{"url": "https://your-endpoint.example.com/api/thing"}'
\`\`\`

Lint a response you already have (${priceLabel(ENDPOINTS[1].price_usd)}) — works on staging,
on localhost, and on an endpoint that is not deployed yet:

\`\`\`bash
curl -sS -X POST ${CANONICAL_BASE}/lint/envelope \\
  -H 'content-type: application/json' \\
  -d '{"status": 402, "headers": {"payment-required": "<base64>"}, "body": "<the 402 body>"}'
\`\`\`

## A 402 is the price, not an error

The first unauthenticated call answers HTTP 402 carrying an x402 envelope in
both protocol versions. Do not report it as a failure and do not retry it
unpaid. Retry it through an x402-capable HTTP client holding a wallet with USDC
on Base; the client reads the envelope, signs, and retries with a payment
header. There is no login and no API key.

NEVER ask a person to paste a private key or a seed phrase.

## Read the report

\`\`\`json
${JSON.stringify(runSample(ENDPOINTS[1]), null, 2)}
\`\`\`

Each finding carries a \`fix\` written to be applied directly. Work through
\`error\` findings first — those are what a client, a facilitator or the index
will reject — then \`warn\`, which are the things that quietly cost the seller
discovery or a class of buyer. \`info\` never affects the grade.

\`checks_run\` is how many checks APPLIED. A v1-only endpoint skips every v2
check, so a rising \`checks_run\` between two reports means more of the surface
is now testable, not that the endpoint got worse.

## Grades

${GRADE_RULES.map((g) => `- **${g.grade}** — ${g.when}`).join('\n')}

## What it will not tell you

It checks the envelope, not the payment. It cannot tell you whether your
facilitator would accept a real payment, only whether the terms you published
are ones a client can sign against. It does not resolve DNS and follows no
redirects. It refuses private and reserved addresses — use \`/lint/envelope\`
for anything not publicly reachable.

Contact: ${SUPPORT_EMAIL}
`;

// robots.txt: allow everything. It exists so a prober gets a real 200 rather
// than a fallback, which is indistinguishable from a misconfigured site.
const robots = ['User-agent: *', 'Allow: /', '', `Sitemap: ${CANONICAL_BASE}/`, ''].join('\n');

// ---------------------------------------------------------------- write
//
// The self-lint runs HERE too, not only in the suite: `node build.mjs` is the
// command a deploy runs, and a build that emits a page advertising a service
// that fails its own lint should not produce output at all.

import { lint } from './worker/lint.js';
import { build402 } from './worker/envelope.js';

const SELF_LINT_PAYTO = '0x000000000000000000000000000000000000dEaD';
for (const endpoint of ENDPOINTS) {
  const own = build402(endpoint.id, SELF_LINT_PAYTO, {
    error: 'X-PAYMENT header is required',
    v2Error: 'Payment required',
  });
  const report = lint({ status: own.status, headers: own.headers, body: JSON.stringify(own.body) });
  if (report.findings.length) {
    console.error(`build: SELF-LINT FAILED for ${endpoint.path} — grade ${report.grade}`);
    console.error(JSON.stringify(report.findings, null, 2));
    process.exit(1);
  }
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, '.well-known'), { recursive: true });
writeFileSync(join(DIST, 'index.html'), html);
writeFileSync(join(DIST, 'openapi.json'), `${JSON.stringify(openapi, null, 2)}\n`);
writeFileSync(join(DIST, '.well-known', 'x402'), `${JSON.stringify(wellKnown, null, 2)}\n`);
writeFileSync(join(DIST, 'llms.txt'), llms);
writeFileSync(join(DIST, 'skill.md'), skill);
writeFileSync(join(DIST, 'robots.txt'), robots);

console.log(`build: ${CHECKS.length} checks across ${AREA_ORDER.length} areas`);
for (const area of AREA_ORDER) console.log(`  ${area.padEnd(8)} ${byArea(area).length}`);
console.log(`build: self-lint A with zero findings on ${ENDPOINTS.length} endpoints`);
for (const e of ENDPOINTS) console.log(`  ${e.method} ${e.path} — ${priceLabel(e.price_usd)}`);
console.log(`build: site base ${BASE}`);
if (HOST !== CANONICAL_HOST) {
  console.warn(
    `build: WARNING — dist/ now points at ${BASE}, not production. ` +
      'Run `node build.mjs` with no SITE_HOST override before committing or deploying.'
  );
}
console.log('build: NOTE — 10x402.com is not registered yet; nothing in this build depends on it resolving.');
console.log('build: wrote dist/index.html dist/openapi.json dist/.well-known/x402 dist/llms.txt dist/skill.md dist/robots.txt');
