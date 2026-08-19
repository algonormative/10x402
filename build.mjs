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

const PAGE_TITLE = `x402 endpoint not indexed? Check the published 402 | ${SERVICE_NAME}`;
const PAGE_DESCRIPTION =
  'Check the published 402 for response-level blockers when a service passes validate but is not indexed or showing up in Bazaar. Get a fix for each finding.';

const FAQS = [
  {
    question: 'Why does my x402 endpoint pass validate but not get indexed?',
    answer:
      'Base envelope validation and discovery are different layers. Bazaar metadata can be missing or fail its own schema, discoverable can be in the wrong place, or the unauthenticated probe can receive something other than a 402. 10x402 checks those technical blockers, but it cannot confirm whether Bazaar has crawled or approved a URL.',
  },
  {
    question: 'Why is my x402 service not showing up in Bazaar?',
    answer:
      'Check the HTTP response and the discovery metadata together: extensions.bazaar, the info-to-schema match, the v1 discoverable flag, and the status returned to an unpaid probe. A conformant response removes common listing blockers; it does not guarantee a listing.',
  },
  {
    question: 'What should I check during an x402 v1 vs v2 migration?',
    answer:
      'Check the version-specific network spelling, price field, resource shape, header encoding, and EIP-712 extra fields. If both versions are published, also check that payTo, price, chain, asset, and resource agree.',
  },
  {
    question: 'What is on the x402 conformance checklist?',
    answer: `${CHECKS.length} published checks: HTTP behavior, x402 v1 and v2 envelopes, dual-stack consistency, version hygiene, Bazaar discovery metadata, and two report safeguards that disclose truncation. Every finding includes a specific fix.`,
  },
  {
    question: 'Why is my x402 endpoint not discoverable?',
    answer:
      'Discoverability depends on more than returning status 402. The response must publish readable payment terms and the discovery fields expected by the indexer. 10x402 can identify response-level blockers; it cannot measure demand or inspect the index itself.',
  },
  {
    question: 'Does 10x402 store my URL, envelope, or report?',
    answer:
      'No linted URL, pasted envelope, or report is persisted in the application store. It retains aggregate lint results plus the quota and payment records needed to operate the service. What you lint is your business.',
  },
];

const jsonForHtml = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

// ---------------------------------------------------------------- the page
//
// Plain, and deliberately so. This is a workshop, not a launch spectacle: no
// gradients, invented demand or testimonial from a company that does not exist.
// The page gets someone to the right first call, then publishes the evidence.

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf7; --fg: #1b1a17; --muted: #625e55; --rule: #d9d3c5;
  --accent: #793c00; --panel: #f6f3ec; --code-bg: #eeebe3;
  --warn: #805900; --err: #94221d; --ok: #176329; --focus: #1e66b2;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16150f; --fg: #eee9de; --muted: #aaa291; --rule: #3a372e;
    --accent: #e4aa65; --panel: #1c1b15; --code-bg: #25231c;
    --warn: #d7a743; --err: #eb8178; --ok: #83ca92; --focus: #83bfff;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; padding: 0 1.25rem 5rem; background: var(--bg); color: var(--fg); font: 16px/1.65 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
