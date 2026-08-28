# Parallax — the 10x402 monitoring wing

Design doc, 2026-08-27. Owner decision: build Parallax as a wing of
10x402 rather than a standalone property (distribution: this domain is
already Bazaar-indexed and probed daily by 25+ raters). Market layer
lives in tradewind (`ideas/parallax-rating-instruments.md`,
`raw/sources/2026-08-27--get-only-prober-mechanism-verified.md`);
campaign experiment E9 (the verb intervention) is armed on this repo's
commit 76be06c.

## What it is

The lint answers "is your x402 implementation correct?" once. The
monitor answers "are you alive, on the verb you declared, and what do
the rating surfaces say about you?" — every day, with the history kept.

The measured wedge: the x402 seller economy is read through three free
instruments (agenteconomy.report ratings, apistrust.com host table, CDP
Bazaar per-row quality block) that disagree with each other at the
level of "is this seller alive" (liveness r = 0.401 across 773 shared
hosts; 127 hosts entirely dead at one and entirely healthy at the
other). Verified mechanism: the prime rater probes GET-only, so every
POST-declared seller reads uptime 0.0 and is rated D — 260/960 hosts,
249 of them settling money, 13.7% of the market's settlement under a
wrong "dead" label.

## Substrate (all fetching in cron; the request path serves only D1)

Two cron triggers (Workers paid plan, 1000 subrequests/invocation):

1. **Capture** (`17 */6 * * *` — four times a day): fetch `MONITOR_AE_BASE`/s/ratings.json
   (default https://agenteconomy.report; 1.6 MB, CC BY 4.0),
   `MONITOR_AT_BASE`/ (default https://apistrust.com; host table
   embedded in HTML as JSON), and the full Bazaar catalogue via
   presence.js's existing pager (`bazaarBase(env)`, limit=1000, ~16
   pages). Distill into per-host daily rows + one day-meta row. A
   failed instrument records NULLs for its columns, never blocks the
   others.
2. **Probe** (`47 */6 * * *`, thirty minutes after each capture): derive the day's roster from the day's
   readings — priority order: house hosts, wrongly-dead-and-settling,
   liveness contradictions, top settlers, fill with healthy sample;
   capped at `MONITOR_PROBE_CAP` (default 400). Probe each host's
   most-recently-called Bazaar resource on its **declared verb** and on
   GET (one probe when they coincide). Record status, latency,
   PAYMENT-REQUIRED header presence, v1 body `x402Version` presence
   (body read capped at 4 KB). **Never send X-PAYMENT. Never pay.**
   UA: `10x402-monitor/0.1 (+https://10x402.com/monitor)`. Every probe
   URL passes fetch-target.js's `checkTargetUrl` SSRF rules — catalogue
   rows are third-party-controlled input.

Cadence semantics (2026-08-28, owner bump from daily): rows are keyed
by UTC day and each run REPLACES its day's rows, so four runs a day
means the pages refresh every six hours while the archive stays one
row per host per day — the day's row is the day's LATEST observation,
and `monitor_probes.ts` carries the actual probe time.

D1 tables (additive, schema.sql): `monitor_readings` (host, day,
ae_uptime, ae_score, ae_tier, ae_settled_14d, ae_organic, ae_flag,
at_score, at_down, at_endpoints, bz_calls_30d, bz_unique_payers,
bz_last_called, bz_resource, bz_method), `monitor_probes` (host, day,
ts, declared_method, declared_status, declared_ms, get_status, get_ms,
saw_v2_header, saw_v1_body), `monitor_days` (day, population,
captured_ae, captured_at, captured_bazaar, roster_size, wrongly_dead,
contradictions).

Flags computed at read time, not stored: `liveness-contradiction`
(ae_uptime = 0 and at_down = 0 with both present) and `wrongly-dead`
(ae_uptime = 0 and the declared-verb probe answered 402).

## Surfaces

Free (Worker routes, `10x402.com/monitor*`; read-only, D1 only):

- `GET /monitor` — wing index: latest day meta, wrongly-dead and
  contradiction counts, top contradictions by settlement, prices,
  what-this-is. JSON; HTML when `Accept: text/html`.
- `GET /monitor/{host}` — the current snapshot: today's three-instrument
  reading side by side, today's probe, flags. The one-screen human
  moment. JSON; HTML when `Accept: text/html`. Unknown host → 404
  naming the roster criteria. **No history on the free surface.**

Paid (same chassis, POST + JSON body, prices unique on the sheet for
settlement attribution; GET/HEAD get the 402 probe surface like every
other paid route):

- `POST /monitor/verdict` `{host}` — **$0.005** (the incumbent's own
  price for a rating read). Latest stored probe + readings + flags,
  `as_of`-stamped; if the stored day is stale (> 36 h) the verdict says
  so instead of pretending.
- `POST /monitor/history` `{host}` — **$0.03**. The full daily series
  held for the host (readings + probes).
- `POST /monitor/receipt` `{host}` — **$0.12**. The dispute pack: the
  series, the cross-instrument contradiction statement, a SHA-256
  digest over the canonical JSON, and an attestation paragraph naming
  the method, UA, and that no payment was ever sent. This is the
  artifact a seller attaches to a corrections request.

No new outbound fetches on the request path: verdict/history/receipt
serve stored rows only. Endpoint `kind: 'monitor'` dispatches beside
`kind: 'presence'` in handlePaid's work switch.

## Invariants carried from the chassis

Settle only after a served report; verify before claim; unpaid fast
path touches no store; 402s built by build402 only; no production npm
dependencies; tests never touch the live network (instrument bases and
probe targets are env-overridable, mocked in the suite — fixtures are
excerpts of the real 2026-08-27 captures in tradewind
`raw/datasets/`). Free monitor routes are read-only D1 and must stay
serveable when a capture day is missing (empty state says so).

## Out of scope for the MVP (filed as beads)

R2 raw-snapshot archival; paid GET endpoints (querystring inputs);
cross-population sharding past MONITOR_PROBE_CAP; signing receipts with
a real key (digest + dated URL first); Bazaar listing of the new
endpoints (rows are settlement-written — the drill covers them after
deploy).
