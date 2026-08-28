// Parallax — the monitoring wing's SUBSTRATE. Everything here runs in cron and
// writes D1; nothing here is ever reached from the request path.
//
// The lint answers "is your x402 implementation correct?" once. The monitor
// answers "are you alive, on the verb you declared, and what do the rating
// surfaces say about you?" every day, with the history kept. See MONITOR.md.
//
// ------------------------------------------------------------------ why three instruments
//
// Because they disagree, and the disagreement is the product. The x402 seller
// economy is read through three free surfaces:
//
//   ae      agenteconomy.report/s/ratings.json — a rater's whole table, free,
//           CC BY 4.0, per service tier/score/uptime/settlement/flag.
//   at      apistrust.com — a second prober's host table, embedded in the
//           served HTML as a JSON array.
//   bazaar  the CDP discovery catalogue's per-row quality block — calls,
//           unique payers and last-called-at, written by the facilitator that
//           SETTLES the payments rather than by an outside prober.
//
// Measured 2026-08-27: liveness correlates at r = 0.401 across 773 shared
// hosts, and 127 hosts read entirely dead at one instrument and entirely
// healthy at the other. The verified mechanism is that the prime rater probes
// GET-only, so every POST-declared seller reads uptime 0.0 and is rated D —
// 260/960 hosts, 249 of them settling money. This module captures all three,
// joins them per host, and then goes and asks the endpoint itself, on the verb
// it declared. That last step is the one nobody else takes.
//
// ------------------------------------------------------------------ the two-phase day row
//
// `monitor_days.wrongly_dead` is "ae_uptime = 0 AND the declared-verb probe
// answered 402" — and the two halves of that are measured by DIFFERENT CRONS
// half an hour apart. It CANNOT be computed at capture time, so capture writes
// it NULL and the probe cron UPDATEs it. Capture's day-row write therefore
// touches only its own columns (population, captured_*, contradictions) and
// the probe cron's touches only its own (roster_size, wrongly_dead); neither
// clobbers the other, which is what makes a re-run of either safe. NULL in
// that column means "not probed yet", never "none found".
//
// ------------------------------------------------------------------ invariants
//
//   NEVER SEND X-PAYMENT. Never pay. A prober that pays is buying the answer
//   it is reporting, and every seller it touches would be right to call it a
//   customer rather than a monitor. Asserted in test/monitor-substrate.test.mjs.
//   NEVER PROBE A MUTATING VERB — see PROBE_VERBS below.
//   EVERY PROBE URL PASSES checkTargetUrl. Catalogue rows are third-party
//   input; a host can write any resource URL it likes into the Bazaar by
//   settling one payment against it, so the SSRF discipline is identical to
//   the lint fetch's.
//   A FAILED INSTRUMENT NEVER BLOCKS THE OTHERS. Its columns go NULL and its
//   captured_* flag goes 0. Not seeing a surface is not a fact about a seller.
//   BOTH CRONS ARE IDEMPOTENT PER UTC DAY. Re-running one replaces that day's
//   rows; it never duplicates them and never doubles a count.

import { bazaarBase } from './presence.js';
import { checkTargetUrl, unsafeTargetsAllowed } from './fetch-target.js';
import { PAYMENT_REQUIRED_HEADER } from './envelope.js';
import { utcDay } from './quota.js';

// Env-overridable bases: production defaults, mock servers in tests — the same
// seam presence.js uses, for the same reason. Tests never touch the live
// instruments (house rule), so the base URL is where the suite gets in.
export const aeBase = (env) => String(env?.MONITOR_AE_BASE || 'https://agenteconomy.report');
export const atBase = (env) => String(env?.MONITOR_AT_BASE || 'https://apistrust.com');

/**
 * The UA every outbound call in this module carries, verbatim.
 *
 * It names the product and links a page that explains what the probe is, so an
 * operator reading their access log can find out who we are in one click
 * instead of filing us under "unattributed scanner". Sellers on this rail are
 * probed by 25+ raters daily; being the legible one is cheap and is the whole
 * of our politeness budget.
 */
export const MONITOR_UA = '10x402-monitor/0.1 (+https://10x402.com/monitor)';

/** MONITOR.md's schedules. Exported so wrangler.toml cannot drift from them
 *  unnoticed — test/monitor-substrate.test.mjs reads the TOML and compares. */
export const CAPTURE_CRON = '17 */6 * * *';
export const PROBE_CRON = '47 */6 * * *';

const PROBE_TIMEOUT_MS = 10_000; // MONITOR.md
// The ratings file was 1.6 MB at last read and the catalogue is ~16 pages, so
// the instrument reads get a longer rope than a probe does.
const INSTRUMENT_TIMEOUT_MS = 20_000;

/** At most this much of a probed body is read. The evidence in it is a single
 *  JSON key; nothing past the first few hundred bytes has ever mattered. */
const PROBE_BODY_BYTES = 4096;