main { max-width: 66rem; margin: 0 auto; }
header { padding: 4rem 0 2.5rem; }
h1 { max-width: 18ch; font-size: clamp(2.2rem, 6vw, 4.4rem); line-height: 1.03; margin: .2rem 0 1rem; letter-spacing: -.055em; }
h2 { font-size: clamp(1.25rem, 3vw, 1.55rem); line-height: 1.25; margin: 4rem 0 1rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); }
h3 { font-size: 1.08rem; line-height: 1.4; margin: 2rem 0 .5rem; color: var(--accent); }
p { max-width: 49rem; }
a { color: var(--accent); text-underline-offset: .16em; }
a:focus-visible, summary:focus-visible { outline: 3px solid var(--focus); outline-offset: 4px; border-radius: 2px; }
.eyebrow { margin: 0; color: var(--accent); font-size: .8rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.lede { max-width: 48rem; font-size: clamp(1.05rem, 2vw, 1.22rem); }
.muted { color: var(--muted); }
.small { font-size: .86rem; }
.new-note, .callout { margin: 1.2rem 0; padding: .8rem 1rem; border-left: 3px solid var(--accent); background: var(--panel); }
.spine { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin: 1.6rem 0 .5rem; padding: 0; list-style: none; font-size: clamp(1rem, 2.5vw, 1.2rem); font-weight: 700; }
.spine li:not(:last-child)::after { content: "→"; padding-left: .5rem; color: var(--accent); }
.spine-note { margin-top: 0; max-width: 54rem; }
.quick-nav { display: flex; flex-wrap: wrap; gap: .45rem 1rem; max-width: none; margin-top: 2rem; padding: 0; list-style: none; font-size: .84rem; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin: 1.25rem 0; }
.path-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.card { padding: 1rem 1.1rem; border: 1px solid var(--rule); border-radius: 6px; background: var(--panel); }
.card h3 { margin-top: 0; }
.trust { border-top: 3px solid var(--accent); }
code { background: var(--code-bg); padding: .1em .35em; border-radius: 3px; font-size: .9em; }
pre { margin: .65rem 0 1rem; background: var(--code-bg); padding: .9rem 1rem; border-radius: 5px; overflow-x: auto; font-size: .83rem; line-height: 1.5; }
pre code { background: none; padding: 0; font-size: 1em; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .84rem; }
caption { text-align: left; color: var(--muted); padding: 0 0 .45rem; }
th, td { text-align: left; padding: .6rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: .06em; font-size: .7rem; }
td.code { white-space: nowrap; font-weight: 600; }
.scroll { overflow-x: auto; }
.scroll:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
.sev { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; }
.sev-error { color: var(--err); } .sev-warn { color: var(--warn); } .sev-info { color: var(--muted); }
.core-label { display: inline-block; margin-left: .35rem; color: var(--muted); font-size: .66rem; }
.grade { font-weight: 700; }
ul, ol { max-width: 49rem; padding-left: 1.3rem; }
li { margin: .4rem 0; }
details { margin: .75rem 0; border: 1px solid var(--rule); border-radius: 5px; background: var(--panel); }
summary { display: flex; justify-content: space-between; gap: 1rem; padding: .85rem 1rem; cursor: pointer; color: var(--accent); font-weight: 700; }
.details-body { padding: 0 1rem .5rem; }
.count { color: var(--muted); font-weight: 400; white-space: nowrap; }
footer { margin-top: 4rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); color: var(--muted); font-size: .83rem; }
@media (max-width: 44rem) { body { padding-inline: .9rem; } header { padding-top: 2.5rem; } .grid, .path-grid { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
`;

function checkTable(area) {
  const rows = byArea(area)
    .map(
      (c) => `        <tr>
          <td class="code">${esc(c.id)}</td>
          <td class="sev sev-${c.severity}">${c.severity}${c.core ? ' <span class="core-label">core</span>' : ''}</td>
          <td>${inline(c.summary)}</td>
        </tr>`
    )
    .join('\n');
  return `      <table>
        <caption>${esc(AREAS[area])}: ${byArea(area).length} checks</caption>
        <thead><tr><th scope="col">code</th><th scope="col">severity</th><th scope="col">what it checks</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>`;
}

function endpointSection(endpoint) {
  const sample = sampleInputBody(endpoint);
  const report = runSample(endpoint);
  return `      <h3 id="offer-${esc(endpoint.id)}"><code>${endpoint.method} ${esc(endpoint.path)}</code> &mdash; ${priceLabel(endpoint.price_usd)} per report</h3>
      <p>${esc(endpoint.long)}</p>
      <p><strong>First, request the quote.</strong> This unauthenticated call returns HTTP <code>402</code> with the price and payment terms. It does not return the lint report yet.</p>
      <div class="scroll" role="region" aria-label="${esc(endpoint.path)} request example" tabindex="0"><pre><code>curl -sS -X POST ${esc(BASE)}${esc(endpoint.path)} \\
  -H 'content-type: application/json' \\
  -d '${esc(sample)}'</code></pre></div>
      <p class="muted small">Then let an x402-capable client pay and retry the same request. A successful paid retry returns the report.</p>
      <details><summary><span>Example paid report</span><span class="count">generated by the current engine</span></summary>
        <div class="details-body"><p class="small">This build-computed example shows the successful paid response shape. The unpaid <code>curl</code> above returns the 402 quote instead.</p>
        <div class="scroll" role="region" aria-label="${esc(endpoint.path)} report example" tabindex="0"><pre><code>${esc(JSON.stringify(report, null, 2))}</code></pre></div></div>
      </details>`;
}

const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'SoftwareApplication',
      '@id': `${CANONICAL_BASE}/#software`,
      name: SERVICE_NAME,
      url: `${CANONICAL_BASE}/`,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Web',
      description: PAGE_DESCRIPTION,
      offers: [
        {
          '@type': 'Offer',
          name: `${FREE_ENDPOINT.method} ${FREE_ENDPOINT.path} service catalogue`,
          url: `${CANONICAL_BASE}${FREE_ENDPOINT.path}`,
          price: '0',
          priceCurrency: 'USD',
        },
        ...ENDPOINTS.map((e) => ({
          '@type': 'Offer',
          name: `${e.method} ${e.path} report`,
          url: `${CANONICAL_BASE}/#offer-${e.id}`,
          price: String(e.price_usd),
          priceCurrency: 'USD',
          description: 'Paid in USDC on Base.',
        })),
      ],
    },
    {
      '@type': 'FAQPage',
      '@id': `${CANONICAL_BASE}/#faq`,
      mainEntity: FAQS.map(({ question, answer }) => ({
        '@type': 'Question',
        name: question,
        acceptedAnswer: { '@type': 'Answer', text: answer },
      })),
    },
  ],
};

