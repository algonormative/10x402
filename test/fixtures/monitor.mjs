// The Parallax instrument fixtures — EXCERPTS OF REAL DATA, reassembled into
// each surface's live wire shape.
//
// Opposite discipline to envelopes.mjs, and deliberately so. Those fixtures are
// constructed, because each one has to isolate exactly one lint failure. These
// are captured, because what they are testing is a PARSE OF SOMEBODY ELSE'S
// SURFACE, and a constructed fixture would only ever prove that the parser
// agrees with whoever wrote the fixture. Every row below is a verbatim row from
// the 2026-08-27 first-party captures held in tradewind `raw/datasets/`:
//
//   2026-08-27--agenteconomy-ratings.ndjson         1,194 services
//   2026-08-27--apistrust-host-census.ndjson        2,005 hosts
//   2026-08-27--cdp-bazaar-resource-quality.ndjson  14,732 resources
//
// Six hosts are carried, chosen to cover the shapes the substrate has to get
// right rather than to be a representative sample:
//
//   socialx402.com   THE WRONGED HOST. Rated D at uptime 0.0 while settling
//                    $173.76, POST-declared, and apistrust reads it s=100
//                    down=0 in the same week. Probed 2026-08-27: POST 402,
//                    GET 405. This one row is the entire thesis of the wing.
//   agents.chain.link  Wronged and settling ($278.07, uptime 0.0), but NOT a
//                    contradiction — apistrust saw it down=1, so the two
//                    instruments agree. Separates the two flags in tests.
//   stabletravel.dev THE HEALTHY GET-DECLARED HOST. Uptime 1.0, tier A,
//                    probed GET 402 / POST 405 — the verb runs the other way.
//   api.onesource.io CAPTIVE-flagged: 14,565 unique payers against 70 organic
//                    ones. A flag string that is neither null nor 'NEW'.
//   10x402.com       The house. Rated D at uptime 0.0 with all five of its
//                    Bazaar rows declaring POST, while apistrust reads it
//                    s=100 down=0. The wing found its own case first.
//   0x07cf5359…2396  AN UNLISTED WALLET ROW. The rater files 234 bare `0x…`
//                    addresses under `host`; this one settled $500.90. It is
//                    real, it is counted, and it must never reach a probe.
//
// ------------------------------------------------------------------ THE SHAPE ASSUMPTION
//
// READ THIS BEFORE TRUSTING ratingsDocument() AS A MODEL OF THE LIVE SURFACE.
//
// The tradewind capture is NDJSON: line 1 is `{"_meta": {…}}` carrying `as_of`,
// `count`, `distribution`, `aei`, `api`, `license`, `scale` and `trust_line`,
// and every later line is one service object. The LIVE endpoint serves ONE
// JSON DOCUMENT (1,613,180 bytes), not NDJSON — so the capture's `_meta`
// wrapper is a capture-script artifact, not the served shape. The same `_meta`
// wrapper appears on all three tradewind captures, including the Bazaar one
// where it holds pure provenance (`endpoint`, `projection`, `fields_dropped`)
// that no server ever sent, which is what makes it legible as the script's
// doing rather than the surface's.
//
// So: the meta keys are verified, the row fields are verified, and THE KEY THE
// ROW ARRAY HANGS ON IS NOT. This fixture assumes `services`, which is the most
// likely spelling and lets the document carry its meta at the top level exactly
// as the capture recorded it. Because that one thing is an assumption about a
// third-party surface — which is precisely the class of mistake this repo
// exists to catch in other people's code — worker/monitor.js's `ratingsRows`
// accepts a bare array, `services`, `ratings`, `rows`, `data`, `items`, AND as
// a last resort the first top-level array whose members carry a string `host`.
// A shape matching none of those is a NAMED FAILURE, never a silent zero.
// bareArrayDocument() and metaWrappedDocument() below exercise the other two
// spellings so the defence is tested and not merely written down.

// ------------------------------------------------------------------ the rows, verbatim

