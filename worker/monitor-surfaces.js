// Parallax's SURFACES: everything the monitoring wing serves to a caller.
//
// worker/monitor.js is the substrate — it fetches, it probes, it writes, and it
// only ever runs in cron. This file is its opposite number: it READS D1 and
// nothing else. NO OUTBOUND FETCH HAPPENS ON THIS PATH, ever, for two reasons
// that are both load-bearing. A paid call must not depend on three third-party
// surfaces being up at the moment someone buys a verdict; and a request that
// went and asked would be selling a fresh reading under a stored day's
// `as_of` stamp, which is the one thing a dispute pack may not do.
//
//   GET  /monitor          free   the wing index: the latest day, the counts,
//                                 the contradictions that cost the most money.
//   GET  /monitor/{host}   free   the one-screen human moment: three
//                                 instruments side by side, the probe, the flags.
//   POST /monitor/verdict  $0.005 the latest stored reading + probe + flags,
//                                 as_of-stamped, with staleness stated.
//   POST /monitor/history  $0.03  every day held for one host.
//   POST /monitor/receipt  $0.12  the dispute pack: the series, the
//                                 cross-instrument contradiction statement, a
//                                 SHA-256 over the canonical JSON, and an
//                                 attestation naming the method and the UA.
//
// ------------------------------------------------------------------ NULL IS NOT ZERO. ANYWHERE.
//
// This is the whole discipline of the file, so it is stated once, at the top,
// and then obeyed in every view below.
//
//   monitor_days.wrongly_dead   NULL between the 11:17 capture and the 11:47
//                               probe, and on any day the probe failed. It
//                               means "NOT PROBED YET". Rendering it as 0 would
//                               publish "nobody is wrongly dead" every single
//                               morning — a fresh false statement, daily, about
//                               the exact finding this wing sells.
//   probe.declared_status = 0   we ASKED and got no HTTP answer at all
//                               (timeout, DNS, TLS, refused). Not a status any
//                               server can return.
//   probe.declared_status NULL  we NEVER ASKED — the declared verb was not one
//                               this service will send.
//   saw_v2_header = 0           we looked at a declared-verb response and the
//                               PAYMENT-REQUIRED header was absent.
//   saw_v2_header NULL          there was no declared-verb response to look at.
//   any ae_/at_/bz_ column NULL that instrument had no row for this host that
//                               day. A finding about the instrument, never a
//                               zero about the host.
//
// Every one of those states gets its own rendering in JSON and in HTML. A
// reader must never have to work out which of two opposite claims a 0 is.
//
// ------------------------------------------------------------------ third-party text
//
// `bz_resource`, `host`, `ae_tier`, `ae_flag` and `bz_method` are
// THIRD-PARTY-CONTROLLED TEXT: a seller writes any catalogue URL it likes by
// settling one payment against it, and that row reaches the HTML page below.
// So every interpolation goes through esc(), in attribute and text position
// alike, and no third-party string is ever placed in a URL this service
// fetches — because this path fetches nothing at all.

import {
  CAPTURE_CRON,
  MONITOR_UA,
  PROBE_CRON,
  READING_COLUMNS,
  isContradiction,
  isWronglyDeadCandidate,
  looksLikeHost,
  probeCap,
} from './monitor.js';
import { ENDPOINTS, SERVICE_NAME, SITE_BASE, priceLabel } from './catalog.js';
import { MONITOR_CONTROL } from './monitor-control.js';
import { sha256HexSync } from './sha256.js';
import { utcDay } from './quota.js';

/**
 * How old a stored probe may be before the verdict says so, in hours.
 *
 * 36 rather than 24: the probe runs once a day at 11:47 UTC, so a perfectly
 * healthy reading is up to 24 h old by the time the next one lands, and a bound
 * at 24 would flag every second caller. 36 is one missed cron — the first
 * moment something is actually wrong.
 */
export const STALE_AFTER_HOURS = 36;

/** How many contradictions the free index lists. Enough to read, not a dump. */
const TOP_CONTRADICTIONS = 10;

/**
 * The runaway bound on one host's series. Ten years of daily rows.
 *
 * Taken from the NEWEST end (`ORDER BY day DESC LIMIT`, then reversed), because
 * a bound that silently dropped the most recent days would answer "what is
 * happening to this host" with ancient history and no sign it had done so.
 */
const MAX_SERIES_DAYS = 3660;

/**
 * The reading columns for a SELECT — read LAZILY, and that is not a style tic.
 *
 * THIS MODULE IS IN AN IMPORT CYCLE and cannot touch a monitor.js binding while
 * modules are still initialising. The cycle is real and wanted:
 *
 *   envelope.js → monitor-surfaces.js → monitor.js → envelope.js
 *
 * envelope.js needs this module for the published sample; this module needs
 * monitor.js's predicates (`isContradiction`, `isWronglyDeadCandidate`,
 * `looksLikeHost`, `READING_COLUMNS`) because a second definition of any of
 * them is a number that can disagree with the one the cron wrote; monitor.js
 * needs envelope.js for the PAYMENT-REQUIRED header name.
 *
 * ES modules tolerate that as long as every cross-edge is touched at CALL time,
 * never at EVALUATION time. `const X = READING_COLUMNS.join()` at module level
 * is an evaluation-time touch, and it threw
 * `ReferenceError: Cannot access 'READING_COLUMNS' before initialization` for
 * exactly one entry order — a test importing worker/monitor.js FIRST — while
 * the Worker itself, which happens to reach catalog.js and envelope.js first,
 * started fine. An import-order-dependent startup crash is the worst shape a
 * bug can have, so nothing here reads across the cycle until it is called.
 */
const selectReading = () => READING_COLUMNS.join(', ');

/**
 * The probe columns, spelled here rather than imported.
 *
 * worker/monitor.js writes them from an inline INSERT with no shared list to
 * export, and inventing one there to import here would edit the cron path for
 * a read path's convenience. A name that drifts fails loudly — SQLite refuses
 * an unknown column — and test/monitor-surfaces.test.mjs reads every one of
 * them back out of a seeded row.
 */
const SELECT_PROBE =
  'day, host, ts, declared_method, declared_status, declared_ms, get_status, get_ms, saw_v2_header, saw_v1_body';

/**
 * The monitor's own rows in the price sheet, in sheet order.
 *
 * A function for the reason above: catalog.js is not in the cycle today, but a
 * module-level filter over an imported array is the same evaluation-time touch
 * that broke, and this file is not the place to keep a second one alive.
 */
const monitorEndpoints = () => ENDPOINTS.filter((e) => e.kind === 'monitor');

// ------------------------------------------------------------------ input

/** A bare wallet address, which the rater files under `host` for 234 of its rows. */
const WALLET_KEY = /^0x[0-9a-f]{40}$/i;

/** What a hostname may contain once it is normalised. Deliberately narrow. */
const HOST_CHARS = /^[a-z0-9.-]+$/;

const ROSTER_CRITERIA =
  'A host is held here if it appeared in any of the three instruments on a capture day: ' +
  'agenteconomy.report\'s ratings table, apistrust.com\'s host table, or the CDP Bazaar ' +
  'discovery catalogue. It is PROBED — the other half — only if it also carries a catalogue ' +
  `resource and made that day's roster, which is capped and ordered: the house, then hosts ` +
  'rated dead while settling money, then cross-instrument liveness contradictions, then the ' +
  'largest settlers, then a healthy control sample.';

/**
 * The `{host}` field, normalised — or a refusal that says what would work.
 *
 * TWO KINDS OF SUBJECT ARE ACCEPTED, and the difference travels in the answer.
 * A hostname is probeable. A bare `0x…` wallet key is NOT: the rater files 234
 * of its rows under one (real rated services, real settlement, no hostname to
 * ask anything of), they are genuinely in `monitor_readings`, and refusing to
 * answer about them would be refusing to answer about $500 of settled volume
 * that the rater itself publishes. So they are queryable, they return the
 * readings half, and the payload says in its own words that there is nothing
 * there to probe — rather than returning a probe-shaped hole with no
 * explanation.
 *
 * A URL is accepted and reduced to its hostname. Agents hold URLs, not hosts,
 * and answering "that is not a hostname" to `https://socialx402.com/api/x` is a
 * refusal about punctuation.
 */