// `<meta charset>` FIRST, before the title, and it has to be in the first 1024
// bytes or the browser has already guessed. Caught by looking at the rendered
// page: the tab read "10x402 â€” x402 conformance…" because a host serving
// `text/html` with no charset parameter leaves the browser to fall back to
// latin-1, and this page is full of em dashes and curly quotes. Cloudflare
// Pages would have sent the charset and hidden it; the file should be right on
// its own.
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(PAGE_TITLE)}</title>
<meta name="description" content="${esc(PAGE_DESCRIPTION)}">
<link rel="canonical" href="${CANONICAL_BASE}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(SERVICE_NAME)}">
<meta property="og:title" content="Your 402 works. Agents still can't pay you.">
<meta property="og:description" content="${esc(PAGE_DESCRIPTION)}">
<meta property="og:url" content="${CANONICAL_BASE}/">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Your 402 works. Agents still can't pay you.">
<meta name="twitter:description" content="${esc(PAGE_DESCRIPTION)}">
<script type="application/ld+json">${jsonForHtml(structuredData)}</script>
<style>${CSS}</style>
</head>
<body>
<main>
  <header>
    <p class="eyebrow">${esc(SERVICE_NAME)} <span class="say">&middot; ten-ex-four-oh-two</span></p>
    <h1>Your 402 works. Agents still can't pay you.</h1>
    <p class="lede">A ${CHECKS.length}-check catalogue against your live 402, with a specific fix
    for each finding &mdash; the rules the Bazaar docs never wrote down.</p>
    <ol class="spine" aria-label="From a correct 402 to payment">
      <li>Ship a correct 402</li>
      <li>Get indexed</li>
      <li>Get paid</li>
    </ol>
    <p class="muted spine-note">10x402 identifies observable conformance blockers between those
    steps and gives you the fix for each finding. It cannot guarantee a Bazaar listing, demand, or
    a payment that settles.</p>
    <p class="new-note"><strong>10x402 is new.</strong> There are no customer stories, usage claims,
    or testimonials here. The evidence is the published catalogue, self-lint, and storage boundary.</p>
    <nav class="quick-nav" aria-label="Page sections">
      <a href="#start">Start here</a><a href="#worked-examples">Worked requests</a>
      <a href="#trust">Trust boundaries</a><a href="#checklist">Full checklist</a>
      <a href="#faq">FAQ</a>
    </nav>
  </header>

  <section aria-labelledby="start">
    <h2 id="start">Start here</h2>
    <p>The catalogue is free. Lint reports are paid per served report; there is no free lint tier.</p>
    <div class="grid">
      <article class="card">
        <h3>For a person building an endpoint</h3>
        <p>Read every check and price before paying:</p>
        <div class="scroll" role="region" aria-label="Free catalogue curl command" tabindex="0"><pre><code>curl -sS ${esc(BASE)}${esc(FREE_ENDPOINT.path)}</code></pre></div>
        <p class="small">Then use <code>/lint</code> for a public URL, or
        <code>/lint/envelope</code> for a response captured from local, staging, or authenticated code.
        To pay and retry, follow the official <a href="https://docs.x402.org/getting-started/quickstart-for-buyers">x402 buyer quickstart</a>
        for <code>@x402/fetch</code> or another supported client.</p>
      </article>
      <article class="card">
        <h3>For an agent</h3>
        <p>Read <a href="/skill.md">skill.md</a> for the operating instructions, or
        <a href="/llms.txt">llms.txt</a> for the complete compact reference. The
        <a href="/openapi.json">OpenAPI contract</a> and free <code>GET /check</code> route are
        machine-readable. In MCP, call <code>x402_checks</code> first.</p>
      </article>
    </div>
    <div class="scroll" role="region" aria-label="10x402 prices" tabindex="0"><table class="pricing">
      <caption>One route for each stage of the job</caption>
      <thead><tr><th scope="col">route</th><th scope="col">use it for</th><th scope="col">price</th></tr></thead>
      <tbody>
        <tr><td><code>${FREE_ENDPOINT.method} ${esc(FREE_ENDPOINT.path)}</code></td><td>Catalogue, prices, and grade rules</td><td>free</td></tr>
