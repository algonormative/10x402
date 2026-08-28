-- 10x402 store (D1). Two halves that never mix.
--
-- THE LINT HALF (salt, counters, call_quota, payment_seen, settlements, lints)
-- is six tables and most of them are counters. WHAT IS DELIBERATELY NOT HERE:
-- the URLs people lint, the envelopes they paste, and the reports they get
-- back. A conformance linter is handed pre-launch endpoints, staging hosts and
-- receiving addresses — the shape of someone's unreleased product — and the
-- only defensible place to keep that is nowhere. What is linted is the caller's
-- business; how good this service is at linting is ours, and the `lints` table
-- records exactly that and nothing more.
--
-- THE MONITOR HALF (monitor_readings, monitor_probes, monitor_days) is the
-- opposite by design and it is worth being explicit about why that is not a
-- contradiction. It holds observations of PUBLIC surfaces about PUBLIC hosts:
-- three free rating instruments that already publish every row of it, plus
-- what a host answered an unauthenticated request. Nobody's caller is in it,
-- nothing was paid to obtain it, and every value in it can be re-derived by
-- anyone with curl. See MONITOR.md.
--
-- Retention on the lint half is an operator chore; the queries are in
-- README § Operator queries. The monitor half is the history it sells, so it
-- is KEPT — the daily series IS the product.

-- One row, key = 'current'. Overwritten with fresh random bytes on the first
-- request of a new UTC day; the overwrite is the discard, which is what makes
-- yesterday's caller identities unrecoverable rather than merely unindexed.
CREATE TABLE IF NOT EXISTS salt (
  key   TEXT PRIMARY KEY,
  day   TEXT,
  value TEXT
);

-- The global fail-closed counter: one row per UTC day, read before every claim.
CREATE TABLE IF NOT EXISTS counters (
  day   TEXT PRIMARY KEY,
  total INTEGER
);

-- Per-caller daily calls, claimed by a guarded upsert in worker/worker.js.
--
-- `ip_hash` is the first 16 hex chars of SHA-256(daily_salt + ip) — the IP
-- ALONE, no user-agent, because rotating a UA string must not mint a fresh
-- allowance. Unlinkable across days for the same reason as everything else
-- here: the salt is overwritten. Only today's row is ever read.
--
-- It carries two ceilings depending on the path that claims it: a configured
-- free tier (off by default), the paid runaway bound, and the bound on how many
-- payments one caller may have CHECKED in a day. Which one applies is the
-- Worker's business; the row just counts.
--
-- THE KEY IS NAMESPACED, and that is the only reason one table serves several
-- ceilings: `<hash>` is the served-call counter, `verify:<hash>` is the
-- payment-verification counter, and `alert:<channel>` is the owner's daily
-- notification budget (not per caller — there is one owner). Distinct keys
-- cannot spend each other's allowance, and the atomic guarded upsert that makes
-- the claim correct is written once rather than three times.
CREATE TABLE IF NOT EXISTS call_quota (
  day     TEXT,     -- UTC date, YYYY-MM-DD
  ip_hash TEXT,     -- '<hash>' | 'verify:<hash>' | 'alert:<channel>'
  used    INTEGER,  -- claims made today against that key
  PRIMARY KEY (day, ip_hash)
);

-- Payments already spent, so one of them cannot buy the work twice.
--
-- A verified x402 payment is a signed authorization, and verifying it is a
-- READ: the facilitator says the signature is good and the funds are there, and
-- says the same thing however many times it is asked. Nothing moves until
-- settle, and settle runs AFTER the response. So one paid header replayed
-- concurrently verified over and over and bought a lint each time — the
-- per-caller ceiling was the only thing bounding it, and that is per IP.
--
-- The row is claimed BETWEEN verify and the work, so the first request through
-- owns the payment and every later one is answered 402 'payment already used'.
--
-- WHAT THIS IS NOT: an authoritative double-spend guard. The hash is of the
-- payment header as presented, so the same authorization re-encoded with its
-- keys in another order hashes differently. The authoritative backstop is on
-- chain — an EIP-3009 nonce is single-use, and a second settle comes back
-- `nonce_already_used`, which `settlements` records. This table exists to stop
-- the amplification BEFORE the work is served, which the chain cannot do.
--
-- `created_at` is for the operator: prune on the same cadence as call_quota,
-- past any authorization's maxTimeoutSeconds.
CREATE TABLE IF NOT EXISTS payment_seen (
  hash       TEXT PRIMARY KEY,  -- SHA-256 of the presented payment header, hex
  created_at INTEGER            -- unix seconds, UTC
);