export function monitorSubject(raw) {
  const refusal = (error) => ({
    error,
    fix:
      'POST {"host": "socialx402.com"} — one hostname, or the https URL of an endpoint (its host ' +
      'is taken). A bare 0x… wallet address is also accepted, because the rating instrument files ' +
      'some of its rows under one; those carry readings and can never carry a probe.',
  });

  if (typeof raw !== 'string' || !raw.trim()) {
    return refusal('`host` is required — the hostname this wing has been watching');
  }

  let host = raw.trim();
  if (/^https?:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return refusal(`\`host\` looks like a URL but does not parse as one: ${clip(raw)}`);
    }
  }
  host = host.replace(/\.$/, '').toLowerCase(); // one trailing root dot forgiven

  if (WALLET_KEY.test(host)) return { host, kind: 'wallet_key', probeable: false };
  if (host.length > 253) return refusal('`host` is longer than a DNS name may be (253 characters)');
  if (!HOST_CHARS.test(host) || !looksLikeHost(host)) {
    return refusal(`\`host\` is not a hostname: ${clip(raw)}`);
  }
  return { host, kind: 'host', probeable: true };
}

/** Caller-supplied text, bounded before it is echoed into a message. */
const clip = (value) => {
  const text = String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

/** The answer for a subject this wing holds no row for. A 400 that teaches. */
const notHeld = (subject) => ({
  error: `no readings are held for ${subject.host}`,
  fix:
    `${ROSTER_CRITERIA} If ${subject.host} is a live x402 seller and is in none of the three, ` +
    'the fastest way in is a settled call against a declared resource — POST /presence reports ' +
    'which registries can see it today, and POST /lint reports what is blocking the listing.',
});

// ------------------------------------------------------------------ small views
//
// One vocabulary, used by the free pages and by all three paid endpoints, so a
// buyer who reads the free host page and then buys a verdict is reading the
// same words about the same columns.

/** SQL NULL and a missing column both mean "not observed" and read as null. */
const nz = (v) => (v === undefined ? null : v);

/** Two decimals at most, and never `0.30000000000000004`. */
const round = (n, places = 2) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/**
 * Uptime, always with a decimal point on it.
 *
 * `0` and `0.0` are the same number and not the same sentence: the finding this
 * wing sells is spoken as "rated at uptime 0.0", and a bare `0` in a column of
 * scores reads as a rounding artefact rather than as the claim it is.
 */
const uptimeText = (n) => (Number.isInteger(Number(n)) ? Number(n).toFixed(1) : String(round(Number(n), 3)));

const iso = (unixSeconds) =>
  Number.isFinite(unixSeconds) ? new Date(unixSeconds * 1000).toISOString() : null;

/**
 * One probe status, with its provenance attached.
 *
 * The three states are the reason this is a function and not a number in the
 * payload: 402 is an answer, 0 is a silence we measured, and NULL is a question
 * we never asked. Two of those are facts about the host and one is a fact about
 * us, and a caller must never have to guess which.
 */
function statusView(code, ms) {
  const latency = nz(ms);
  if (nz(code) === null) {
    return {
      asked: false,
      answered: null,
      status: null,
      latency_ms: null,
      reads: 'not asked — the verb this row declares is not one this service will send',
    };
  }
  if (Number(code) === 0) {
    return {
      asked: true,
      answered: false,
      status: null,
      latency_ms: latency,
      reads: 'asked, and got no HTTP answer at all — a timeout, DNS, TLS, or a refused connection',
    };
  }
  return {
    asked: true,
    answered: true,
    status: Number(code),
    latency_ms: latency,
    reads:
      `answered ${Number(code)}` +
      (latency === null ? ' (latency not recorded)' : ` in ${latency} ms`),
  };
}

/** 1 / 0 / NULL — looked and found, looked and absent, never looked. */
function evidenceView(value, what) {
  if (nz(value) === null) {
    return { seen: null, reads: `no declared-verb response to look at, so ${what} was never inspected` };
  }
  const seen = Number(value) === 1;
  return { seen, reads: seen ? `${what} was present` : `${what} was absent from the response` };
}

/** Did this instrument have anything at all to say about this host that day? */
const observed = (reading, keys) => keys.some((k) => nz(reading[k]) !== null);

/**
 * The three instruments, side by side, in one shape.
 *
 * `observed: false` is the whole reason each one is an object rather than a
 * flat set of columns: 438 rated hosts were absent from the catalogue and 847
 * catalogue hosts were unrated on 2026-08-27, and "absent from this table" and
 * "present, reading zero" are the two claims this wing exists to keep apart.
 */
export function instrumentViews(reading) {
  const ae = observed(reading, ['ae_uptime', 'ae_score', 'ae_tier', 'ae_settled_14d', 'ae_organic', 'ae_flag']);
  const at = observed(reading, ['at_score', 'at_down', 'at_endpoints']);
  const bz = observed(reading, ['bz_calls_30d', 'bz_unique_payers', 'bz_last_called', 'bz_resource', 'bz_method']);

  const aeParts = [];
  if (nz(reading.ae_uptime) !== null) {
    aeParts.push(`uptime ${uptimeText(reading.ae_uptime)}${Number(reading.ae_uptime) === 0 ? ' — dead at this instrument' : ''}`);
  }
  if (nz(reading.ae_score) !== null) aeParts.push(`score ${round(Number(reading.ae_score), 1)}`);
  if (nz(reading.ae_tier) !== null) aeParts.push(`tier ${reading.ae_tier}`);
  if (nz(reading.ae_settled_14d) !== null) aeParts.push(`$${round(Number(reading.ae_settled_14d))} settled over 14 days`);
  if (nz(reading.ae_organic) !== null) aeParts.push(`${reading.ae_organic} organic paying agents`);
  if (nz(reading.ae_flag) !== null) aeParts.push(`flagged ${reading.ae_flag}`);

  const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;

  const atParts = [];
  if (nz(reading.at_score) !== null) atParts.push(`score ${round(Number(reading.at_score), 1)}`);
  if (nz(reading.at_down) !== null) {
    atParts.push(
      nz(reading.at_endpoints) !== null
        ? `${reading.at_down} of ${plural(reading.at_endpoints, 'endpoint')} down`
        : `${plural(reading.at_down, 'endpoint')} down`
    );
  }

  const bzParts = [];
  if (nz(reading.bz_calls_30d) !== null) bzParts.push(`${plural(reading.bz_calls_30d, 'call')} in 30 days`);
  if (nz(reading.bz_unique_payers) !== null) bzParts.push(`${plural(reading.bz_unique_payers, 'unique payer')}`);
  if (nz(reading.bz_last_called) !== null) bzParts.push(`last called ${reading.bz_last_called}`);
  if (nz(reading.bz_method) !== null) bzParts.push(`declares ${reading.bz_method}`);

  const absent = (name) => `not in ${name} on this day — which is a fact about that table, not a zero about this host`;

  return {
    agenteconomy: {
      source: 'agenteconomy.report/s/ratings.json (CC BY 4.0)',
      observed: ae,
      uptime: nz(reading.ae_uptime),
      score: nz(reading.ae_score),
      tier: nz(reading.ae_tier),
      settled_usd_14d: nz(reading.ae_settled_14d),
      organic_paying_agents: nz(reading.ae_organic),
      flag: nz(reading.ae_flag),
      reads: ae ? aeParts.join(', ') : absent('the ratings table'),
    },
    apistrust: {
      source: 'apistrust.com host table',
      observed: at,
      score: nz(reading.at_score),
      endpoints: nz(reading.at_endpoints),
      endpoints_down: nz(reading.at_down),
      reads: at ? atParts.join(', ') : absent('the host table'),
    },
    bazaar: {
      source: 'CDP Bazaar discovery catalogue, per-resource quality block',
      observed: bz,
      calls_30d: nz(reading.bz_calls_30d),
      unique_payers_30d: nz(reading.bz_unique_payers),
      last_called_at: nz(reading.bz_last_called),
      resource: nz(reading.bz_resource),
      declared_method: nz(reading.bz_method),
      reads: bz ? bzParts.join(', ') : absent('the catalogue'),
    },
  };
}

/** The probe half, or an explicit absence with the reason for it. */
export function probeView(probe, { probeable = true, hasResource = true } = {}) {
  if (!probe) {
    return {
      ran: false,
      at: null,
      ts: null,
      declared_method: null,
      declared: null,
      get: null,
      evidence: null,
      // WHY it did not run, because "no probe" has three different causes and
      // only one of them says anything about the host.
      reads: !probeable
        ? 'Not probed, and never will be: this subject is a wallet address the rating instrument ' +
          'files under `host`, not a hostname anything can be asked of.'
        : !hasResource
          ? 'Not probed: no catalogue resource is held for this host, so there is no URL to ask.'
          : 'Not probed on this day — this host was not on the day\'s roster, or the probe cron has ' +
            'not run yet (it runs half an hour after the capture).',
    };
  }

  const declared = statusView(probe.declared_status, probe.declared_ms);
  const get = statusView(probe.get_status, probe.get_ms);
  const method = nz(probe.declared_method) ?? 'POST';

  return {
    ran: true,
    ts: nz(probe.ts),
    at: iso(Number(probe.ts)),
    declared_method: method,
    declared,
    get,
    evidence: {
      payment_required_header: evidenceView(probe.saw_v2_header, 'the x402 v2 PAYMENT-REQUIRED header'),
      v1_body_x402version: evidenceView(probe.saw_v1_body, 'an x402 v1 body carrying x402Version'),
      // Kept to one line because it rides in every entry of a series that grows
      // by one a day; the argument behind it is in the endpoint's own notes.
      note: 'Both are read from the DECLARED-verb response — a GET-only reading of a POST endpoint is the wrong reading.',
    },
    reads:
      `on ${method}, its declared verb, it ${declared.reads}; on GET it ${get.reads}` +
      (declared.status === 402 && get.status !== 402
        ? ' — which is exactly the shape a GET-only rater records as dead'
        : ''),
  };
}

/**
 * The read-time flags. COMPUTED, NEVER STORED — and computed by importing the
 * substrate's own predicates rather than by restating them, so the number the
 * probe cron wrote into `monitor_days.wrongly_dead` and the flag on a host page
 * can never come from two different definitions.
 */
export function flagsFor(reading, probe) {
  const flags = [];

  if (isContradiction(reading)) {
    flags.push({
      id: 'liveness-contradiction',
      statement:
        `agenteconomy.report recorded uptime ${uptimeText(reading.ae_uptime)} for this host ` +
        `while apistrust.com recorded ${reading.at_down} of its endpoints down. Both instruments ` +
        'reported; they disagree about whether this host is alive.',
    });
  }

  const declared = probe ? nz(probe.declared_status) : null;
  const confirmedDead = Number(reading.ae_uptime) === 0 && nz(reading.ae_uptime) !== null && declared === 402;

  if (confirmedDead) {
    flags.push({
      id: 'wrongly-dead',
      statement:
        `Rated at uptime 0.0 — and it answered 402, a live paid x402 endpoint, to an unpaid ` +
        `${nz(probe.declared_method) ?? 'POST'} on the resource its own catalogue row declares. ` +
        'The rating and the endpoint disagree, and the endpoint was asked directly.',
    });
  } else if (isWronglyDeadCandidate(reading)) {
    flags.push({
      id: 'wrongly-dead-candidate',
      statement: probe
        ? `Rated at uptime 0.0 while settling $${round(Number(reading.ae_settled_14d))} over 14 days — ` +
          'but the probe did not find a 402 on the declared verb, so the second half of the claim is ' +
          'not established.'
        : `Rated at uptime 0.0 while settling $${round(Number(reading.ae_settled_14d))} over 14 days. ` +
          'CANDIDATE ONLY: confirming it needs the declared-verb probe, and none is stored for this ' +
          'day. This is not a finding yet.',
    });
  }

  return flags;
}

// ------------------------------------------------------------------ assemblers (pure)
//
// Every one of these is a function of rows and a clock. That is what lets the
// published envelope samples be a genuine run of this code over the frozen
// worker/monitor-control.js rows, with no D1 and no network at build time — the
// same discipline as assemblePresence and the lint samples.

/** One day of one host, in the shared vocabulary. */
export function daySnapshot({ day, reading, probe, probeable = true }) {
  const row = reading || { day };
  const hasResource = nz(row.bz_resource) !== null;
  return {
    day,
    state: probe ? 'probed' : 'readings-only',
    instruments: instrumentViews(row),
    probe: probeView(probe, { probeable, hasResource }),
    flags: reading ? flagsFor(reading, probe) : [],
  };
}

/**
 * How old the stored probe is, and whether the verdict is allowed to be read as
 * current.
 *
 * THE ONLY TIMESTAMP IN THE WHOLE WING IS `monitor_probes.ts`; `monitor_days`
 * and `monitor_readings` carry a UTC DATE and nothing finer. So staleness is
 * measured from the probe when there is one, and when there is not, the payload
 * says there is no timestamp to age rather than manufacturing one out of the
 * day string. The day distance is published beside it as what it is — a count
 * of calendar days, not an age.
 */
export function freshness({ day, probe, now }) {
  const today = utcDay(now);
  const daysBehind = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);

  if (!probe || nz(probe.ts) === null) {
    return {
      probed_at: null,
      probe_age_hours: null,
      stale: null,
      stale_after_hours: STALE_AFTER_HOURS,
      day,
      days_behind_utc_today: daysBehind,
      reads:
        `no probe is stored for ${day}, so there is no timestamp to age. This verdict is the ` +
        'instrument readings only, and the readings are that UTC day\'s — ' +
        (daysBehind <= 0 ? 'today\'s.' : `${daysBehind} day(s) behind today.`),
    };
  }

  const ageHours = round((now / 1000 - Number(probe.ts)) / 3600, 1);
  const stale = ageHours > STALE_AFTER_HOURS;
  return {
    probed_at: iso(Number(probe.ts)),
    probe_age_hours: ageHours,
    stale,
    stale_after_hours: STALE_AFTER_HOURS,
    day,
    days_behind_utc_today: daysBehind,
    reads: stale
      ? `STALE: the stored probe is ${ageHours} h old, past the ${STALE_AFTER_HOURS} h bound. The ` +
        'probe cron runs daily at 11:47 UTC, so this means a run was missed — read this as history, ' +
        'not as a current reading.'
      : `the stored probe is ${ageHours} h old, inside the ${STALE_AFTER_HOURS} h bound.`,
  };
}