${ENDPOINTS.map((e) => `        <tr><td><code>${e.method} ${esc(e.path)}</code></td><td>${e.id === 'lint' ? 'A live public endpoint' : 'A captured or local 402 response'}</td><td>${priceLabel(e.price_usd)} per report</td></tr>`).join('\n')}
      </tbody>
    </table></div>
  </section>

  <section aria-labelledby="outcome-path">
    <h2 id="outcome-path">Ship a correct 402 → get indexed → get paid</h2>
    <div class="grid path-grid">
      <article class="card"><h3>1. Ship a correct 402</h3><p>Check the HTTP response, v1 body,
      v2 <code>PAYMENT-REQUIRED</code> header, and the fields an agent must sign.</p></article>
      <article class="card"><h3>2. Remove indexing blockers</h3><p>Check Bazaar metadata,
      info-to-schema consistency, discoverability flags, and what an unpaid probe receives.</p></article>
      <article class="card"><h3>3. Publish payable terms</h3><p>Check that an agent can read the
      amount, asset, network, recipient, and EIP-712 domain. The linter does not make a payment.</p></article>
    </div>
  </section>

  <section aria-labelledby="validate-not-indexed">
    <h2 id="validate-not-indexed">Why an x402 endpoint passes validate but is not indexed</h2>
    <p>Validation, discovery, and payment do not all read the same parts of a 402. If your x402
    service is not showing up in Bazaar, the base envelope may be valid while discovery metadata
    is missing, placed incorrectly, or inconsistent with its schema.</p>
    <p>A url-safe base64 v2 envelope can be rejected before it is decoded. Missing EIP-712
    <code>extra</code> fields can make the client and facilitator sign different domains. A free
    response can give an unpaid discovery probe a 200 when it expects a 402. These are response-level
    blockers 10x402 can surface; it does not inspect Bazaar&rsquo;s index or infer demand.</p>
  </section>

  <section aria-labelledby="worked-examples">
    <h2 id="worked-examples">Choose a lint, then pay and retry</h2>
    <p>Every paid route answers <code>402</code> first. The v1 terms are in the JSON body and the v2
    terms are standard base64 in the <code>PAYMENT-REQUIRED</code> header. An x402-capable client
    holding USDC on Base reads those terms, pays, and retries the same request. There is no login or
    API key; the payment is the authorization.</p>
${ENDPOINTS.map(endpointSection).join('\n\n')}
    <div class="callout">
      <p><strong>Payment terms:</strong> USDC on Base at <code>${USDC_BASE}</code>;
      <code>${NETWORK_V1}</code> in v1 and <code>${NETWORK_V2}</code> in v2.</p>
      <p>You are only charged for a report that is served. A bad URL, unreachable target, or malformed
      paste settles nothing, even if the payment verified.</p>
    </div>
  </section>

  <section aria-labelledby="report">
    <h2 id="report">Read the report: fix payment blockers first</h2>
    <div class="scroll" role="region" aria-label="Grade rules" tabindex="0"><table>
      <caption>The grade ladder</caption>
      <thead><tr><th scope="col">grade</th><th scope="col">when</th></tr></thead>
      <tbody>