-- Settlement ledger. One row per payment ATTEMPT that reached the facilitator,
-- so this table is the answer to "did anyone actually pay, and did the money
-- land". Three states, and they stay distinguishable:
--
--   verify_ok = 1, settle_ok = 1  the money moved; tx_hash is the chain hash
--   verify_ok = 1, settle_ok = 0  the report was served and settlement then
--                                 failed. The accepted exposure, one price a row.
--   verify_ok = 0, settle_ok = 0  either the facilitator REJECTED the payment
--                                 (error = its invalidReason, and nothing was
--                                 served) or it could not be reached (error =
--                                 facilitator-unreachable / -unconfigured /
--                                 -error, and the report WAS served free).
--
-- `payer` is an address its owner revealed by paying and `tx_hash` is public
-- chain data. Neither is derived from an IP or any other passive signal, so
-- neither is covered by the daily-salt discard — and these rows are KEPT rather
-- than pruned: they are the revenue record.
--
-- NOT written for free-tier calls. The free tier is not a payment path and the
-- facilitator is never called inside it.
CREATE TABLE IF NOT EXISTS settlements (
  ts        INTEGER,  -- unix seconds, UTC
  endpoint  TEXT,     -- 'lint' | 'lint-one' | 'lint-envelope' | 'lint-envelope-one'
  payer     TEXT,     -- payer address from the payment payload, or NULL
  amount    TEXT,     -- atomic units as a string, '100000' for $0.10
  verify_ok INTEGER,  -- 1 | 0
  settle_ok INTEGER,  -- 1 | 0
  tx_hash   TEXT,     -- settlement transaction hash, or NULL
  error     TEXT      -- invalidReason / errorReason / transport reason, or NULL
);

-- Product telemetry, and thin on purpose: which endpoint, what grade, how many
-- findings. NO url, NO envelope, NO report body — see the note at the top.
--
-- It answers one question, which is the only one worth asking of this service:
-- are the endpoints out there getting better, and is this catalogue finding
-- anything. A grade distribution that is all A is a linter that has stopped
-- looking; one that is all F is a catalogue that is wrong.
-- TWO VOCABULARIES IN `grade`, told apart by `endpoint`. A full report grades
-- 'A'..'F'. A single-check report has no grade — a letter computed from one
-- check would be a fabricated verdict — so those rows carry 'pass', 'fail', or
-- 'n/a' when the named check did not apply to the response at all.
CREATE TABLE IF NOT EXISTS lints (
  ts       INTEGER,  -- unix seconds, UTC
  endpoint TEXT,     -- 'lint' | 'lint-one' | 'lint-envelope' | 'lint-envelope-one'
  grade    TEXT,     -- 'A'..'F' for a full report; 'pass' | 'fail' | 'n/a' for one check
  errors   INTEGER,  -- error-severity findings
  warns    INTEGER   -- warn-severity findings
);

-- The operator reads on both ledgers are "what happened lately", so they scan by time.
-- payment_seen is read by primary key only and needs no index of its own.
CREATE INDEX IF NOT EXISTS idx_settlements_ts ON settlements (ts);
CREATE INDEX IF NOT EXISTS idx_lints_ts       ON lints (ts);

-- ==================================================================
-- Parallax — the monitoring wing. Written ONLY by the two crons in
-- worker/monitor.js; the request path reads these three tables and writes none
-- of them. Additive: nothing above this line knows they exist.
-- ==================================================================

-- One row per host per UTC day: what the three instruments said, side by side.
--
-- THE COLUMN PREFIX IS THE PROVENANCE, and that is the point of the table
-- rather than a naming habit. `ae_` is agenteconomy.report's reading, `at_` is
-- apistrust's, `bz_` is the CDP catalogue's — and this wing exists because
-- they disagree (liveness r = 0.401 across 773 shared hosts). A column that
-- lost its prefix would be a number with no source, which is the one thing
-- this table must never hold.
--
-- NULL IS "NOT OBSERVED", NEVER ZERO. A host present in one instrument and
-- absent from another gets a row with the other's columns NULL — 438 rated
-- hosts were absent from the catalogue and 847 catalogue hosts were unrated on
-- 2026-08-27, and both of those are findings. An instrument that could not be
-- read that day leaves ALL of its columns NULL on every row, and
-- monitor_days.captured_* is how a reader tells that apart from a host simply
-- not being in it.
--
-- A ROW IS NOT NECESSARILY A PROBEABLE HOST. The rater files raw `0x…` wallet
-- addresses under `host` (234 of 1,194 rows, flagged UNLISTED); they are real
-- rated services with real settlement, so they are counted here, and
-- worker/monitor.js keeps them out of the probe roster.
CREATE TABLE IF NOT EXISTS monitor_readings (
  day               TEXT,     -- UTC date, YYYY-MM-DD
  host              TEXT,     -- lowercased hostname, or a rater's bare 0x… row
  ae_uptime         REAL,     -- 0..1. 0.0 here is the wing's whole subject
  ae_score          REAL,
  ae_tier           TEXT,     -- AAA..D
  ae_settled_14d    REAL,     -- USD over a FOURTEEN-day window, never monthly
  ae_organic        INTEGER,  -- sybil-filtered paying agents
  ae_flag           TEXT,     -- NULL | 'NEW' | 'UNLISTED' | 'CAPTIVE'
  at_score          REAL,
  at_down           INTEGER,  -- endpoints the second prober saw down
  at_endpoints      INTEGER,
  bz_calls_30d      INTEGER,  -- quality.l30DaysTotalCalls
  bz_unique_payers  INTEGER,  -- quality.l30DaysUniquePayers
  bz_last_called    TEXT,     -- quality.lastCalledAt, ISO 8601
  bz_resource       TEXT,     -- the host's most-recently-called resource URL
  bz_method         TEXT,     -- the DECLARED verb, from accepts[0].outputSchema.input.method
  PRIMARY KEY (day, host)
);