/** POST /monitor/verdict — the latest day held, stamped and aged. */
export function assembleVerdict({ subject, day, reading, probe, now, lastProbedDay = null, roster = null }) {
  const snapshot = daySnapshot({ day, reading, probe, probeable: subject.probeable });
  const fresh = freshness({ day, probe, now });

  return {
    kind: 'monitor',
    endpoint: 'verdict',
    host: subject.host,
    subject_kind: subject.kind,
    probeable: subject.probeable,
    as_of: day,
    state: snapshot.state,
    freshness: fresh,
    instruments: snapshot.instruments,
    probe: snapshot.probe,
    flags: snapshot.flags,
    // Only when there is no probe on this day: what a buyer needs in order to
    // decide whether to wait, or to buy the history where a probe does exist.
    ...(snapshot.state === 'readings-only'
      ? {
          probe_absent: {
            last_probed_day: lastProbedDay,
            roster_cap: roster?.cap ?? null,
            population: roster?.population ?? null,
            reads:
              (lastProbedDay
                ? `the most recent day this host WAS probed is ${lastProbedDay}; POST /monitor/history ` +
                  `(${priceLabel(priceOf('monitor-history'))}) returns every day held, probes included. `
                : 'this host has never been probed. ') +
              (roster?.cap
                ? `Each day's roster is capped at ${roster.cap}${
                    roster.population ? ` out of a population of ${roster.population}` : ''
                  }, in priority order — the house, then hosts rated dead while settling, then ` +
                  'liveness contradictions, then the largest settlers, then a healthy control sample.'
                : ''),
          },
        }
      : {}),
    notes: [
      'Every number here is a STORED observation of a public surface, re-served. Nothing was ' +
        'fetched to answer this call, so the `as_of` day is the truth about when it was measured.',
      'NULL and 0 are different claims throughout: a NULL instrument column means that instrument ' +
        'had no row for this host that day, a 0 means it reported zero, and a probe status of 0 ' +
        'means it was asked and answered nothing at all.',
      'Flags are computed at read time from the stored rows, never stored. GET /monitor names the ' +
        'roster criteria in full, free.',
    ],
  };
}

/** POST /monitor/history — every day held for one host, oldest first. */
export function assembleHistory({ subject, series, now }) {
  const days = series.map((entry) =>
    daySnapshot({ day: entry.day, reading: entry.reading, probe: entry.probe, probeable: subject.probeable })
  );

  return {
    kind: 'monitor',
    endpoint: 'history',
    host: subject.host,
    subject_kind: subject.kind,
    probeable: subject.probeable,
    as_of: utcDay(now),
    state: 'series',
    days_held: days.length,
    first_day: days.length ? days[0].day : null,
    last_day: days.length ? days[days.length - 1].day : null,
    probed_days: days.filter((d) => d.probe.ran).length,
    series: days,
    notes: [
      'Ordered oldest first, one entry per UTC day this wing captured. A day missing from this ' +
        'series is a day the capture did not run or did not see this host — it is not a day the ' +
        'host was absent from the market.',
      'An entry with `state: "readings-only"` was captured but not probed: the roster is capped, ' +
        'and being off it says nothing about the host.',
    ],
  };
}