${GRADE_RULES.map((g) => `        <tr><td class="grade">${g.grade}</td><td>${esc(g.when)}</td></tr>`).join('\n')}
      </tbody>
    </table></div>
    <p><strong>Core</strong> checks are the failures that make an envelope unusable as published.
    One core error is an F. Ordinary errors are a D; warnings count toward B or C.</p>
    <p class="muted">Severities: ${Object.entries(SEVERITY_BLURB)
      .map(([k, v]) => `<strong class="sev-${k}">${k}</strong> &mdash; ${esc(v)}`)
      .join('; ')}.</p>
    <p><code>checks_run</code> is the number of catalogue checks that applied, not the total
    available. A v1-only response legitimately skips v2 checks.</p>
  </section>

  <section aria-labelledby="trust">
    <h2 id="trust">Two things you should not have to take on faith</h2>
    <div class="grid">
      <article class="card trust">
        <h3>It has to pass its own lint</h3>
        <p>The test suite runs the production-configured Worker under workerd, takes the 402 it
        actually serves for both paid endpoints, and requires grade A with zero findings. Every
        build also constructs both paid envelopes, self-lints them, and fails on any finding before
        writing <code>dist/</code>.</p>
      </article>
      <article class="card trust">
        <h3>What you lint is your business</h3>
        <p>The application store keeps no linted URLs, no pasted envelopes, and no reports. It
        retains aggregate lint results plus the quota and payment records needed to operate the
        service; it does not persist the material being linted.</p>
      </article>
    </div>
    <p class="small muted">The suite also keeps a frozen 402 captured from a live production seller
    as a positive control. It is not presented as a current live-domain check.</p>
  </section>

  <section aria-labelledby="checklist">
    <h2 id="checklist">The x402 conformance checklist: ${CHECKS.length} published checks</h2>
    <p>Sixty-two checks inspect HTTP and x402 conformance. Two report safeguards disclose truncated
    input or findings, so a partial report cannot read as clean. Every finding includes a code,
    message, severity, and specific <code>fix</code>.</p>
    <ul class="quick-nav" aria-label="Checklist areas">
${AREA_ORDER.map((area) => `      <li><a href="#checks-${area}">${esc(AREAS[area])} (${byArea(area).length})</a></li>`).join('\n')}
    </ul>
${AREA_ORDER.map((area) => `    <details id="checks-${area}"${area === 'http' ? ' open' : ''}>
      <summary><span>${esc(AREAS[area])}</span><span class="count">${byArea(area).length} checks</span></summary>
      <div class="details-body"><div class="scroll" role="region" aria-label="${esc(AREAS[area])} checks" tabindex="0">
${checkTable(area)}
      </div></div>
    </details>`).join('\n')}
  </section>

  <section aria-labelledby="faq">
    <h2 id="faq">x402 discovery and migration FAQ</h2>
${FAQS.map(({ question, answer }) => `    <details class="faq">
      <summary>${esc(question)}</summary>
      <div class="details-body"><p>${esc(answer)}</p></div>
    </details>`).join('\n')}
  </section>

  <section aria-labelledby="limits">
    <h2 id="limits">Limits, stated plainly</h2>
    <ul>
      <li><code>POST /lint</code> sends one unauthenticated request with no payment header and
      follows no redirects. A redirect is reported as a finding.</li>
      <li>It reads at most ${MAX_BODY_BYTES / 1024}&nbsp;KB, and one 10s deadline covers the
      connection, headers, and body read.</li>
      <li>It refuses plain http, private and reserved addresses, private-network names, and ports
      other than 443 and 8443. Use <code>/lint/envelope</code> for anything else.</li>
      <li>At most 8 <code>accepts[]</code> entries are linted, at most 200 findings come back, and
      quoted input is clipped. Each bound reports itself.</li>
      <li>The URL guard does not pre-resolve DNS, so it cannot defend against DNS rebinding. This is
      a public-URL linter and should not be deployed where egress can reach a private network.</li>
      <li>It checks the published HTTP 402 and envelopes. It does not make a payment to the seller,
      confirm a live Bazaar listing, or measure demand.</li>
    </ul>
  </section>

  <footer>
    <p>${esc(SERVICE_NAME)} &middot; <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> &middot;
    machine surfaces: <a href="/openapi.json">openapi.json</a>,
    <a href="/llms.txt">llms.txt</a>, <a href="/skill.md">skill.md</a>,
    <a href="/.well-known/x402">.well-known/x402</a></p>
  </footer>