/**
 * The cap on an instrument read.
 *
 * The threat model here is NOT the lint's: these bases are operator config, not
 * caller input, so nobody rents our network position by naming one. What the
 * cap buys is that a surface which starts answering with a firehose fails the
 * cron loudly instead of taking the isolate out — and a cron that fails has no
 * caller waiting on it. 32 MB is ~20x the largest instrument observed.
 */
const INSTRUMENT_BODY_BYTES = 32 * 1024 * 1024;

const BAZAAR_PAGE = 1000;
// Mirrors presence.js: a runaway pager (registry bug, a moved endpoint
// answering 200 with something else) must not spin forever. Generous against
// the ~15 pages actually observed, and hitting it is reported as a failed
// capture rather than as a completed one.
const BAZAAR_MAX_PAGES = 64;

/** Default roster cap. Workers' paid plan allows 1000 subrequests per
 *  invocation and a probe costs at most two, so 400 leaves real margin. */
const DEFAULT_PROBE_CAP = 400;

/**
 * Workers allow SIX simultaneous outbound connections per invocation. More
 * in-flight probes than that do not go faster, they queue — and a wider fan-out
 * at a stranger's host would be rude besides.
 */
const PROBE_CONCURRENCY = 6;

/**
 * THE ONLY TWO VERBS THIS SERVICE WILL EVER SEND.
 *
 * A catalogue row declares its own verb and we honour it — that is the entire
 * point of the instrument — but honouring `DELETE` would mean issuing a delete
 * against a stranger's endpoint because a row in a third-party catalogue said
 * so. POST is in because the whole rail is POST-declared paid endpoints and an
 * unpaid POST `{}` gets the 402 before any work happens (the same argument
 * fetch-target.js makes for /lint, and the same empty body). PUT, PATCH and
 * DELETE are not, and a row declaring one gets its declared probe SKIPPED
 * (declared_status NULL) with only the GET half run.
 */
const PROBE_VERBS = new Set(['GET', 'POST']);

/**
 * The timeout, in ms, for one outbound call. Env-tunable so the suite can prove
 * the timeout PATH in under a second instead of ten, clamped at both ends so a
 * bad value cannot turn a bounded wait into an unbounded one — the same
 * discipline as fetch-target.js's timeoutMs, kept on its own var so that tuning
 * the lint's timeout does not silently retune the monitor's.
 */
export function monitorTimeoutMs(env, fallback = PROBE_TIMEOUT_MS) {
  const raw = Number(env?.MONITOR_TIMEOUT_MS ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(60_000, Math.max(200, Math.floor(raw)));
}

/** The roster ceiling. Clamped so a typo cannot ask for 100k subrequests. */
export function probeCap(env) {
  const raw = Number(env?.MONITOR_PROBE_CAP ?? DEFAULT_PROBE_CAP);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_PROBE_CAP;
  return Math.min(900, Math.floor(raw));
}

/**
 * The hosts that get probed whatever else is true — ours.
 *
 * 10x402.com is hardcoded rather than configured because the day this service
 * stops watching its own liveness is the day it is selling a reading it does
 * not take of itself. MONITOR_HOUSE_HOSTS adds the rest of the estate.
 */
export function houseHosts(env) {
  const extra = String(env?.MONITOR_HOUSE_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(['10x402.com', ...extra])];
}

// ------------------------------------------------------------------ small shared parts

/**
 * A number, or NULL — and the gap between those is the whole reason this is
 * three lines rather than `Number(v)`.
 *
 * `Number(null)`, `Number('')`, `Number([])` and `Number(false)` are all 0, so
 * the obvious spelling turns "this instrument did not report a value" into
 * "this instrument reported zero". Downstream those are opposite claims: a NULL
 * bz_calls_30d means the catalogue's quality block was absent (60 of 14,732
 * rows), while a 0 means the endpoint took no calls in thirty days — and one of
 * those is a finding a seller would dispute. Only an actual number, or a
 * non-empty string that parses as one, comes back as a number.
 */
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const int = (v) => {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
};
const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * Does this string name a HOST, or is it a wallet address the rater filed
 * under `host` because it had no hostname to file it under?
 *
 * 234 of the rater's 1,194 rows on 2026-08-27 were bare `0x…` addresses
 * carrying the `UNLISTED` flag — real rated services with real settlement, and
 * not somewhere anything can be probed. They stay in `monitor_readings`
 * (excluding them would understate the population, and their money is real)
 * and they are excluded from the roster, because "probe 0x07cf…" is not a
 * request that means anything.
 */
export const looksLikeHost = (host) =>
  typeof host === 'string' && host.includes('.') && !/^0x[0-9a-f]{40}$/i.test(host);

/**
 * Read at most `max` bytes of a body, then stop, on the SAME deadline the fetch
 * ran under — a target that answers its headers instantly and then dribbles
 * cannot outlive the timeout. Local rather than imported: fetch-target.js keeps
 * its copy private, and a probe's needs (4 KB, no truncation reporting) are not
 * the lint's (256 KB, truncation is a finding).
 */
async function readCapped(res, max, signal) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  const onAbort = () => reader.cancel().catch(() => {});
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > max) {
        chunks.push(value.subarray(0, max - size));
        size = max;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    /* a stream that died mid-read still yields what arrived */
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(joined);
}