/**
 * POST /monitor/receipt — the artefact a seller attaches to a corrections
 * request.
 *
 * WHAT MAKES IT A RECEIPT rather than a pretty history: the contradiction is
 * STATED, in the numbers, so a human reading a support ticket does not have to
 * derive it; the attestation names the method and the exact User-Agent the
 * probe carried, so the rater can find our requests in their own logs and check
 * them; and the digest lets anyone re-derive the document's identity from its
 * own contents.
 *
 * THE DIGEST IS NOT A SIGNATURE and the payload says so. Signing with a real
 * key is deferred by owner decision (MONITOR.md, out of scope). What the digest
 * buys today is that two copies of this document can be compared in one line —
 * which is the failure mode a dispute actually has (a screenshot that has been
 * edited), not forgery of a $0.12 report.
 */
export function assembleReceipt({ subject, series, now }) {
  const history = assembleHistory({ subject, series, now });
  const days = history.series;

  const contradictionDays = days.filter((d) => d.flags.some((f) => f.id === 'liveness-contradiction'));
  const wronglyDeadDays = days.filter((d) => d.flags.some((f) => f.id === 'wrongly-dead'));
  const candidateDays = days.filter((d) => d.flags.some((f) => f.id === 'wrongly-dead-candidate'));

  const statements = [];
  if (contradictionDays.length) {
    const worst = contradictionDays[contradictionDays.length - 1];
    statements.push(
      `On ${contradictionDays.length} of the ${days.length} day(s) held, the two probing instruments ` +
        `disagreed about whether ${subject.host} was alive. Most recently, on ${worst.day}: ` +
        `agenteconomy.report recorded uptime ${uptimeText(worst.instruments.agenteconomy.uptime)}, while ` +
        `apistrust.com recorded ${worst.instruments.apistrust.endpoints_down} of ` +
        `${worst.instruments.apistrust.endpoints} endpoints down at score ` +
        `${worst.instruments.apistrust.score}.`
    );
  }
  if (wronglyDeadDays.length) {
    const worst = wronglyDeadDays[wronglyDeadDays.length - 1];
    statements.push(
      `On ${wronglyDeadDays.length} of those day(s) this service asked the endpoint directly and it ` +
        `answered 402 — a live paid x402 endpoint — to an unpaid ${worst.probe.declared_method} on ` +
        `${worst.instruments.bazaar.resource}, the resource its own catalogue row declares, while ` +
        `the same day's rating recorded it dead. On ${worst.day} the same resource answered ` +
        `${worst.probe.get.status ?? 'nothing'} to a GET, which is the reading a GET-only prober ` +
        'takes and files as downtime.'
    );
  }
  if (!wronglyDeadDays.length && candidateDays.length) {
    statements.push(
      `On ${candidateDays.length} day(s) this host was rated dead while settling money, but no ` +
        'declared-verb probe is stored for those days — so this pack carries the candidate, not the ' +
        'confirmed finding, and says so.'
    );
  }
  if (!statements.length) {
    statements.push(
      `No cross-instrument contradiction was recorded for ${subject.host} on any of the ` +
        `${days.length} day(s) held. That is a finding too, and it is the one this document reports.`
    );
  }

  const attestation = {
    method:
      'One unauthenticated HTTP request to the host\'s most-recently-called CDP Bazaar resource on ' +
      'the verb that catalogue row declares, and one on GET, taken seconds apart from a Cloudflare ' +
      'Worker. Redirects are not followed. At most 4 KB of each body is read.',
    user_agent: MONITOR_UA,
    no_payment:
      'NO PAYMENT WAS EVER SENT. No X-PAYMENT header, no PAYMENT-SIGNATURE, no cookie and no ' +
      'authorization accompanied any request in this document. Every status recorded here is what ' +
      'an unpaid caller sees — which is the only reading comparable with what the rating ' +
      'instruments publish, and the reason this service is a monitor rather than a customer.',
    schedule: { capture: CAPTURE_CRON, probe: PROBE_CRON, timezone: 'UTC' },
    statement:
      `Every probe in this document was made by ${SERVICE_NAME} from a Cloudflare Worker, ` +
      `identifying itself in every request as \`${MONITOR_UA}\` — searchable verbatim in the ` +
      'access log of the host it was made against. It sent one unauthenticated request on the verb ' +
      'the subject\'s own CDP Bazaar row declares and one on GET, followed no redirects, and read ' +
      'at most 4 KB of each response. NO PAYMENT WAS SENT ON ANY OF THEM: a prober that pays is ' +
      'buying the answer it publishes. Instruments are captured daily at ' +
      `${CAPTURE_CRON} UTC and probes taken at ${PROBE_CRON} UTC; the readings are re-served from ` +
      'storage, never re-fetched to answer a call.',
  };

  const body = {
    kind: 'monitor',
    endpoint: 'receipt',
    host: subject.host,
    subject_kind: subject.kind,
    probeable: subject.probeable,
    issued_at: new Date(now).toISOString(),
    as_of: history.as_of,
    state: 'receipt',
    days_held: history.days_held,
    first_day: history.first_day,
    last_day: history.last_day,
    probed_days: history.probed_days,
    contradiction: {
      days_held: days.length,
      days_in_contradiction: contradictionDays.length,
      days_wrongly_dead: wronglyDeadDays.length,
      days_wrongly_dead_candidate: candidateDays.length,
      statement: statements.join(' '),
    },
    series: history.series,
    attestation,
    verify:
      'Recompute: take this document, remove the `digest` member, serialise the remainder as ' +
      'canonical JSON (object keys sorted by code unit at every depth, array order preserved, no ' +
      'whitespace, UTF-8), and SHA-256 it. The hex digest must equal `digest.value`. This is an ' +
      'integrity check on the document, NOT a signature: it proves two copies are the same ' +
      'document, and it does not prove who issued it.',
    notes: history.notes,
  };

  return {
    ...body,
    digest: {
      algorithm: 'SHA-256',
      encoding: 'hex',
      over: 'every member of this document except `digest` itself',
      canonicalisation: 'object keys sorted at every depth, array order preserved, no whitespace, UTF-8',
      value: sha256HexSync(canonicalJson(body)),
    },
  };
}

/**
 * JSON with every object's keys sorted, at every depth, and no whitespace.
 *
 * A digest is worth nothing if the bytes it was taken over cannot be
 * reproduced, and JS object key order is insertion order — which depends on
 * which branch of the assembler ran. Sorting removes that dependency, so a
 * disputing seller can rebuild the exact bytes from the document they were
 * handed. `undefined` members are dropped exactly as JSON.stringify drops them.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

// ------------------------------------------------------------------ the free surfaces (pure halves)

/** The wing index payload, assembled from the day row and its counts. */
export function assembleIndex({ day, counts, contradictions, cap, now }) {
  const prices = monitorEndpoints().map((e) => ({
    method: e.method,
    path: e.path,
    price: priceLabel(e.price_usd),
    description: e.description,
    input: e.inputDescription,
  }));

  const what_this_is =
    'Three free instruments read the x402 seller economy, and they disagree about who is alive. ' +
    'This wing captures all three every day, then asks the endpoint itself — on the verb its own ' +
    'catalogue row declares, which is the question nobody else asks — and keeps the answer. ' +
    'Nothing here is fetched to answer a request: every surface re-serves what the crons stored.';

  if (!day) {
    return {
      service: SERVICE_NAME,
      wing: 'parallax',
      state: 'no-capture',
      what_this_is,
      as_of: null,
      counts: null,
      top_contradictions: [],
      endpoints: prices,
      free: freeRouteList(),
      notes: [
        'NO CAPTURE HAS BEEN STORED YET, so there is nothing to report. This is an empty state, ' +
          'not a claim that the market is empty: the capture cron runs daily at ' +
          `${CAPTURE_CRON} UTC and the probe at ${PROBE_CRON} UTC.`,
      ],
    };
  }

  const probed = nz(day.wrongly_dead) !== null;

  return {
    service: SERVICE_NAME,
    wing: 'parallax',
    state: probed ? 'probed' : 'captured',
    what_this_is,
    as_of: {
      day: day.day,
      captured: {
        agenteconomy: Number(day.captured_ae) === 1,
        apistrust: Number(day.captured_at) === 1,
        bazaar: Number(day.captured_bazaar) === 1,
      },
      // NULL until 11:47. Rendered as null, never as 0 — see the header note.
      roster_size: nz(day.roster_size),
      probe_has_run: probed,
    },
    counts: {
      population: nz(day.population),
      rows_held: counts.rows_held,
      wallet_keys: counts.wallet_keys,
      with_catalogue_resource: counts.with_resource,
      contradictions: nz(day.contradictions),
      // THE FIELD THIS WHOLE FILE IS CAREFUL ABOUT.
      wrongly_dead: nz(day.wrongly_dead),
      wrongly_dead_reads: probed
        ? `${day.wrongly_dead} host(s) rated at uptime 0.0 answered 402 to an unpaid request on the ` +
          'verb their own catalogue row declares.'
        : 'NOT PROBED YET. `wrongly_dead` is null, and null here means the probe half of the day has ' +
          `not run — it runs at ${PROBE_CRON} UTC, half an hour after the capture. It does NOT mean ` +
          'zero hosts were found wrongly dead.',
    },
    top_contradictions: contradictions,
    endpoints: prices,
    free: freeRouteList(),
    notes: [
      'A contradiction is: the rating instrument recorded uptime 0.0 for a host while the second ' +
        'prober recorded none of its endpoints down, with both instruments present. Computed at ' +
        'read time from the stored rows, never stored.',
      'Ordered by 14-day settled volume, because a wrong liveness reading costs most where money ' +
        'is actually moving.',
      `A day this wing did not capture is simply absent. Population is ${
        nz(day.population) === null ? 'unrecorded for this day' : `${day.population} hosts across the three instruments`
      }; the roster that gets probed is capped at ${cap}.`,
    ],
  };
}