</main>
</body>
</html>
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
      `${SERVICE_NAME} finds conformance blockers between a working 402, discovery and payment. Its ` +
      `${CHECKS.length}-check catalogue covers the HTTP response, v1 body, v2 PAYMENT-REQUIRED ` +
      'header, dual-stack consistency, Bazaar discovery metadata and report safeguards. Every ' +
      'finding includes a specific fix. Paid per call over x402 itself, in USDC on Base; there is ' +
      'no account and no API key — the payment is the auth.',
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

Your 402 works. Agents still cannot pay you.

Ship a correct 402 → remove indexing blockers → publish payable terms. 10x402
cannot guarantee indexing, demand or settlement. Its ${CHECKS.length}-check catalogue covers the
HTTP response, v1 body envelope, v2 PAYMENT-REQUIRED header, dual-stack
consistency, Bazaar discovery metadata and report safeguards. Every finding
includes a specific fix.

## Endpoints

GET ${FREE_ENDPOINT.path} — free. Start here: service info, prices, grades, full check catalogue.
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
8443. The URL guard does not pre-resolve DNS, so it cannot defend against DNS
rebinding. It does not make a payment, query Bazaar's index or measure demand.

The report is bounded: at most 8 accepts[] entries are linted, at most 200
findings are returned, and anything quoted back out of your envelope is
clipped. Every bound reports itself as an info finding, so a short report is
never a quietly truncated one. A non-402 response (a redirect, a free-tier 200,
a 405 to the POST this sends) skips the envelope checks entirely and says so in
summary.partial — there was never going to be an envelope there.

For an endpoint that is not deployed yet, POST /lint/envelope with the response
pasted in — same checks, no outbound request.

## Self-lint

The test suite lints the 402 that the Worker actually serves. Every build also
self-lints both paid endpoint envelopes and fails on any finding.

## Privacy

The application store keeps no linted URLs, pasted envelopes or reports. It
retains aggregate lint results plus the quota and payment records needed to
operate the service.

Contact: ${SUPPORT_EMAIL}
`;

// ---------------------------------------------------------------- skill.md

const skill = `# ${SERVICE_NAME} — identify blockers to indexing and payment

Use this when an x402 endpoint passes validate but is not indexed, an x402
service is not showing up in Bazaar, a payment fails with a signature error, or
an x402 v1 vs v2 migration has drifted. It finds response-level blockers; it
cannot guarantee a listing, demand or a successful settlement.

## Call it

Free, no payment:

\`\`\`bash
curl -sS ${CANONICAL_BASE}${FREE_ENDPOINT.path}
\`\`\`

The paid examples below show the request shape. An unpaid call returns a 402
quote, not the report; an x402-capable client must pay and retry the request.
Use the official [x402 buyer quickstart](https://docs.x402.org/getting-started/quickstart-for-buyers)
to configure \`@x402/fetch\` or another supported client.

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

## Trust boundaries

The test suite lints the 402 that the Worker actually serves. Every build also
self-lints both paid endpoint envelopes and fails on any finding.

The application store keeps no linted URLs, pasted envelopes or reports. What
you lint is your business.

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

It checks the published HTTP 402 and its envelopes; it does not attempt a real
payment to the seller, query Bazaar's index or measure demand. It follows no
redirects. The URL guard does not pre-resolve DNS, so it cannot defend against
DNS rebinding. It refuses private and reserved addresses — use
\`/lint/envelope\` for anything not publicly reachable.

Contact: ${SUPPORT_EMAIL}
`;

// robots.txt: allow everything. It exists so a prober gets a real 200 rather
// than a fallback, which is indistinguishable from a misconfigured site.
const robots = ['User-agent: *', 'Allow: /', ''].join('\n');

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