/** One bounded GET of an instrument, returning its text or a named failure. */
async function readInstrument(url, env, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), monitorTimeoutMs(env, INSTRUMENT_TIMEOUT_MS));
  try {
    const res = await fetch(url, {
      headers: { accept, 'user-agent': MONITOR_UA },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        /* the status is the evidence */
      }
      return { ok: false, why: `answered ${res.status}` };
    }
    return { ok: true, text: await readCapped(res, INSTRUMENT_BODY_BYTES, controller.signal) };
  } catch (err) {
    return { ok: false, why: err?.name === 'AbortError' ? 'timed out' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ instrument 1: the rater

/**
 * The rows out of a ratings document, WHATEVER shape it is served in.
 *
 * THE SHAPE OF THIS SURFACE IS AN ASSUMPTION, and it is the kind of assumption
 * this repo exists to get right about other people, so it is not made once and
 * hoped over. What is verified: the file carries a population-meta block
 * (`as_of`, `count`, `distribution`, an `api` price card, `aei`, `license`,
 * `scale`, `trust_line`) and one object per service with `host`, `tier`,
 * `score`, `uptime`, `organic_paying_agents`, `paying_wallets_raw`,
 * `settled_usd_14d`, `centrality`, `flag`, `above_trust_line`, `outlook`,
 * `as_of`. What is NOT verified first-party by this repo is the KEY the array
 * hangs on. So four shapes parse:
 *
 *   [ {host…}, … ]                a bare array
 *   { services: [ … ], …meta }    the shape the fixture is built in
 *   { ratings|rows|data|items: }  the other plausible spellings
 *   { …, <anything>: [ {host…} ] } last resort: the first top-level array
 *                                  whose members carry a string `host`
 *
 * A shape that matches none of them is a FAILED capture with the reason named,
 * never a silent zero — an empty population would read downstream as "the
 * market vanished", which is a much worse lie than "we could not parse it".
 */
export function ratingsRows(doc) {
  if (Array.isArray(doc)) return doc;
  if (!doc || typeof doc !== 'object') return null;
  const isRowArray = (v) => Array.isArray(v) && v.some((r) => r && typeof r === 'object' && typeof r.host === 'string');
  for (const key of ['services', 'ratings', 'rows', 'data', 'items']) {
    if (isRowArray(doc[key])) return doc[key];
  }
  for (const value of Object.values(doc)) if (isRowArray(value)) return value;
  return null;
}

/**
 * The population meta, from the top level or from a `_meta` sub-object.
 *
 * `_meta` is how the frozen tradewind captures wrap it (their capture scripts
 * hoist the document's non-row keys into one object so the rest can be NDJSON),
 * and reading both spellings costs one line and removes a whole class of
 * "worked on the fixture, empty in production".
 */
export function ratingsMeta(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
  const meta = doc._meta && typeof doc._meta === 'object' ? doc._meta : {};
  return { ...doc, ...meta };
}

/** GET /s/ratings.json, parsed into normalised rows or a named failure. */
export async function captureAgenteconomy(env) {
  const read = await readInstrument(`${aeBase(env)}/s/ratings.json`, env, 'application/json');
  if (!read.ok) return { ok: false, why: `agenteconomy ${read.why}` };

  let doc;
  try {
    doc = JSON.parse(read.text);
  } catch {
    return { ok: false, why: 'agenteconomy served something that is not JSON' };
  }

  const raw = ratingsRows(doc);
  if (!raw) return { ok: false, why: 'agenteconomy JSON carried no recognisable array of service rows' };
  const meta = ratingsMeta(doc);

  const rows = [];
  for (const r of raw) {
    const host = str(r?.host)?.toLowerCase();
    if (!host) continue; // a row with no host is not a reading about anyone
    rows.push({
      host,
      tier: str(r?.tier),
      score: num(r?.score),
      uptime: num(r?.uptime),
      organic_paying_agents: int(r?.organic_paying_agents),
      paying_wallets_raw: int(r?.paying_wallets_raw),
      settled_usd_14d: num(r?.settled_usd_14d),
      centrality: num(r?.centrality),
      // null is a REAL value here (667 of 1,194 rows carry it) and means
      // "unflagged", so it is preserved rather than defaulted to a string.
      flag: str(r?.flag),
      above_trust_line: r?.above_trust_line === true,
      outlook: str(r?.outlook),
      as_of: str(r?.as_of) ?? str(meta.as_of),
    });
  }

  return {
    ok: true,
    rows,
    as_of: str(meta.as_of),
    // The rater's OWN count, kept beside ours: if they disagree, our parse
    // dropped rows and the day row's population is understated.
    count: int(meta.count),
    distribution: meta.distribution && typeof meta.distribution === 'object' ? meta.distribution : null,
    // The incumbent's price card, published inside its own file: $0.005 a
    // rating read, $0.02 a history. It is what /monitor/verdict is priced
    // against, so it is captured rather than remembered.
    api: meta.api && typeof meta.api === 'object' ? meta.api : null,
  };
}

// ------------------------------------------------------------------ instrument 2: the second prober

/**
 * Pull the biggest JSON array-of-objects out of a served HTML page.
 *
 * apistrust serves its whole 2,005-host table inside the page — no API, no
 * key — as a JSON array. WHERE in the page is not a contract: today it is
 * script-tag payload, tomorrow it could be a data attribute or a hydration
 * blob, and a regex tuned to today's markup would break silently on a Tuesday.
 * So this brackets-matches instead: from every `[` that is followed by a `{`,
 * walk forward counting depth with string literals and their escapes honoured,
 * try to parse what comes back, and keep the LARGEST array whose members look
 * like table rows. The largest is the table; the small ones are nav menus and
 * chart series.
 *
 * KNOWN LIMIT, stated rather than implied: an array delivered as an ESCAPED
 * STRING inside another JSON document (the Next.js flight-payload shape) is not
 * matched, because the bytes between the brackets are not JSON. If that day
 * comes the capture fails with a reason rather than reporting an empty table.
 */
export function extractHostTable(html, { rowKey = 'h', maxAttempts = 400 } = {}) {
  const text = String(html || '');
  let best = null;
  let attempts = 0;

  for (let i = 0; i < text.length && attempts < maxAttempts; i++) {
    if (text[i] !== '[') continue;
    // Only `[` immediately followed (modulo whitespace) by `{` can start an
    // array of row objects, which keeps the attempt count near the number of
    // real candidates rather than near the number of brackets on the page.
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== '{') continue;
    attempts++;

    const end = matchBracket(text, i);
    if (end === -1) continue;
    let parsed;
    try {
      parsed = JSON.parse(text.slice(i, end + 1));
    } catch {
      continue;
    }
    if (Array.isArray(parsed) && parsed.some((r) => r && typeof r === 'object' && rowKey in r)) {
      if (!best || parsed.length > best.length) best = parsed;
      // Nothing nested inside a matched array can be bigger than it, so the
      // cursor jumps the whole region — without this a 2,005-row table would
      // be re-scanned from every row inside it.
      i = end;
    }
  }
  return best;
}

/** The index of the `]` closing the `[` at `start`, or -1. Strings and their
 *  backslash escapes are skipped so a `]` inside a value cannot close it. */
function matchBracket(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** GET /, then dig the host table out of the HTML. */
export async function captureApistrust(env) {
  const read = await readInstrument(`${atBase(env)}/`, env, 'text/html,application/json');
  if (!read.ok) return { ok: false, why: `apistrust ${read.why}` };

  const table = extractHostTable(read.text);
  if (!table) return { ok: false, why: 'apistrust page carried no readable host table' };

  const rows = [];
  for (const r of table) {
    const host = str(r?.h)?.toLowerCase();
    if (!host) continue;
    rows.push({
      host,
      score: num(r?.s),
      endpoints: int(r?.e),
      min_score: num(r?.min),
      down: int(r?.down),
      price_findings: int(r?.price),
    });
  }
  return { ok: true, rows };
}

// ------------------------------------------------------------------ instrument 3: the catalogue

/**
 * The full-catalogue Bazaar scan, reduced to one row per host.
 *
 * A STANDALONE PAGER RATHER THAN presence.js's. That module's `observeBazaar`
 * takes a target URL set and a payTo set and returns identity matches — the
 * loop is inseparable from the matching, and threading a second mode through it
 * would make the paid /presence path carry code only a cron uses. What IS
 * shared is the thing that must not drift: `bazaarBase(env)`, imported, so both
 * readers point at the same base and the same test seam.
 *
 * Pages are fetched SEQUENTIALLY, as there: the reads are cheap, the total is
 * bounded, and a polite client of a free public API does not fan out sixteen
 * concurrent requests at it.
 */
export async function captureBazaar(env) {
  const byHost = new Map();
  let total = null;
  let resources = 0;

  for (let page = 0; page < BAZAAR_MAX_PAGES; page++) {
    const offset = page * BAZAAR_PAGE;
    const read = await readInstrument(
      `${bazaarBase(env)}/platform/v2/x402/discovery/resources?limit=${BAZAAR_PAGE}&offset=${offset}`,
      env,
      'application/json'
    );
    if (!read.ok) return { ok: false, why: `bazaar page at offset ${offset} ${read.why}` };

    let json;
    try {
      json = JSON.parse(read.text);
    } catch {
      return { ok: false, why: `bazaar page at offset ${offset} was not JSON` };
    }
    const { items, pagination } = json || {};
    if (!Array.isArray(items) || !pagination) return { ok: false, why: 'bazaar page had an unexpected shape' };
    total = int(pagination.total);

    for (const item of items) {
      const row = bazaarRow(item);
      if (!row) continue;
      resources++;
      const held = byHost.get(row.host);
      if (!held || moreRecent(row, held)) byHost.set(row.host, row);
    }

    if (total === null || offset + BAZAAR_PAGE >= total) {
      return { ok: true, total, resources, rows: [...byHost.values()] };
    }
  }
  return {
    ok: false,
    why: `bazaar reported more than ${BAZAAR_MAX_PAGES * BAZAAR_PAGE} records — scan bound hit, the capture would be partial`,
  };
}

/**
 * One catalogue item → the fields the monitor keeps, or null if it is not a
 * row about a host we could ever probe.
 *
 * The quality block is read from three places because the catalogue has moved
 * it before: `quality` is where it lives today (`l30DaysTotalCalls`,
 * `l30DaysUniquePayers`, `lastCalledAt`, on 14,672 of 14,732 rows measured
 * 2026-08-27), `metadata` is the other spelling seen in the wild, and the top
 * level is the last resort. Reading all three costs nothing and means a
 * relocation shows up as a schema note rather than as a market-wide zero.
 */
function bazaarRow(item) {
  const resource = typeof item?.resource === 'string' ? item.resource : str(item?.resource?.url);
  if (!resource) return null;
  let host;
  try {
    host = new URL(resource).hostname.toLowerCase();
  } catch {
    return null; // a row whose resource is not a URL is not about a host
  }
  if (!host) return null;

  const q = (key) =>
    item?.quality?.[key] ?? item?.metadata?.[key] ?? item?.[key] ?? null;

  return {
    host,
    resource,
    calls_30d: int(q('l30DaysTotalCalls')),
    unique_payers_30d: int(q('l30DaysUniquePayers')),
    last_called_at: str(q('lastCalledAt')),
    // THE DECLARED VERB, and it is the whole reason this wing exists: the prime
    // rater probes GET-only, so a POST-declared seller reads dead at it. It
    // travels inside outputSchema.input, not one level up — the same place the
    // lint's V1_DISCOVERABLE check looks for `discoverable`. Absent defaults to
    // POST, which is what the overwhelming majority of the rail declares and
    // what an x402 client sends when told nothing.
    method: String(item?.accepts?.[0]?.outputSchema?.input?.method || 'POST').toUpperCase(),
  };
}

/** ISO-8601 timestamps sort lexically, so recency is a string compare. A row
 *  with no timestamp loses to one that has any; ties break on call volume. */
function moreRecent(a, b) {
  if (a.last_called_at && b.last_called_at) {
    if (a.last_called_at !== b.last_called_at) return a.last_called_at > b.last_called_at;
    return (a.calls_30d ?? 0) > (b.calls_30d ?? 0);
  }
  if (a.last_called_at) return true;
  if (b.last_called_at) return false;
  return (a.calls_30d ?? 0) > (b.calls_30d ?? 0);
}

// ------------------------------------------------------------------ the join

/**
 * Three captures → the day's `monitor_readings` rows and its `monitor_days`
 * meta row.
 *
 * PURE, and that is deliberate: the join is where every wrong number would come
 * from, so it is a function of its inputs and testable without a database, a
 * network or a clock.
 *
 * A HOST IN ANY INSTRUMENT GETS A ROW. Membership is a union, not an
 * intersection, because "present in one and absent from another" is the exact
 * finding this wing sells — 438 rated hosts were absent from the catalogue and
 * 847 catalogue hosts were unrated on 2026-08-27. An absent instrument leaves
 * its columns NULL, which reads as "not observed" and never as a zero.
 */
export function distill(day, { ae, at, bazaar }) {
  const rows = new Map();
  const row = (host) => {
    let r = rows.get(host);
    if (!r) {
      r = {
        day,
        host,
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
      };
      rows.set(host, r);
    }
    return r;
  };

  if (ae?.ok) {
    for (const r of ae.rows) {
      const t = row(r.host);
      t.ae_uptime = r.uptime;
      t.ae_score = r.score;
      t.ae_tier = r.tier;
      t.ae_settled_14d = r.settled_usd_14d;
      t.ae_organic = r.organic_paying_agents;
      t.ae_flag = r.flag;
    }
  }
  if (at?.ok) {
    for (const r of at.rows) {
      const t = row(r.host);
      t.at_score = r.score;
      t.at_down = r.down;
      t.at_endpoints = r.endpoints;
    }
  }
  if (bazaar?.ok) {
    for (const r of bazaar.rows) {
      const t = row(r.host);
      t.bz_calls_30d = r.calls_30d;
      t.bz_unique_payers = r.unique_payers_30d;
      t.bz_last_called = r.last_called_at;
      t.bz_resource = r.resource;
      t.bz_method = r.method;
    }
  }

  const readings = [...rows.values()];
  return {
    readings,
    day: {
      day,
      population: readings.length,
      captured_ae: ae?.ok ? 1 : 0,
      captured_at: at?.ok ? 1 : 0,
      captured_bazaar: bazaar?.ok ? 1 : 0,
      // Both NULL until the probe cron runs — see the two-phase note at the top.
      roster_size: null,
      wrongly_dead: null,
      contradictions: readings.filter(isContradiction).length,
    },
  };
}

/**
 * The liveness contradiction, computed identically wherever it is asked for:
 * one prober says the host answered nothing all window, the other says none of
 * its endpoints were ever down. Both instruments must be PRESENT — a NULL is
 * not a disagreement, it is an absence.
 */
export const isContradiction = (r) => r.ae_uptime === 0 && r.at_down === 0 && r.at_score !== null;

/** The capture-time half of wrongly-dead: dead at the rater, and taking money
 *  anyway. The probe supplies the other half (a declared-verb 402). */
export const isWronglyDeadCandidate = (r) => r.ae_uptime === 0 && (r.ae_settled_14d ?? 0) > 0;

// ------------------------------------------------------------------ the roster

/**
 * Which hosts today's probe cron actually visits, in MONITOR.md's priority
 * order. Only hosts with a catalogue resource are eligible — there is nothing
 * to probe without one — and only things that are hostnames (see looksLikeHost).
 *
 * The order is an argument about what the probe is FOR. The house first,
 * because a monitor that cannot see itself is not one. Then the hosts the
 * market is wrong about and where being wrong costs someone money. Then the
 * hosts where two instruments openly disagree. Then the biggest settlers,
 * because those readings are the ones most worth being right about. Then a
 * healthy fill, which is the control group — without it every probe we ever
 * take is of a host we already suspect, and the day's numbers would say
 * nothing about the population.
 *
 * `env` is optional and supplies MONITOR_HOUSE_HOSTS; without it the house is
 * just 10x402.com.
 */
export function deriveRoster(readings, cap, env) {
  const eligible = readings.filter((r) => r.bz_resource && looksLikeHost(r.host));
  const house = new Set(houseHosts(env));
  const settled = (r) => r.ae_settled_14d ?? 0;

  const tiers = [
    eligible.filter((r) => house.has(r.host)),
    eligible.filter(isWronglyDeadCandidate).sort((a, b) => settled(b) - settled(a)),
    eligible.filter(isContradiction).sort((a, b) => settled(b) - settled(a)),
    [...eligible].sort((a, b) => settled(b) - settled(a)),
    [...eligible].sort((a, b) => (b.bz_calls_30d ?? 0) - (a.bz_calls_30d ?? 0)),
  ];

  const seen = new Set();
  const roster = [];
  for (const tier of tiers) {
    for (const r of tier) {
      if (roster.length >= cap) return roster;
      if (seen.has(r.host)) continue;
      seen.add(r.host);
      roster.push(r);
    }
  }
  return roster;
}

// ------------------------------------------------------------------ the probe

/**
 * Ask one host's most-recently-called resource what it does, on the verb it
 * declared and on GET.
 *
 * WHAT IT NEVER SENDS: an X-PAYMENT header, a PAYMENT-SIGNATURE, a cookie, an
 * authorization. The point of the probe is to see what an UNPAID caller sees —
 * which is the same thing every rater on this rail sees, and the only reading
 * that can be compared against theirs. Sending a payment would also mean buying
 * the answer we then publish, which is not a monitor. `test/monitor-substrate`
 * asserts against the headers a mock actually received, not against this
 * comment.
 *
 * WHAT IT SENDS TWICE, AND WHY: an x402 seller declares one verb, and the prime
 * rater probes GET regardless. Taking both readings on the same resource in the
 * same second is what turns "these two raters disagree" into "here is the
 * mechanism" — and when the declared verb IS GET the two are the same request,
 * so it is made once and the one observation fills both column pairs.
 *
 * Statuses are honest about their provenance:
 *   402, 405, 200 …  what the host actually answered
 *   0                we asked and got no HTTP response at all — timeout, DNS,
 *                    TLS, refused connection. Not a status any server can
 *                    return, so it can never be mistaken for one. (curl spells
 *                    this `000`; the earlier hand-run census used that.)
 *   NULL             we never asked: the verb was not probeable, or the URL
 *                    failed the SSRF guard and no request was made.
 */
export async function probeHost(row, env) {
  const declaredMethod = String(row?.bz_method || 'POST').toUpperCase();
  const base = {
    host: row?.host ?? null,
    resource: row?.bz_resource ?? null,
    declared_method: declaredMethod,
    declared_status: null,
    declared_ms: null,
    get_status: null,
    get_ms: null,
    saw_v2_header: null,
    saw_v1_body: null,
  };

  // THE GUARD RUNS BEFORE ANY REQUEST, on the catalogue's URL rather than on
  // one we composed. A row in the CDP catalogue is written by whoever settled a
  // payment against it, which makes `bz_resource` third-party-controlled input
  // reaching a fetch — the exact shape /lint is hardened against, so it gets
  // the exact same guard, including the test-only relaxation seam.
  const checked = checkTargetUrl(row?.bz_resource, { unsafe: unsafeTargetsAllowed(env) });
  if (checked.error) return { ...base, refused: checked.error };

  const url = checked.url.href;
  const declared = PROBE_VERBS.has(declaredMethod) ? await probeOnce(url, declaredMethod, env) : null;
  // One request when the verbs coincide: the GET reading and the declared
  // reading are literally the same observation, and asking a stranger's
  // endpoint the identical question twice is noise in their logs and ours.
  const get = declaredMethod === 'GET' ? declared : await probeOnce(url, 'GET', env);

  return {
    ...base,
    declared_status: declared ? declared.status : null,
    declared_ms: declared ? declared.ms : null,
    get_status: get ? get.status : null,
    get_ms: get ? get.ms : null,
    // Both v2 and v1 evidence come from the DECLARED-verb response, because the
    // claim they support is "this endpoint is a working x402 seller on the verb
    // it published". A GET-only reading of a POST endpoint is the wrong
    // reading — that is the whole finding.
    saw_v2_header: declared ? (declared.sawV2 ? 1 : 0) : null,
    saw_v1_body: declared ? (declared.sawV1 ? 1 : 0) : null,
  };
}

/** One request, bounded, unauthenticated, unfollowed. */
async function probeOnce(url, method, env) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), monitorTimeoutMs(env));
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      // MANUAL: a 302 would carry the probe to a host that never passed the
      // guard, and the redirect is itself a fact about the endpoint.
      redirect: 'manual',
      headers: {
        accept: 'application/json, */*',
        'user-agent': MONITOR_UA,
        // `{}` is the smallest body a JSON endpoint accepts and is never
        // mistaken for real work: a paid endpoint answers 402 without reading
        // it. Sent only on POST, and this module sends no other body-bearing
        // verb (see PROBE_VERBS).
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      body: method === 'POST' ? '{}' : undefined,
      signal: controller.signal,
    });
    const sawV2 = res.headers.get(PAYMENT_REQUIRED_HEADER) !== null;
    const text = await readCapped(res, PROBE_BODY_BYTES, controller.signal);
    let sawV1 = false;
    try {
      sawV1 = JSON.parse(text)?.x402Version !== undefined;
    } catch {
      /* a body that is not JSON simply is not v1 evidence */
    }
    return { status: res.status, ms: Date.now() - started, sawV2, sawV1 };
  } catch {
    // 0 = asked, no HTTP answer. See the status note on probeHost.
    return { status: 0, ms: Date.now() - started, sawV2: false, sawV1: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Run `work` over `items` with at most `limit` in flight. */
async function pooled(items, limit, work) {
  const out = [];
  let cursor = 0;
  const runner = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return out;
}

// ------------------------------------------------------------------ the crons

/** Chunked so one enormous batch cannot exceed a D1 statement limit. */
async function writeAll(db, statements, chunk = 100) {
  for (let i = 0; i < statements.length; i += chunk) {
    await db.batch(statements.slice(i, i + chunk));
  }
}

/**
 * The columns of one `monitor_readings` row, in one place.
 *
 * Exported because worker/monitor-surfaces.js SELECTs the same set on the
 * request path, and two hand-kept column lists over one table is a drift
 * waiting to happen — the kind that reads fine and silently serves a column
 * of nulls. Read-only for that consumer; the writes below are the only ones.
 */
export const READING_COLUMNS = [
  'day',
  'host',
  'ae_uptime',
  'ae_score',
  'ae_tier',
  'ae_settled_14d',
  'ae_organic',
  'ae_flag',
  'at_score',
  'at_down',
  'at_endpoints',
  'bz_calls_30d',
  'bz_unique_payers',
  'bz_last_called',
  'bz_resource',
  'bz_method',
];

/**
 * 11:17 UTC — read the three instruments, join them, write the day.
 *
 * PARTIAL FAILURE IS A FIRST-CLASS OUTCOME, not an error path. The three reads
 * run in parallel and are settled independently: one that fails leaves its
 * columns NULL and its `captured_*` flag 0, and the other two are written
 * exactly as they would have been. A day with `captured_ae = 0` is a usable
 * day that says what it is missing.
 *
 * IDEMPOTENT: the day's readings are deleted and rewritten, so a re-run
 * converges on the same rows rather than doubling them, and a re-run over a
 * SHRUNKEN population leaves no orphans behind. The day row is upserted
 * touching only capture's own columns — the probe cron's live beside them.
 */
export async function runCaptureCron(env, { now = Date.now() } = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, why: 'no DB binding' };
  const day = utcDay(now);

  const settle = (p) => p.then((v) => v).catch((err) => ({ ok: false, why: `threw: ${err?.message || err}` }));
  const [ae, at, bazaar] = await Promise.all([
    settle(captureAgenteconomy(env)),
    settle(captureApistrust(env)),
    settle(captureBazaar(env)),
  ]);

  const { readings, day: meta } = distill(day, { ae, at, bazaar });

  const placeholders = READING_COLUMNS.map((_, i) => `?${i + 1}`).join(', ');
  const insert = db.prepare(
    `INSERT INTO monitor_readings (${READING_COLUMNS.join(', ')}) VALUES (${placeholders})`
  );

  await db.prepare('DELETE FROM monitor_readings WHERE day = ?1').bind(day).run();
  await writeAll(
    db,
    readings.map((r) => insert.bind(...READING_COLUMNS.map((c) => r[c])))
  );

  await db
    .prepare(
      'INSERT INTO monitor_days (day, population, captured_ae, captured_at, captured_bazaar, contradictions) ' +
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6) ' +
        'ON CONFLICT(day) DO UPDATE SET population = ?2, captured_ae = ?3, captured_at = ?4, ' +
        'captured_bazaar = ?5, contradictions = ?6'
    )
    .bind(day, meta.population, meta.captured_ae, meta.captured_at, meta.captured_bazaar, meta.contradictions)
    .run();

  return {
    ok: true,
    day,
    written: readings.length,
    captured: { ae: meta.captured_ae, at: meta.captured_at, bazaar: meta.captured_bazaar },
    // The reasons travel out for the cron log; nothing about them is stored.
    why: [ae.ok ? null : ae.why, at.ok ? null : at.why, bazaar.ok ? null : bazaar.why].filter(Boolean),
  };
}

