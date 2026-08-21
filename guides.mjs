// The guides: field manuals for the situations the checks were built from.
//
// EVERYTHING CLAIMED HERE IS SOURCED. Each guide writes down what this
// service's own operation established — census numbers from x402#3104, the
// silent-rejection mechanics from x402#3045, the settlement-written indexing
// behavior proven by our own priming runs — and nothing it did not. The same
// honesty rules as the product copy: no demand claims, no guarantees, the paid
// CTA is priced and modest, and the free path is always named first.
//
// Rendered by build.mjs into dist/guides/<slug>/index.html with the site's own
// shell (fonts, palette, copy buttons); the body strings here are the content
// half only. Dates are hand-maintained: `published` never moves, `updated`
// moves when the content materially changes.

import { CHECKS } from './worker/lint.js';
import { ENDPOINTS_BY_ID, priceLabel } from './worker/catalog.js';

const price = (id) => priceLabel(ENDPOINTS_BY_ID.get(id).price_usd);

export const GUIDES = [
  {
    slug: 'bazaar-not-indexed',
    title: 'Your x402 endpoint settles payments but never appears in the Bazaar',
    description:
      'Why a working x402 endpoint stays invisible in CDP Bazaar discovery: rows are written by settlement, rejections are silent, and the blockers live in the 402 you already serve. A field manual with the fix ladder.',
    published: '2026-08-21',
    updated: '2026-08-21',
    body: `
<p class="section-lede">The most reported x402 seller failure is also the quietest one: the
endpoint passes <code>validate</code>, real payments settle, and the discovery catalog never
mentions it. Nothing errors. Nothing logs. It is just not there.</p>

<h2 id="how-rows-get-written">How a Bazaar row actually gets written</h2>
<p>Three mechanics explain almost every "not indexed" report, and all three are documented —
one section deep, where nobody reads until they are stuck:</p>
<ul>
  <li><strong>Rows are written by settlement, not by deployment.</strong> A resource enters the
  catalog after a real payment <em>settles</em> against it while its 402 carries a valid
  declaration. Deploying a perfect endpoint writes nothing. No call has settled — no row.</li>
  <li><strong>Indexing is per resource.</strong> One settled call on <code>/convert/a</code> does
  not list <code>/convert/b</code>. We proved this on our own sibling service: five endpoints
  deployed identically, and for a day exactly one — the only one that had ever settled a
  payment — was in the catalog. One small self-test call per endpoint lit up the other four.</li>
  <li><strong>Rejection is silent.</strong> When the facilitator's validation declines your
  declaration, nothing reaches your logs (<a
  href="https://github.com/x402-foundation/x402/issues/3045">x402#3045</a> is the long-running
  thread on exactly this). The endpoint keeps taking payments and simply never appears.</li>
</ul>
<p>Crawl latency after a qualifying settlement is minutes-scale — we have measured roughly two
to eleven minutes on our own endpoints. If it has been hours, the settlement was not the
problem; the declaration is.</p>

<h2 id="the-ladder">The fix ladder, in the order the failures actually occur</h2>
<p>Each rung names the check that catches it, so you can buy exactly one answer if that is all
you need.</p>
<ol>
  <li><strong>No v2 header at all.</strong> A v1-only endpoint is not broken — current clients
  pay it fine — but CDP indexing reads the <code>PAYMENT-REQUIRED</code> header, so v1-only
  means <em>payable but unlisted</em>. (<code>V2_HEADER_PRESENT</code>)</li>
  <li><strong>No <code>extensions.bazaar</code>.</strong> In v2, the presence of this extension
  IS the discovery opt-in. There is no <code>discoverable</code> flag any more — a CDP engineer
  confirmed on x402#3045 that it is "not a valid field". (<code>V2_BAZAAR_PRESENT</code>)</li>
  <li><strong><code>info</code> does not validate against <code>schema</code>.</strong> The spec
  requires the facilitator to validate one against the other before cataloging, and this exact
  mismatch is the silent delisting: usually a <code>const</code> that no longer matches after a
  rename, a required field the example dropped, or
  <code>"additionalProperties":&nbsp;false</code> meeting a field the example added.
  (<code>V2_BAZAAR_INFO_VALIDATES</code>; the self-contradiction variant has
  <a href="/guides/wrong-bag/">its own guide</a>.)</li>
  <li><strong>The network identifier is in the wrong form.</strong> v2 wants CAIP-2
  (<code>eip155:8453</code>); a bare <code>"base"</code> in a v2 envelope fails the provider's
  required network preflight. (<code>V2_NETWORK_SUPPORTED</code>)</li>
  <li><strong>The declared verb disagrees with the probe.</strong> The catalog's validator
  replays your declared input; a declaration that says <code>PUT</code> on a resource that was
  probed with <code>POST</code> fails a required preflight. (<code>V2_BAZAAR_INPUT_METHOD</code>)</li>
</ol>

<h2 id="verify">Verify it yourself, free</h2>
<p>The full catalog is a public API. Your listing is either in it or it is not:</p>
<div class="scroll" role="region" aria-label="catalog query" tabindex="0"><pre><code>curl -s "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=1000" \\
  | grep -c "your-host.example.com"</code></pre></div>
<p>One caution from operating against this API: the documented <code>?payTo=</code> filter is
accepted and ignored — the response is the same unfiltered page whatever you pass. Page through
with <code>limit</code> and <code>offset</code> and search the whole catalog; that is the only
read that cannot lie to you.</p>

<h2 id="the-shortcut">The shortcut</h2>
<p>The free <a href="/check">GET /check</a> lists all ${CHECKS.length} published checks.
<a href="/#offer-lint"><code>POST /lint</code></a> (${price('lint')}) runs every one against
your live 402 and returns a specific fix per finding, with a separate
<code>bazaar_ready</code> verdict so a payment-fine-but-unlisted endpoint is never told it is
"broken". <a href="/#offer-presence"><code>POST /presence</code></a> (${price('presence')})
answers the other half: whether the catalog, the explorer, and the chain can actually see you
right now — with the evidence attached.</p>
`,
  },
  {
    slug: 'wrong-bag',
    title: 'The wrong-bag contradiction: when your Bazaar example and schema disagree',
    description:
      'A census of the live x402 catalog found 276 listings whose worked example puts a required parameter in a different bag than their own schema requires. Both consumers of the declaration lose, no probe can arbitrate, and the fix is one move.',
    published: '2026-08-21',
    updated: '2026-08-21',
    body: `
<p class="section-lede">A Bazaar declaration has two halves that must agree: <code>info</code>,
one worked example of the call, and <code>schema</code>, the JSON Schema that example validates
against. There is a specific way they disagree that is worth its own name, because a census of
the live catalog found it <strong>276 times across 59 hosts</strong>.</p>

<h2 id="the-shape">The shape</h2>
<p>From a live specimen found on
<a href="https://github.com/x402-foundation/x402/issues/3104">x402#3104</a> (a route template
of <code>/api/:name/followers</code>):</p>
<div class="scroll" role="region" aria-label="the contradiction" tabindex="0"><pre><code>info.input.pathParams   = { "name": "BobbyThakkar" }   // the example: name in the PATH
info.input.queryParams  = {}

schema …properties.queryParams = { …, "required": ["name"] }  // the schema: name as a QUERY param
schema …properties.pathParams  = { "type": "object" }         // and nothing about the path</code></pre></div>
<p>The example supplies <code>name</code> as a path parameter. The schema requires
<code>name</code> as a query parameter. The two halves of one declaration disagree about which
bag the parameter lives in.</p>

<h2 id="both-lose">Both consumers lose</h2>
<ul>
  <li>A consumer that does what the spec asks — validate <code>info</code> against
  <code>schema</code> — <strong>rejects the publisher's own example</strong>. That is the
  facilitator's required preflight, so this shape is also a silent delisting.</li>
  <li>A consumer that builds a request from the schema sends
  <code>?name=…</code> at a URL whose path still contains the literal <code>:name</code> —
  the parameter goes where the route will not read it.</li>
</ul>
<p>And no buyer can probe their way out. On most hosts the 402 answers before parameter
validation (the same census measured ~94% of hosts returning 404 for an impossible path, but a
402-gated-before-routing platform answers 402 to <em>everything</em>), so the declaration is
the only contract available before payment — and this one contradicts itself. The finding is
about the declaration, not the service: the route may well accept both spellings. Nobody can
know without paying.</p>

<h2 id="the-fix">The fix is one move</h2>
<p>Make the halves agree, in whichever direction is true: either the schema names the bag the
worked example really uses, or the example moves the key into the bag the schema requires.
Then re-settle one call so the corrected declaration is re-crawled — rows are written by
settlement, per resource (<a href="/guides/bazaar-not-indexed/">the indexing guide</a> covers
that mechanic).</p>

<h2 id="check-it">Check it in CI for two cents</h2>
<p>The generic mismatch and the wrong-bag diagnosis are separate checks here, because their fix
messages differ: <code>V2_BAZAAR_INFO_VALIDATES</code> tells you the pair disagrees;
<code>V2_BAZAAR_BAG_MISMATCH</code> names both bags — "required in queryParams, supplied in
pathParams" — which is the fix spelled out.</p>
<div class="scroll" role="region" aria-label="single check request" tabindex="0"><pre><code>curl -sS -X POST https://10x402.com/lint/one \\
  -H 'content-type: application/json' \\
  -d '{"url": "https://your-endpoint.example.com/api/thing", "check": "V2_BAZAAR_BAG_MISMATCH"}'</code></pre></div>
<p>${price('lint-one')} live, ${price('lint-envelope-one')} against a pasted response — priced
for a CI step that runs on every commit. The full ${CHECKS.length}-check report is
<a href="/#offer-lint"><code>POST /lint</code></a> at ${price('lint')}.</p>
`,
  },
  {
    slug: 'registry-coverage',
    title: 'The x402 registry coverage playbook: Bazaar, x402scan, and the chain',
    description:
      'What actually writes each x402 registry, how to verify every listing by hand for free, and the one habit that keeps a seller visible: settle one call per resource and check the coverage after every change.',
    published: '2026-08-21',
    updated: '2026-08-21',
    body: `
<p class="section-lede">Being payable and being findable are different properties, written by
different systems. This is the coverage map we operate our own endpoints by: what writes each
surface, how to read it back for free, and where the latencies are.</p>

<h2 id="the-map">The map</h2>
<div class="scroll" role="region" aria-label="registry coverage map" tabindex="0">
<table>
  <thead><tr><th>surface</th><th>a listing is written by</th><th>read it back</th><th>latency</th></tr></thead>
  <tbody>
    <tr><td><strong>CDP Bazaar</strong></td>
        <td>a settled payment against that exact resource while its 402 carries a valid declaration — per resource, never by deployment</td>
        <td>page the public catalog API (<code>limit=1000</code> + <code>offset</code>) and search it — the documented <code>payTo</code> filter is accepted and ignored</td>
        <td>minutes after a qualifying settlement</td></tr>
    <tr><td><strong>x402scan</strong></td>
        <td>registering at <a href="https://www.x402scan.com/resources/register">x402scan.com/resources/register</a> — it imports an <code>openapi.json</code> and validates against live discovery data</td>
        <td>search the explorer by your payTo or resource URL</td>
        <td>immediate on registration</td></tr>
    <tr><td><strong>x402‑list</strong></td>
        <td>a manual submission form, reviewed by a human</td>
        <td>read the list</td>
        <td>days — it is a human queue</td></tr>
    <tr><td><strong>the chain itself</strong></td>
        <td>nothing to submit — every settlement is a USDC transfer to your payTo on Base, visible to anyone</td>
        <td>any Base explorer, by your payTo address</td>
        <td>a block</td></tr>
  </tbody>
</table>
</div>

<h2 id="habits">The two habits that keep coverage</h2>
<ul>
  <li><strong>Settle one call per resource, after every declaration change.</strong> The Bazaar
  row is a snapshot of the declaration that was live when a payment settled. Fix your envelope
  and stop there, and the catalog keeps serving the old one. This is the cheapest self-test in
  the ecosystem: one minimum-price call to your own endpoint, from any funded wallet.</li>
  <li><strong>Give each endpoint a distinct price.</strong> The amount is the one field a bare
  chain explorer shows. Unique prices make every settlement attributable to its endpoint with
  no analytics at all — we run our own price sheet this way, and it has already paid for
  itself in debugging time.</li>
</ul>

<h2 id="verify-by-hand">Verify the whole map by hand, free</h2>
<div class="scroll" role="region" aria-label="manual coverage checks" tabindex="0"><pre><code># Bazaar: is the resource in the catalog? (page through; total is in .pagination)
curl -s "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=1000&offset=0" \\
  | grep -c "your-host.example.com"

# chain: has anything ever settled to your payTo?
curl -s "https://base.blockscout.com/api?module=account&action=tokentx&address=0xYOURPAYTO&page=1&offset=10&sort=desc"</code></pre></div>
<p>Two operating notes from doing this daily: explorer APIs rate-limit shared egress IPs, so an
occasional 429 means "try again", not "no data" — and an answer you could not read is never
evidence of absence.</p>

<h2 id="one-call">Or buy the whole read in one call</h2>
<p><a href="/#offer-presence"><code>POST /presence</code></a> (${price('presence')}) fetches
your live 402, reads the payTo and resource it declares, and checks the full Bazaar catalog,
the x402scan explorer, and Base transfer activity in one report — per-surface verdicts of
<code>listed</code>, <code>not_found</code>, or <code>unknown</code> with the evidence
attached. A surface it cannot read is reported <code>unknown</code>, never guessed. Pair it
with <a href="/#offer-lint"><code>POST /lint</code></a> (${price('lint')}) when a
<code>not_found</code> needs explaining: coverage tells you where you stand, the lint tells
you what is blocking.</p>
`,
  },
];