/** agenteconomy.report rows, exactly as captured 2026-08-27. */
export const AE_ROWS = [
  {
    above_trust_line: false,
    as_of: '2026-08-27',
    centrality: 0.132,
    flag: null,
    host: 'socialx402.com',
    organic_paying_agents: 49,
    outlook: 'negative',
    paying_wallets_raw: 64,
    score: 0.0,
    settled_usd_14d: 173.76,
    tier: 'D',
    uptime: 0.0,
  },
  {
    above_trust_line: false,
    as_of: '2026-08-27',
    centrality: 0.0,
    flag: null,
    host: 'agents.chain.link',
    organic_paying_agents: 0,
    outlook: 'stable',
    paying_wallets_raw: 2,
    score: 0.0,
    settled_usd_14d: 278.07,
    tier: 'D',
    uptime: 0.0,
  },
  {
    above_trust_line: true,
    as_of: '2026-08-27',
    centrality: 0.032,
    flag: null,
    host: 'stabletravel.dev',
    organic_paying_agents: 26,
    outlook: 'negative',
    paying_wallets_raw: 33,
    score: 45.4,
    settled_usd_14d: 73.68,
    tier: 'A',
    uptime: 1.0,
  },
  {
    above_trust_line: false,
    as_of: '2026-08-27',
    centrality: 0.087,
    flag: 'CAPTIVE',
    host: 'api.onesource.io',
    organic_paying_agents: 70,
    outlook: 'positive',
    paying_wallets_raw: 956,
    score: 52.4,
    settled_usd_14d: 56.67,
    tier: 'BB',
    uptime: 1.0,
  },
  {
    above_trust_line: false,
    as_of: '2026-08-27',
    centrality: 0.015,
    flag: 'NEW',
    host: '10x402.com',
    organic_paying_agents: 5,
    outlook: 'positive',
    paying_wallets_raw: 5,
    score: 0.0,
    settled_usd_14d: 1.33,
    tier: 'D',
    uptime: 0.0,
  },
  {
    above_trust_line: false,
    as_of: '2026-08-27',
    centrality: 0.0,
    flag: 'UNLISTED',
    host: '0x07cf5359edb7d8de42973562c54e4c8d583c2396',
    organic_paying_agents: 0,
    outlook: 'new',
    paying_wallets_raw: 19,
    score: 22.1,
    settled_usd_14d: 500.9,
    tier: 'B',
    uptime: 0.0,
  },
];

/** The document's meta block, verbatim from the capture's `_meta`. */
export const AE_META = {
  aei: { as_of: '2026-08-27', change_7d_pct: 34.3, d7_usd: 8693.81, value: 1230.56 },
  api: {
    history: 'https://agenteconomy.report/api/rating/<host>/history',
    history_price_usd: 0.02,
    note: 'per-service endpoints for agents: pay per call in USDC on Base, no key, no signup',
    price_usd: 0.005,
    protocol: 'x402',
    rating: 'https://agenteconomy.report/api/rating/<host>',
  },
  as_of: '2026-08-27',
  count: 1194,
  distribution: { A: 3, AA: 2, AAA: 1, B: 262, BB: 87, BBB: 14, C: 90, CC: 119, CCC: 286, D: 330 },
  license: 'CC BY 4.0 — cite agenteconomy.report',
  scale: ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC', 'CC', 'C', 'D'],
  trust_line: 'BBB',
};

/**
 * The ASSUMED live shape: meta at the top level, rows under `services`.
 * `count` is left at the real 1,194 rather than lowered to 6 on purpose — the
 * rater's own count and our parsed count are meant to be comparable, and a
 * fixture that quietly agreed with itself would not prove they are kept apart.
 */
export const ratingsDocument = (rows = AE_ROWS) => ({ ...AE_META, services: rows });

/** The same population as a bare array — the second shape the parser accepts. */
export const bareArrayDocument = (rows = AE_ROWS) => [...rows];

/** The tradewind capture's own spelling: meta hoisted under `_meta`. */
export const metaWrappedDocument = (rows = AE_ROWS) => ({ _meta: AE_META, services: rows });

// ------------------------------------------------------------------ apistrust

/** apistrust.com host-table rows, exactly as captured 2026-08-27. */
export const AT_ROWS = [
  { down: 0, e: 1, h: 'socialx402.com', min: 100, price: 0, s: 100 },
  { down: 1, e: 3, h: 'agents.chain.link', min: 0, price: 0, s: 67 },
  { down: 0, e: 62, h: 'stabletravel.dev', min: 95, price: 0, s: 100 },
  { down: 0, e: 25, h: 'api.onesource.io', min: 100, price: 0, s: 100 },
  { down: 0, e: 4, h: '10x402.com', min: 100, price: 0, s: 100 },
  { down: 0, e: 7, h: '01mind.net', min: 100, price: 0, s: 100 },
  { down: 0, e: 70, h: 'vaaya.ai', min: 91, price: 0, s: 99 },
  { down: 1, e: 97, h: '2s.io', min: 70, price: 48, s: 85 },
  { down: 0, e: 1, h: '146-190-76-192.sslip.io', min: 100, price: 0, s: 100 },
  { down: 0, e: 1, h: '2s-3cpr6qm6j-alleyford.vercel.app', min: 100, price: 0, s: 100 },
];

/**
 * The table as the page actually serves it: embedded in HTML, inside a script
 * tag, beside DECOYS. Two of them, and both are the reason the extractor takes
 * the LARGEST parseable array rather than the first:
 *
 *   a nav array that appears BEFORE the table and also has objects in it
 *   a chart series that appears AFTER it
 *
 * A first-match extractor passes on a page with neither and fails on the real
 * one. The `[` inside a row VALUE ("min ]score[") is here for the same reason:
 * a bracket counter that does not honour string literals closes the array 200
 * rows early and reports a plausible, wrong table.
 */