/** The two free routes, described the same way in /check, /monitor and a 404. */
export const freeRouteList = () => [
  {
    method: 'GET',
    path: '/monitor',
    price: 'free',
    description:
      'The wing index: the latest capture day, the cross-instrument contradiction and wrongly-dead ' +
      'counts, and the contradictions carrying the most settled volume. JSON, or HTML with ' +
      'Accept: text/html.',
  },
  {
    method: 'GET',
    path: '/monitor/{host}',
    price: 'free',
    description:
      'One host, today: the three instruments side by side, the declared-verb and GET probe, and ' +
      'the read-time flags. No history — that is POST /monitor/history. JSON, or HTML with ' +
      'Accept: text/html.',
  },
];

/** The per-host free payload. Today only: history is what the paid route sells. */
export function assembleHostPage({ subject, day, reading, probe, roster, now }) {
  const snapshot = daySnapshot({ day, reading, probe, probeable: subject.probeable });
  const fresh = freshness({ day, probe, now });

  return {
    service: SERVICE_NAME,
    wing: 'parallax',
    host: subject.host,
    subject_kind: subject.kind,
    probeable: subject.probeable,
    as_of: day,
    state: snapshot.state,
    freshness: fresh,
    instruments: snapshot.instruments,
    probe: snapshot.probe,
    flags: snapshot.flags,
    ...(subject.probeable
      ? {}
      : {
          unprobeable: {
            reads:
              'This subject is a bare wallet address, not a hostname. The rating instrument files ' +
              '234 of its rows under one — real rated services with real settlement and no host to ' +
              'ask anything of. Its readings are here; there is no probe half and there never will ' +
              'be, and that is an absence rather than a silence from the endpoint.',
          },
        }),
    ...(snapshot.state === 'readings-only'
      ? {
          probe_absent: {
            roster_cap: roster?.cap ?? null,
            population: roster?.population ?? null,
            reads: snapshot.probe.reads,
          },
        }
      : {}),
    paid: monitorEndpoints().map((e) => ({
      method: e.method,
      path: e.path,
      price: priceLabel(e.price_usd),
      description: e.description,
    })),
    notes: [
      'This free page is today only, by design: the daily series is the product, and it is sold at ' +
        'POST /monitor/history.',
      'Nothing was fetched to build this page. Every value is a stored observation from the ' +
        `capture at ${CAPTURE_CRON} UTC and the probe at ${PROBE_CRON} UTC.`,
    ],
  };
}

const priceOf = (id) => ENDPOINTS.find((e) => e.id === id)?.price_usd ?? 0;

// ------------------------------------------------------------------ D1 (read-only, always)

/** The latest day the wing has a meta row for. */
async function latestDayRow(db) {
  return db
    .prepare(
      'SELECT day, population, captured_ae, captured_at, captured_bazaar, roster_size, wrongly_dead, ' +
        'contradictions FROM monitor_days ORDER BY day DESC LIMIT 1'
    )
    .first();
}

/**
 * The population split for one day.
 *
 * `instr(host, '.') = 0` is the SQL half of looksLikeHost's test — the bare
 * `0x…` rows are the ones with no dot in them. It is a prefilter for a COUNT,
 * not a verdict about any row: every row this file actually renders goes
 * through the exported predicate itself.
 */
async function dayCounts(db, day) {
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS rows_held, ' +
        "SUM(CASE WHEN instr(host, '.') = 0 THEN 1 ELSE 0 END) AS wallet_keys, " +
        'SUM(CASE WHEN bz_resource IS NOT NULL THEN 1 ELSE 0 END) AS with_resource ' +
        'FROM monitor_readings WHERE day = ?1'
    )
    .bind(day)
    .first();
  return {
    rows_held: Number(row?.rows_held ?? 0),
    wallet_keys: Number(row?.wallet_keys ?? 0),
    with_resource: Number(row?.with_resource ?? 0),
  };
}

/**
 * The day's contradictions, biggest settlers first, with their probes attached.
 *
 * The WHERE clause mirrors isContradiction so SQLite can do the work, and the
 * rows are then run through the imported predicate itself — the SQL is an
 * index-friendly prefilter and the JS is the definition. If they ever disagree,
 * the JS wins and the list is short by a row rather than wrong by one.
 */
async function topContradictions(db, day, limit) {
  const { results } = await db
    .prepare(
      `SELECT r.${READING_COLUMNS.join(', r.')}, ` +
        'p.ts AS p_ts, p.declared_method AS p_declared_method, p.declared_status AS p_declared_status, ' +
        'p.declared_ms AS p_declared_ms, p.get_status AS p_get_status, p.get_ms AS p_get_ms, ' +
        'p.saw_v2_header AS p_saw_v2_header, p.saw_v1_body AS p_saw_v1_body ' +
        'FROM monitor_readings r LEFT JOIN monitor_probes p ON p.day = r.day AND p.host = r.host ' +
        'WHERE r.day = ?1 AND r.ae_uptime = 0 AND r.at_down = 0 AND r.at_score IS NOT NULL ' +
        'ORDER BY r.ae_settled_14d DESC, r.bz_calls_30d DESC LIMIT ?2'
    )
    .bind(day, limit)
    .all();

  return (results || [])
    .filter(isContradiction)
    .map((row) => {
      const probe = nz(row.p_ts) === null
        ? null
        : {
            ts: row.p_ts,
            declared_method: row.p_declared_method,
            declared_status: row.p_declared_status,
            declared_ms: row.p_declared_ms,
            get_status: row.p_get_status,
            get_ms: row.p_get_ms,
            saw_v2_header: row.p_saw_v2_header,
            saw_v1_body: row.p_saw_v1_body,
          };
      return {
        host: row.host,
        settled_usd_14d: nz(row.ae_settled_14d),
        ae_uptime: nz(row.ae_uptime),
        ae_tier: nz(row.ae_tier),
        at_score: nz(row.at_score),
        at_endpoints_down: nz(row.at_down),
        bz_calls_30d: nz(row.bz_calls_30d),
        declared_method: nz(row.bz_method),
        probe: probeView(probe, { probeable: looksLikeHost(row.host), hasResource: nz(row.bz_resource) !== null }),
        flags: flagsFor(row, probe),
      };
    });
}

/**
 * Readings and probes → one entry per day, oldest first. PURE, because the
 * envelope sample runs it over the frozen control rows.
 */
