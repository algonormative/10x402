-- 10x402 store (D1). Four tables, and three of them are counters.
--
-- WHAT IS DELIBERATELY NOT HERE: the URLs people lint, the envelopes they
-- paste, and the reports they get back. A conformance linter is handed
-- pre-launch endpoints, staging hosts and receiving addresses — the shape of
-- someone's unreleased product — and the only defensible place to keep that is
-- nowhere. What is linted is the caller's business; how good this service is at
-- linting is ours, and the `lints` table records exactly that and nothing more.
--
-- Retention is an operator chore, not a cron (the Worker exports no `scheduled`
-- handler by design). The queries are in README § Operator queries.

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
-- free tier (off by default) and the paid runaway bound. Which one applies is
-- the Worker's business; the row just counts.
CREATE TABLE IF NOT EXISTS call_quota (
  day     TEXT,     -- UTC date, YYYY-MM-DD
  ip_hash TEXT,     -- truncated day-scoped hash of the IP alone
  used    INTEGER,  -- calls claimed today
  PRIMARY KEY (day, ip_hash)
);

-- Settlement ledger. One row per payment ATTEMPT that reached the facilitator,
-- so this table is the answer to "did anyone actually pay, and did the money
-- land". Three states, and they stay distinguishable:
--
--   verify_ok = 1, settle_ok = 1  the money moved; tx_hash is the chain hash
--   verify_ok = 1, settle_ok = 0  the report was served and settlement then
--                                 failed. The accepted exposure, a cent a row.
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
  endpoint  TEXT,     -- 'lint' | 'lint-envelope'
  payer     TEXT,     -- payer address from the payment payload, or NULL
  amount    TEXT,     -- atomic units as a string, '10000' for $0.01
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
CREATE TABLE IF NOT EXISTS lints (
  ts       INTEGER,  -- unix seconds, UTC
  endpoint TEXT,     -- 'lint' | 'lint-envelope'
  grade    TEXT,     -- 'A'..'F'
  errors   INTEGER,  -- error-severity findings
  warns    INTEGER   -- warn-severity findings
);

-- The operator reads on both ledgers are "what happened lately", so they scan by time.
CREATE INDEX IF NOT EXISTS idx_settlements_ts ON settlements (ts);
CREATE INDEX IF NOT EXISTS idx_lints_ts       ON lints (ts);