export function apistrustPage(rows = AT_ROWS) {
  const decoyNav = [
    { label: 'Hosts', href: '/' },
    { label: 'Endpoints', href: '/endpoints' },
    { label: 'Method', href: '/method' },
  ];
  const decoySeries = [
    { t: '2026-08-20', listed: 24520 },
    { t: '2026-08-27', listed: 23234 },
  ];
  const withBracketInAString = rows.map((r, i) =>
    i === 0 ? { ...r, note: 'score [as served] — brackets ] and [ inside a value' } : r
  );
  return [
    '<!doctype html><html><head><title>ApisTrust — x402 host census</title></head><body>',
    '<h1>2,005 hosts</h1>',
    `<script>window.__nav = ${JSON.stringify(decoyNav)};</script>`,
    '<div id="table"></div>',
    `<script type="application/json" id="hosts">${JSON.stringify(withBracketInAString)}</script>`,
    `<script>window.__series = ${JSON.stringify(decoySeries)};</script>`,
    '</body></html>',
  ].join('\n');
}

// ------------------------------------------------------------------ the Bazaar

/**
 * Catalogue resources, back in the API's own row shape.
 *
 * The tradewind capture PROJECTED these — its `_meta.fields_dropped` names
 * `accepts`, `extensions`, `description` and `x402Version` — so the quality
 * block and the `accepts[0].outputSchema.input.method` wrapper are rebuilt here
 * around verbatim values. The declared verbs are not guesses: they are what the
 * same day's two-verb probe measured (`2026-08-27--parallax-two-verb-probe`) —
 * socialx402.com answers 402 on POST and 405 on GET, stabletravel.dev answers
 * 402 on GET and 405 on POST, and all five house rows declare POST.
 *
 * Two resources are carried for socialx402.com and 10x402.com so the
 * one-row-per-host reduction has something to actually choose between.
 */
const resource = ({ url, calls, payers, lastCalled, method }) => ({
  resource: url,
  type: 'http',
  x402Version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      payTo: '0x0000000000000000000000000000000000000002',
      outputSchema: { input: { type: 'http', method, discoverable: true } },
    },
  ],
  quality: {
    l30DaysTotalCalls: calls,
    l30DaysUniquePayers: payers,
    lastCalledAt: lastCalled,
  },
});

export const BAZAAR_ITEMS = [
  // socialx402.com — the older row FIRST, so "most recently called wins" is a
  // real choice and not an artifact of arrival order.
  resource({
    url: 'https://socialx402.com/api/sc/tiktok/song/videos',
    calls: 1,
    payers: 1,
    lastCalled: '2026-07-30T04:04:03.370Z',
    method: 'POST',
  }),
  resource({
    url: 'https://socialx402.com/api/sc/facebook/adLibrary/company/ads',
    calls: 2,
    payers: 1,
    lastCalled: '2026-08-21T05:19:03.972Z',
    method: 'POST',
  }),
  resource({
    url: 'https://agents.chain.link/v1/operations/:operationId/submit',
    calls: 16069,
    payers: 1,
    lastCalled: '2026-08-27T06:12:10.678Z',
    method: 'POST',
  }),
  resource({
    url: 'https://stabletravel.dev/api/seats-aero/availability',
    calls: 1646,
    payers: 2,
    lastCalled: '2026-08-27T04:10:52.359Z',
    method: 'GET',
  }),
  resource({
    url: 'https://api.onesource.io/api/chain/block-number',
    calls: 1127,
    payers: 910,
    lastCalled: '2026-08-25T22:00:57.927Z',
    method: 'GET',
  }),
  resource({
    url: 'https://10x402.com/presence',
    calls: 2,
    payers: 1,
    lastCalled: '2026-08-27T02:38:02.518Z',
    method: 'POST',
  }),
  resource({
    url: 'https://10x402.com/lint/one',
    calls: 4,
    payers: 3,
    lastCalled: '2026-08-27T03:22:07.269Z',
    method: 'POST',
  }),
  // vaaya.ai is in the catalogue and in apistrust but NOT in the AE excerpt —
  // the union-membership case, and the reason readings are a union.
  resource({
    url: 'https://vaaya.ai/api/run/courtlistener/dockets',
    calls: 3,
    payers: 3,
    lastCalled: '2026-08-26T17:31:53.966Z',
    method: 'POST',
  }),
  // NO quality block at all: 60 of 14,732 rows carried only `lastCalledAt`, and
  // some carry nothing. The columns must go NULL, not zero.
  {
    resource: 'https://aura.adex.network/api/aura/portfolio',
    type: 'http',
    accepts: [{ outputSchema: { input: { type: 'http' } } }],
  },
  // A row whose `resource` is not a URL. The catalogue has held these; it must
  // be dropped rather than throw the whole page away.
  { resource: 'not-a-url', type: 'http', accepts: [] },
];

/** The catalogue's paged response envelope, exactly as presence.js reads it. */
export const bazaarPage = (items, { limit, offset, total }) => ({
  items,
  pagination: { limit, offset, total },
});