export function mergeSeries(readings, probes) {
  const byDay = new Map();
  for (const reading of readings || []) {
    byDay.set(reading.day, { day: reading.day, reading, probe: null });
  }
  // A probe with no reading cannot happen today (the roster is derived from the
  // readings) and is carried as its own entry anyway: inventing a reading to
  // hang it on would be worse than an entry that says the readings are missing.
  for (const probe of probes || []) {
    const entry = byDay.get(probe.day);
    if (entry) entry.probe = probe;
    else byDay.set(probe.day, { day: probe.day, reading: null, probe });
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** Every day held for one host: readings and probes, merged, oldest first. */
async function seriesForHost(db, host) {
  const [readings, probes] = await Promise.all([
    db
      .prepare(`SELECT ${selectReading()} FROM monitor_readings WHERE host = ?1 ORDER BY day DESC LIMIT ?2`)
      .bind(host, MAX_SERIES_DAYS)
      .all(),
    db
      .prepare(`SELECT ${SELECT_PROBE} FROM monitor_probes WHERE host = ?1 ORDER BY day DESC LIMIT ?2`)
      .bind(host, MAX_SERIES_DAYS)
      .all(),
  ]);
  return mergeSeries(readings.results || [], probes.results || []);
}

/** The day-meta context a "not probed" answer needs to explain itself. */
async function rosterContext(db, day, env) {
  const row = await db.prepare('SELECT population, roster_size FROM monitor_days WHERE day = ?1').bind(day).first();
  return { cap: probeCap(env), population: nz(row?.population) ?? null, roster_size: nz(row?.roster_size) ?? null };
}

// ------------------------------------------------------------------ the paid routes

/**
 * The work dispatch for `kind: 'monitor'`, shaped like runPresence: it takes the
 * request body and the env, returns a report or an `{error, fix}` the Worker
 * turns into a 400 that charges nothing.
 *
 * D1 ONLY. If this function ever grows a fetch, the `as_of` stamp on everything
 * it returns becomes a lie.
 */
export async function runMonitorEndpoint(endpointId, body, env, { now = Date.now() } = {}) {
  const db = env?.DB;
  if (!db) {
    return {
      error: 'the monitor store is not available on this deployment',
      fix: 'This is ours to fix, not yours — nothing was charged. GET /check lists the routes that do not need it.',
    };
  }

  const subject = monitorSubject(body?.host);
  if (subject.error) return subject;

  const series = await seriesForHost(db, subject.host);
  if (!series.length) return notHeld(subject);

  if (endpointId === 'monitor-verdict') {
    const latest = series[series.length - 1];
    const lastProbed = [...series].reverse().find((entry) => entry.probe);
    return assembleVerdict({
      subject,
      day: latest.day,
      reading: latest.reading,
      probe: latest.probe,
      now,
      lastProbedDay: lastProbed ? lastProbed.day : null,
      roster: latest.probe ? null : await rosterContext(db, latest.day, env),
    });
  }
  if (endpointId === 'monitor-history') return assembleHistory({ subject, series, now });
  if (endpointId === 'monitor-receipt') return assembleReceipt({ subject, series, now });

  // Unreachable through the catalogue; loud rather than silent if it ever is.
  throw new Error(`no monitor endpoint "${endpointId}"`);
}

/**
 * The WORKED example each monitor endpoint publishes in its own 402 envelope.
 *
 * THE SAME ASSEMBLERS THE PAID CALL RUNS, over the frozen 2026-08-27 rows in
 * worker/monitor-control.js — including the input validation, so the sample is
 * also a demonstration that the published `{"host": …}` is one a caller could
 * send verbatim. No D1 and no network, because `sampleOutput()` is called while
 * a 402 response header is being built (worker/envelope.js) and neither is
 * available there. The clock is the control's frozen one, so the envelope this
 * Worker publishes is the same bytes today and next month.
 */
export function monitorSample(endpointId) {
  const subject = monitorSubject(MONITOR_CONTROL.readings[0].host);
  if (subject.error) throw new Error(`monitor control: ${subject.error}`);
  const series = mergeSeries(MONITOR_CONTROL.readings, MONITOR_CONTROL.probes);
  const now = MONITOR_CONTROL.now;

  if (endpointId === 'monitor-verdict') {
    const latest = series[series.length - 1];
    return assembleVerdict({
      subject,
      day: latest.day,
      reading: latest.reading,
      probe: latest.probe,
      now,
      lastProbedDay: latest.probe ? latest.day : null,
      roster: latest.probe
        ? null
        : { cap: MONITOR_CONTROL.day.roster_size, population: MONITOR_CONTROL.day.population },
    });
  }
  if (endpointId === 'monitor-history') return assembleHistory({ subject, series, now });
  if (endpointId === 'monitor-receipt') return assembleReceipt({ subject, series, now });
  throw new Error(`no monitor endpoint "${endpointId}"`);
}

// ------------------------------------------------------------------ the free routes

/**
 * GET /monitor. Returns the status alongside the payload so the caller renders
 * one shape in JSON and in HTML without deciding the status twice.
 */
export async function monitorIndexSurface(env, { now = Date.now() } = {}) {
  const db = env?.DB;
  if (!db) return { status: 503, payload: unavailable() };

  const day = await latestDayRow(db);
  if (!day) {
    return { status: 200, payload: assembleIndex({ day: null, counts: null, contradictions: [], cap: probeCap(env), now }) };
  }
  const [counts, contradictions] = await Promise.all([
    dayCounts(db, day.day),
    topContradictions(db, day.day, TOP_CONTRADICTIONS),
  ]);
  return {
    status: 200,
    payload: assembleIndex({ day, counts, contradictions, cap: probeCap(env), now }),
  };
}

/** GET /monitor/{host}. Three states, and a 404 that names the criteria. */
export async function monitorHostSurface(env, raw, { now = Date.now() } = {}) {
  const db = env?.DB;
  if (!db) return { status: 503, payload: unavailable() };

  const subject = monitorSubject(raw);
  if (subject.error) {
    return {
      status: 404,
      payload: {
        service: SERVICE_NAME,
        wing: 'parallax',
        state: 'unknown',
        host: clip(raw),
        ...subject,
        criteria: ROSTER_CRITERIA,
        free: freeRouteList(),
      },
    };
  }

  const series = await seriesForHost(db, subject.host);
  if (!series.length) {
    return {
      status: 404,
      payload: {
        service: SERVICE_NAME,
        wing: 'parallax',
        state: 'unknown',
        host: subject.host,
        error: `no readings are held for ${subject.host}`,
        // The criteria travel as their own field here rather than inside `fix`,
        // because on this route they are the answer: "why is my host not here"
        // is the question a 404 from this path actually gets asked.
        criteria: ROSTER_CRITERIA,
        fix:
          `If ${subject.host} is a live x402 seller and is in none of the three instruments, the ` +
          'fastest way in is a settled call against a declared resource — POST /presence reports ' +
          'which registries can see it today, and POST /lint reports what is blocking the listing.',
        free: freeRouteList(),
      },
    };
  }

  const latest = series[series.length - 1];
  return {
    status: 200,
    payload: assembleHostPage({
      subject,
      day: latest.day,
      reading: latest.reading,
      probe: latest.probe,
      roster: latest.probe ? null : await rosterContext(db, latest.day, env),
      now,
    }),
  };
}

const unavailable = () => ({
  service: SERVICE_NAME,
  wing: 'parallax',
  state: 'unavailable',
  error: 'the monitor store is not available on this deployment',
  fix: 'Nothing is stored to serve. This is ours to fix; GET /check lists everything that does not need it.',
});

// ------------------------------------------------------------------ HTML
//
// One page, two shapes, no script and no asset that has to load. The palette,
// the type scale and the two font families are the read surface's (build.mjs),
// so a person who lands here from the site does not feel handed off — the two
// woff2 files are the ones dist/ serves, addressed ABSOLUTELY (SITE_BASE)
// rather than same-origin: on 10x402.com the two are identical, but a local
// `wrangler dev` serves only the Worker — a relative /fonts/ path 404s there
// and every review of these pages happens on exactly that setup. The system stack
// behind them means the page is intact if they never arrive.
//
// EVERY INTERPOLATION IS ESCAPED. Some of these strings are written by the
// hosts being reported on.

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const CSS = `
@font-face { font-family: "Space Grotesk"; font-style: normal; font-weight: 400; font-display: swap; src: url("${SITE_BASE}/fonts/space-grotesk-latin-400-normal.woff2") format("woff2"); }
@font-face { font-family: "Space Grotesk"; font-style: normal; font-weight: 700; font-display: swap; src: url("${SITE_BASE}/fonts/space-grotesk-latin-700-normal.woff2") format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 400; font-display: swap; src: url("${SITE_BASE}/fonts/jetbrains-mono-latin-400-normal.woff2") format("woff2"); }
:root {
  color-scheme: dark;
  --ground: #0a0c12; --panel: #0e1420; --panel-2: #111a29;
  --rule: #1d2739; --rule-bright: #2a3a54;
  --fg: #e8edf6; --muted: #9fadc7; --dim: #7d8ca9;
  --sky: #7dd3fc; --blue: #38bdf8; --violet: #a78bfa; --coral: #fb7185;
  --sans: "Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --ramp: linear-gradient(90deg, var(--sky), var(--blue) 30%, var(--violet) 70%, var(--coral));
}
* { box-sizing: border-box; }
body { margin: 0; padding: 0 1.25rem 5rem; background: var(--ground); color: var(--fg); font: 16px/1.65 var(--sans); letter-spacing: -.004em; }
main { max-width: 64rem; margin: 0 auto; }
a { color: var(--sky); text-underline-offset: .18em; }
header.top { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding: 1.1rem 0; border-bottom: 1px solid var(--rule); margin-bottom: 2rem; }
.brand { font-family: var(--mono); font-weight: 700; text-decoration: none; color: var(--fg); }
.brand span { color: var(--dim); font-weight: 400; }
h1 { font-size: clamp(1.7rem, 4.6vw, 2.6rem); line-height: 1.1; letter-spacing: -.028em; margin: .4rem 0 .5rem; overflow-wrap: anywhere; }
h1 .host { font-family: var(--mono); color: var(--sky); }
h2 { position: relative; font-size: 1.15rem; letter-spacing: -.02em; margin: 2.6rem 0 .9rem; padding-top: 1.4rem; border-top: 1px solid var(--rule); }
h2::before { content: ""; position: absolute; top: -1px; left: 0; width: 4.5rem; height: 2px; background: var(--ramp); }
h3 { font-size: .95rem; margin: 0 0 .45rem; }
p { max-width: 46rem; color: var(--muted); }
p.lede { color: var(--fg); font-size: 1.03rem; }
code, .mono { font-family: var(--mono); font-size: .88em; overflow-wrap: anywhere; }
.stamp { font-family: var(--mono); font-size: .78rem; color: var(--dim); letter-spacing: .04em; }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; margin: 1.2rem 0; }
.card { padding: 1rem 1.1rem; border: 1px solid var(--rule); border-radius: 13px; background: var(--panel); }
.card .src { display: block; font-family: var(--mono); font-size: .66rem; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); margin-bottom: .5rem; overflow-wrap: anywhere; }
/* minmax(0, 1fr) and overflow-wrap together: a catalogue resource is a
   third-party URL of any length, and without both it pushes the card — and
   then the page — sideways on a phone. */
.card dl { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .18rem .7rem; font-size: .88rem; }
.card dt { color: var(--dim); white-space: nowrap; }
.card dd { margin: 0; min-width: 0; font-family: var(--mono); color: var(--fg); overflow-wrap: anywhere; }
.card .reads { margin: .7rem 0 0; font-size: .84rem; color: var(--muted); }
.absent { border-style: dashed; }
.absent .reads { color: var(--dim); }
.null { color: var(--dim); font-style: italic; }
.flag { display: block; padding: .8rem 1rem; margin: .6rem 0; border: 1px solid var(--rule-bright); border-left: 3px solid var(--violet); border-radius: 10px; background: var(--panel-2); }
.flag.wrong { border-left-color: var(--coral); }
.flag .id { display: inline-block; font: 700 .68rem/1.6 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--violet); }
.flag.wrong .id { color: var(--coral); }
.flag p { margin: .25rem 0 0; }
.none { padding: .8rem 1rem; border: 1px dashed var(--rule); border-radius: 10px; color: var(--dim); font-size: .9rem; }
.probe { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.status { font: 700 1.5rem/1 var(--mono); }
.status.ok { color: var(--sky); } .status.bad { color: var(--coral); } .status.none { color: var(--dim); font-size: 1rem; font-style: italic; }
.scroll { overflow-x: auto; border: 1px solid var(--rule); border-radius: 13px; background: var(--panel); }
table { border-collapse: collapse; width: 100%; font-size: .86rem; }
caption { text-align: left; padding: .7rem 1rem; border-bottom: 1px solid var(--rule); color: var(--dim); font: .68rem/1.5 var(--mono); letter-spacing: .08em; text-transform: uppercase; }
th, td { text-align: left; padding: .55rem 1rem; border-bottom: 1px solid rgba(29,39,57,.75); vertical-align: top; }
th { color: var(--dim); font: 700 .66rem/1.5 var(--mono); text-transform: uppercase; letter-spacing: .09em; }
td.n { font-family: var(--mono); white-space: nowrap; }
tbody tr:last-child td { border-bottom: none; }
/* A route is one token and reads as one: POST /monitor/{ho st} wrapped mid-path
   is a URL a reader would copy wrong. The table scrolls in its own box instead. */
.pricing td:first-child { font-family: var(--mono); white-space: nowrap; }
.price { font-family: var(--mono); color: var(--violet); white-space: nowrap; }
.pill { display: inline-block; padding: .12rem .5rem; border-radius: 999px; border: 1px solid var(--rule-bright); background: var(--panel-2); font: 700 .66rem/1.7 var(--mono); letter-spacing: .07em; text-transform: uppercase; color: var(--muted); }
.pill.warn { color: var(--violet); border-color: rgba(167,139,250,.4); }
.pill.stale { color: var(--coral); border-color: rgba(251,113,133,.4); }
footer { max-width: 64rem; margin: 3.5rem auto 0; padding-top: 1.3rem; border-top: 1px solid var(--rule); color: var(--dim); font-size: .84rem; }
@media (max-width: 54rem) { .grid, .probe { grid-template-columns: minmax(0, 1fr); } }
`;

const page = (title, description, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<style>${CSS}</style>
</head><body><main>
<header class="top"><a class="brand" href="${SITE_BASE}/">${esc(SERVICE_NAME)} <span>/ parallax</span></a>
<span class="stamp">three instruments · one probe · every day</span></header>
${body}
<footer>Every value on this page is a stored observation of a public surface, re-served — nothing was
fetched to build it. NULL and 0 are different claims here: a NULL means an instrument had no row, or
that we never asked. <a href="${SITE_BASE}/check">GET /check</a> for the machine catalogue.</footer>
</main></body></html>
`;

/** A value that may be NULL, rendered so the two cases cannot be confused. */
const val = (v, suffix = '') =>
  v === null || v === undefined ? '<span class="null">not observed</span>' : `${esc(v)}${esc(suffix)}`;

function instrumentCard(name, source, rows, view) {
  const dl = rows
    .map(([label, value]) => `<dt>${esc(label)}</dt><dd>${value}</dd>`)
    .join('');
  return `<article class="card${view.observed ? '' : ' absent'}">
  <span class="src">${esc(source)}</span>
  <h3>${esc(name)}</h3>
  ${view.observed ? `<dl>${dl}</dl>` : ''}
  <p class="reads">${esc(view.reads)}</p>
</article>`;
}

/** One probe verb, as the three-state thing it is. */
function statusCard(label, view) {
  if (!view) return '';
  const klass = view.status === null ? 'none' : view.status === 402 ? 'ok' : 'bad';
  const shown = view.status === null ? (view.asked ? 'no answer' : 'not asked') : String(view.status);
  return `<article class="card">
  <span class="src">${esc(label)}</span>
  <p class="status ${klass}">${esc(shown)}</p>
  <p class="reads">${esc(view.reads)}</p>
</article>`;
}

function flagsHtml(flags) {
  if (!flags.length) {
    return '<p class="none">No flag fired for this host on this day: the instruments that reported agree, and the probe found nothing that contradicts them.</p>';
  }
  return flags
    .map(
      (f) =>
        `<div class="flag${f.id.startsWith('wrongly-dead') ? ' wrong' : ''}"><span class="id">${esc(f.id)}</span>
  <p>${esc(f.statement)}</p></div>`
    )
    .join('\n');
}

/** GET /monitor, as a page. */
export function renderIndexHtml(payload) {
  if (payload.state === 'unavailable') {
    return page(
      'Parallax — unavailable',
      'The monitoring wing has no store to read.',
      `<h1>Nothing stored</h1><p class="lede">${esc(payload.error)}</p><p>${esc(payload.fix)}</p>`
    );
  }

  const prices = payload.endpoints
    .map(
      (e) =>
        `<tr><td><code>${esc(e.method)} ${esc(e.path)}</code></td><td>${esc(e.description)}</td><td class="price">${esc(e.price)}</td></tr>`
    )
    .join('\n');
  const free = payload.free
    .map((e) => `<tr><td><code>${esc(e.method)} ${esc(e.path)}</code></td><td>${esc(e.description)}</td><td class="price">free</td></tr>`)
    .join('\n');

  if (payload.state === 'no-capture') {
    return page(
      'Parallax — the 10x402 monitoring wing',
      'Three rating instruments, one declared-verb probe, every day.',
      `<h1>Parallax</h1><p class="lede">${esc(payload.what_this_is)}</p>
<h2>No capture yet</h2><p>${esc(payload.notes[0])}</p>
<h2>What it sells</h2><div class="scroll"><table class="pricing"><caption>the monitor routes</caption>
<thead><tr><th>route</th><th>what it answers</th><th>price</th></tr></thead><tbody>${free}\n${prices}</tbody></table></div>`
    );
  }

  const rows = payload.top_contradictions
    .map(
      (c) => `<tr>
  <td><a href="${SITE_BASE}/monitor/${encodeURIComponent(c.host)}"><code>${esc(c.host)}</code></a></td>
  <td class="n">${val(c.settled_usd_14d === null ? null : `$${round(Number(c.settled_usd_14d))}`)}</td>
  <td class="n">${c.ae_uptime === null ? val(null) : esc(uptimeText(c.ae_uptime))} <span class="null">${esc(c.ae_tier ? `tier ${c.ae_tier}` : '')}</span></td>
  <td class="n">${val(c.at_endpoints_down)} down</td>
  <td class="n">${val(c.declared_method)}</td>
  <td class="n">${c.probe.ran ? esc(c.probe.declared.status === null ? (c.probe.declared.asked ? 'no answer' : 'not asked') : c.probe.declared.status) : '<span class="null">not probed</span>'}</td>
</tr>`
    )
    .join('\n');

  const wrongly =
    payload.counts.wrongly_dead === null
      ? `<span class="pill warn">not probed yet</span>`
      : `<span class="status ok">${esc(payload.counts.wrongly_dead)}</span>`;

  return page(
    'Parallax — the 10x402 monitoring wing',
    'Three rating instruments, one declared-verb probe, every day. The disagreement is the product.',
    `<h1>Parallax</h1>
<p class="lede">${esc(payload.what_this_is)}</p>
<p class="stamp">as of ${esc(payload.as_of.day)} · captured: agenteconomy ${payload.as_of.captured.agenteconomy ? 'yes' : 'NO'} ·
apistrust ${payload.as_of.captured.apistrust ? 'yes' : 'NO'} · bazaar ${payload.as_of.captured.bazaar ? 'yes' : 'NO'} ·
roster ${payload.as_of.roster_size === null ? 'not probed yet' : esc(payload.as_of.roster_size)}</p>

<h2>The day</h2>
<div class="grid">
  <article class="card"><span class="src">population</span><p class="status ok">${val(payload.counts.population)}</p>
    <p class="reads">distinct hosts across the three instruments. ${esc(payload.counts.wallet_keys)} of the rows held are bare wallet keys the rater files under <code>host</code> — real settlement, nothing to probe.</p></article>
  <article class="card"><span class="src">liveness contradictions</span><p class="status ok">${val(payload.counts.contradictions)}</p>
    <p class="reads">rated at uptime 0.0 while the second prober saw none of their endpoints down. Both instruments present; they disagree.</p></article>
  <article class="card"><span class="src">wrongly dead</span><p>${wrongly}</p>
    <p class="reads">${esc(payload.counts.wrongly_dead_reads)}</p></article>
</div>

<h2>Contradictions, by settled volume</h2>
<p>Ordered by 14-day settled volume, because a wrong liveness reading costs most where money is actually moving.</p>
${
  rows
    ? `<div class="scroll"><table><caption>${esc(payload.as_of.day)} — top ${payload.top_contradictions.length}</caption>
<thead><tr><th>host</th><th>settled 14d</th><th>rated uptime</th><th>second prober</th><th>declares</th><th>we asked</th></tr></thead>
<tbody>${rows}</tbody></table></div>`
    : '<p class="none">No cross-instrument contradiction on this day. That is a finding, not an empty page.</p>'
}

<h2>What it sells</h2>
<div class="scroll"><table class="pricing"><caption>the monitor routes</caption>
<thead><tr><th>route</th><th>what it answers</th><th>price</th></tr></thead><tbody>${free}\n${prices}</tbody></table></div>
<p class="small">Paid routes are x402: the first unauthenticated call answers 402 with the terms, which is a price quote and not an error.</p>`
  );
}

/** GET /monitor/{host}, as a page. The one-screen human moment. */
export function renderHostHtml(payload) {
  if (payload.state === 'unavailable') {
    return page('Parallax — unavailable', 'The monitoring wing has no store to read.',
      `<h1>Nothing stored</h1><p class="lede">${esc(payload.error)}</p><p>${esc(payload.fix)}</p>`);
  }

  if (payload.state === 'unknown') {
    return page(
      `Parallax — ${payload.host} is not held`,
      'This wing holds no readings for that host.',
      `<h1><span class="host">${esc(payload.host)}</span></h1>
<p class="lede">${esc(payload.error)}</p>
<h2>What is held here</h2><p>${esc(payload.criteria)}</p>
<p>${esc(payload.fix)}</p>`
    );
  }

  const i = payload.instruments;
  const cards = [
    instrumentCard('agenteconomy.report', i.agenteconomy.source, [
      ['uptime', i.agenteconomy.uptime === null ? val(null) : esc(uptimeText(i.agenteconomy.uptime))],
      ['score', val(i.agenteconomy.score)],
      ['tier', val(i.agenteconomy.tier)],
      ['settled 14d', val(i.agenteconomy.settled_usd_14d === null ? null : `$${round(Number(i.agenteconomy.settled_usd_14d))}`)],
      ['organic', val(i.agenteconomy.organic_paying_agents)],
      ['flag', val(i.agenteconomy.flag)],
    ], i.agenteconomy),
    instrumentCard('apistrust.com', i.apistrust.source, [
      ['score', val(i.apistrust.score)],
      ['endpoints', val(i.apistrust.endpoints)],
      ['down', val(i.apistrust.endpoints_down)],
    ], i.apistrust),
    instrumentCard('CDP Bazaar', i.bazaar.source, [
      ['calls 30d', val(i.bazaar.calls_30d)],
      ['payers 30d', val(i.bazaar.unique_payers_30d)],
      ['last called', val(i.bazaar.last_called_at)],
      ['declares', val(i.bazaar.declared_method)],
      ['resource', val(i.bazaar.resource)],
    ], i.bazaar),
  ].join('\n');

  const probe = payload.probe.ran
    ? `<div class="probe">
${statusCard(`on ${payload.probe.declared_method} — its declared verb`, payload.probe.declared)}
${statusCard('on GET — what a GET-only rater sees', payload.probe.get)}
</div>
<div class="grid">
  <article class="card"><span class="src">PAYMENT-REQUIRED header</span><p class="reads">${esc(payload.probe.evidence.payment_required_header.reads)}</p></article>
  <article class="card"><span class="src">v1 body x402Version</span><p class="reads">${esc(payload.probe.evidence.v1_body_x402version.reads)}</p></article>
  <article class="card"><span class="src">when</span><p class="reads">${esc(payload.probe.at || 'not recorded')}</p></article>
</div>`
    : `<p class="none">${esc(payload.probe.reads)}${
        payload.probe_absent?.roster_cap
          ? ` The roster is capped at ${esc(payload.probe_absent.roster_cap)}${
              payload.probe_absent.population ? ` of a population of ${esc(payload.probe_absent.population)}` : ''
            }, in priority order — the house, then hosts rated dead while settling money, then liveness contradictions, then the largest settlers, then a healthy control sample.`
          : ''
      }</p>`;

  const stale =
    payload.freshness.stale === true
      ? '<span class="pill stale">stale</span> '
      : payload.freshness.stale === null
        ? '<span class="pill warn">no probe timestamp</span> '
        : '';

  const paid = payload.paid
    .map((e) => `<tr><td><code>${esc(e.method)} ${esc(e.path)}</code></td><td>${esc(e.description)}</td><td class="price">${esc(e.price)}</td></tr>`)
    .join('\n');

  return page(
    `Parallax — ${payload.host}`,
    `What three x402 rating instruments said about ${payload.host} on ${payload.as_of}, and what the endpoint itself answered.`,
    `<h1><span class="host">${esc(payload.host)}</span></h1>
<p class="stamp">${stale}as of ${esc(payload.as_of)} · ${esc(payload.state)}</p>
<p class="lede">${esc(payload.freshness.reads)}</p>

<h2>Three instruments, one day</h2>
<div class="grid">${cards}</div>

<h2>And what it answered when we asked</h2>
${probe}

<h2>Flags</h2>
${flagsHtml(payload.flags)}
${payload.unprobeable ? `<p class="none">${esc(payload.unprobeable.reads)}</p>` : ''}

<h2>The history is the product</h2>
<p>${esc(payload.notes[0])}</p>
<div class="scroll"><table class="pricing"><caption>paid, per call, over x402</caption>
<thead><tr><th>route</th><th>what it answers</th><th>price</th></tr></thead><tbody>${paid}</tbody></table></div>`
  );
}