/**
 * 11:47 UTC — derive the roster from the day's readings and go ask.
 *
 * Thirty minutes after capture, which is slack rather than coincidence: the
 * catalogue scan is ~16 sequential pages and the probe cron needs the readings
 * it produces to be in the table already.
 *
 * A HOST WHOSE URL FAILS THE GUARD IS DROPPED, not recorded as a dead endpoint.
 * Refusing to probe something is a fact about us, and writing it into the
 * probes table would put it in a column the surfaces read as a fact about them.
 * The count comes back for the log.
 *
 * IDEMPOTENT the same way capture is, and it fills the two-phase day row:
 * `roster_size` and `wrongly_dead` are written HERE, by an update that leaves
 * capture's columns alone.
 */
export async function runProbeCron(env, { now = Date.now() } = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, why: 'no DB binding' };
  const day = utcDay(now);

  const { results } = await db
    .prepare(`SELECT ${READING_COLUMNS.join(', ')} FROM monitor_readings WHERE day = ?1`)
    .bind(day)
    .all();
  const readings = results || [];
  if (readings.length === 0) return { ok: false, why: `no readings captured for ${day}`, day };

  const roster = deriveRoster(readings, probeCap(env), env);
  const probed = await pooled(roster, PROBE_CONCURRENCY, (r) => probeHost(r, env));
  const kept = probed.filter((p) => !p.refused);
  const refused = probed.length - kept.length;

  const ts = Math.floor(now / 1000);
  const insert = db.prepare(
    'INSERT INTO monitor_probes (day, host, ts, declared_method, declared_status, declared_ms, ' +
      'get_status, get_ms, saw_v2_header, saw_v1_body) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)'
  );

  await db.prepare('DELETE FROM monitor_probes WHERE day = ?1').bind(day).run();
  await writeAll(
    db,
    kept.map((p) =>
      insert.bind(
        day,
        p.host,
        ts,
        p.declared_method,
        p.declared_status,
        p.declared_ms,
        p.get_status,
        p.get_ms,
        p.saw_v2_header,
        p.saw_v1_body
      )
    )
  );

  // The second half of wrongly-dead, now that there is a probe to read: dead at
  // the rater, and answering 402 — a live paid endpoint — on the verb it
  // declared. This is the number the wing exists to publish.
  const uptimeByHost = new Map(readings.map((r) => [r.host, r.ae_uptime]));
  const wronglyDead = kept.filter((p) => uptimeByHost.get(p.host) === 0 && p.declared_status === 402).length;

  await db
    .prepare(
      'INSERT INTO monitor_days (day, roster_size, wrongly_dead) VALUES (?1, ?2, ?3) ' +
        'ON CONFLICT(day) DO UPDATE SET roster_size = ?2, wrongly_dead = ?3'
    )
    .bind(day, kept.length, wronglyDead)
    .run();

  return { ok: true, day, roster: roster.length, probed: kept.length, refused, wrongly_dead: wronglyDead };
}