-- One row per host per day that was actually probed — a subset of the readings,
-- capped at MONITOR_PROBE_CAP and ordered by worker/monitor.js's roster rules.
--
-- TWO READINGS OF ONE RESOURCE, taken seconds apart: on the verb the seller
-- declared, and on GET. That pair is the measurement the whole wing rests on —
-- the prime rater probes GET-only, so a POST-declared seller reads dead at it
-- while answering 402 perfectly well on its own verb.
--
-- STATUS ENCODING, because 0 is not a status any server can return:
--   402, 405, …  what the host actually answered
--   0            we asked and got no HTTP response — timeout, DNS, TLS,
--                refused. (curl spells this 000.)
--   NULL         we never asked: the declared verb was not one this service
--                will send (see PROBE_VERBS), or — for the get_* pair — it
--                cannot happen, since GET is always sent.
-- When the declared verb IS GET, one request is made and its result fills both
-- pairs: they are the same observation, not two.
--
-- NO PAYMENT IS EVER SENT, so every row here is what an unpaid caller sees —
-- which is the only reading comparable with what the raters publish.
CREATE TABLE IF NOT EXISTS monitor_probes (
  day             TEXT,
  host            TEXT,
  ts              INTEGER,  -- unix seconds, UTC — when the probe ran
  declared_method TEXT,     -- the verb the catalogue row declares
  declared_status INTEGER,
  declared_ms     INTEGER,
  get_status      INTEGER,
  get_ms          INTEGER,
  saw_v2_header   INTEGER,  -- 1 | 0 | NULL — PAYMENT-REQUIRED on the declared response
  saw_v1_body     INTEGER,  -- 1 | 0 | NULL — body parsed as JSON carrying x402Version
  PRIMARY KEY (day, host)
);

-- One row per UTC day: what the day's capture and probe actually managed.
--
-- WRITTEN BY TWO CRONS, HALF AN HOUR APART, AND NEITHER CLOBBERS THE OTHER.
-- Capture (11:17) owns population, captured_* and contradictions. Probe (11:47)
-- owns roster_size and wrongly_dead. `wrongly_dead` is "dead at the rater AND
-- answering 402 on its declared verb", and the two halves of that are measured
-- by different crons — so it CANNOT exist at capture time and is NULL until the
-- probe runs. NULL there means "not probed yet"; it never means "none found".
--
-- `contradictions` is the other flag and it needs no probe: ae_uptime = 0 while
-- at_down = 0, with both instruments present.
CREATE TABLE IF NOT EXISTS monitor_days (
  day             TEXT PRIMARY KEY,
  population      INTEGER,  -- distinct hosts across all three instruments
  captured_ae     INTEGER,  -- 1 | 0 — did the instrument read at all
  captured_at     INTEGER,
  captured_bazaar INTEGER,
  roster_size     INTEGER,  -- probes actually written. NULL until 11:47
  wrongly_dead    INTEGER,  -- NULL until 11:47 — see above
  contradictions  INTEGER
);

-- The day-scan reads ("show me today") ride the primary keys. These two serve
-- the OTHER direction, which is the paid product: /monitor/history walks one
-- host across every day held, and without them that is a full table scan whose
-- cost grows with every day the wing stays up.
CREATE INDEX IF NOT EXISTS idx_monitor_readings_host ON monitor_readings (host, day);
CREATE INDEX IF NOT EXISTS idx_monitor_probes_host   ON monitor_probes (host, day);
