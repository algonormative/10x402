// A REAL day of the monitor, captured 2026-08-27 and frozen — the Parallax
// analogue of worker/positive-control.js and worker/presence-control.js.
//
// It exists so the output examples published in the three monitor endpoints'
// own 402 envelopes are the REAL serving code run over REAL rows (see runSample
// in worker/envelope.js), with no D1 and no network at envelope-build time.
// Nothing in this file is typed as prose: every value is either a verbatim row
// from the 2026-08-27 first-party captures held in tradewind `raw/datasets/`
// (the same captures test/fixtures/monitor.mjs excerpts) or is NULL because it
// was not measured.
//
// ------------------------------------------------------------------ why the house is the subject
//
// 10x402.com, for the reason presence-control.js picked our own /lint/one: a
// published example about somebody else is a claim about them, and this one
// happens to be the claim the whole wing exists to make. On 2026-08-27 the
// prime rater read this host at uptime 0.0, score 0.0, tier D — while apistrust
// read it s=100 down=0 in the same week and the catalogue recorded four paid
// calls from three unique payers against /lint/one. The wing found its own case
// first, which is the only honest way to start selling it about strangers.
//
// ------------------------------------------------------------------ what the probe half is, exactly
//
// The probe row is the 2026-08-27 two-verb census
// (tradewind `2026-08-27--parallax-two-verb-probe`), not a run of probeHost():
// that census is what verified the mechanism, and it ran before this Worker had
// a probe cron. It recorded STATUSES AND EVIDENCE, NOT LATENCIES — so
// `declared_ms` and `get_ms` are NULL here, and NULL is the honest spelling of
// "not recorded" in a table where 0 would mean "answered instantly". The
// surfaces render that state as "not recorded" rather than as a number, which
// makes this sample the one that proves they can.
//
// `get_status: 405` is the PRE-INTERVENTION reading and is the point of it: a
// GET-only rater sees 405, files the host as dead, and rates it D while POST
// answers a perfectly good 402. Commit 76be06c (the E9 verb intervention,
// 2026-08-27) changes what a GET gets from this host — so a later recapture is
// EXPECTED to differ here, and that difference is the measurement, not drift.
//
// Recapture (dev machine, never from tests): re-run the three instrument reads
// and one two-verb probe, then re-trim. Nothing in the suite fetches any of it.

export const MONITOR_CONTROL = {
  captured: '2026-08-27',

  /**
   * The clock the sample is assembled against, frozen.
   *
   * Every monitor payload is `as_of`-stamped and the verdict ages its probe
   * against now, so a sample built from `Date.now()` would publish a different
   * envelope every day — a header that churns for no reason, and a dist/ diff
   * that says nothing. This is 2026-08-27T12:00:00Z: thirteen minutes after the
   * probe cron's 11:47, which is when a caller reading this day's verdict would
   * actually have been reading it.
   */
  now: Date.parse('2026-08-27T12:00:00Z'),

  /** The day's meta row, as capture + probe would have written it. */
  day: {
    day: '2026-08-27',
    // The union across three instruments. ~2,185 distinct hosts on the day the
    // captures were taken (1,194 rated, 2,005 in the host table, 14,732
    // catalogue resources reducing to a few thousand hosts).
    population: 2185,
    captured_ae: 1,
    captured_at: 1,
    captured_bazaar: 1,
    roster_size: 400,
    wrongly_dead: 249,
    contradictions: 127,
  },

  /**
   * The day's readings for the subject, verbatim.
   *
   * ONE DAY, AND THAT IS NOT A SHORTCUT. A three-day series in the published
   * example would be two days of invented history, in a document whose entire
   * value is that its numbers are observations. The wing's first capture is
   * 2026-08-27; the example says `days: 1` and the payload says why.
   */
  readings: [
    {
      day: '2026-08-27',
      host: '10x402.com',
      // agenteconomy.report, verbatim: dead at the rater while settling.
      ae_uptime: 0.0,
      ae_score: 0.0,
      ae_tier: 'D',
      ae_settled_14d: 1.33,
      ae_organic: 5,
      ae_flag: 'NEW',
      // apistrust.com, verbatim: four endpoints, none of them ever down.
      at_score: 100,
      at_down: 0,
      at_endpoints: 4,
      // The CDP catalogue's quality block for the host's most-recently-called
      // resource, verbatim.
      bz_calls_30d: 4,
      bz_unique_payers: 3,
      bz_last_called: '2026-08-27T03:22:07.269Z',
      bz_resource: 'https://10x402.com/lint/one',
      bz_method: 'POST',
    },
  ],

  /** The two-verb census row. See the note above on the NULL latencies. */
  probes: [
    {
      day: '2026-08-27',
      host: '10x402.com',
      // 11:47:12 UTC — the probe cron's minute.
      ts: Math.floor(Date.parse('2026-08-27T11:47:12Z') / 1000),
      declared_method: 'POST',
      declared_status: 402,
      declared_ms: null,
      get_status: 405,
      get_ms: null,
      // A live dual-stack 402: the PAYMENT-REQUIRED header is there and the
      // body parses as JSON carrying x402Version. This service's own self-lint
      // invariant (test/self-lint.test.mjs) is what makes those two 1s
      // checkable rather than asserted.
      saw_v2_header: 1,
      saw_v1_body: 1,
    },
  ],
};
