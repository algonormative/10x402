# 10x402

*("ten-ex-four-oh-two")*

x402 conformance linting, sold per call over x402.

Point it at a paid endpoint and it tells you, in 64 checks, everything a client,
a facilitator or a discovery index will quietly refuse to tell you.

**Status: built, not deployed. Zero revenue to date. `10x402.com` is not
registered yet.** Nothing in this repo depends on that domain resolving — no
test fetches it, the Worker never calls it, and it appears only as a string in
generated copy and in envelope metadata.

---

## Positioning

Shovels for x402 sellers: the conformance tuition we paid, sold per call.

An x402 endpoint fails silently in every direction at once, and that is the
whole product thesis:

- A **url-safe base64** v2 envelope is discarded by the client *before* it is
  decoded — clients validate against `/^[A-Za-z0-9+/]*={0,2}$/` first — so you
  look like a seller who published nothing at all.
- A `bazaar.info` that does not validate against its own `bazaar.schema` is
  declined by the facilitator **without a word**. The endpoint keeps taking
  payments and simply never appears in the directory.
- A missing `extra.name` / `extra.version` makes every genuine payment fail as
  `invalid_exact_evm_payload_signature`, because the client signs over an
  undefined EIP-712 domain while the facilitator recomputes it from its own
  table. Nothing in your logs mentions it.
- A **free tier** hands the discovery prober a 200 and delists an endpoint that
  was already indexed.
- A `maxAmountRequired` left in a v2 accepts entry means a v2 client reads
  `amount`, finds `undefined`, and has no price to sign against.

None of those produce an error you will see. They produce an *absence* — of
buyers, of a listing, of anything at all — and an absence is very hard to debug.
That is what this sells: the difference between "my listing is missing, I wonder
why" and a one-line diff.

## The self-lint invariant

**10x402 lints itself in CI; grade A or the build fails.**

`test/self-lint.test.mjs` takes 10x402's *own* 402 — for both paid endpoints, in
the production configuration, off the wire through wrangler and workerd — and
runs it through 10x402's *own* lint engine. It must grade **A with zero
findings**, info included. `node build.mjs` runs the same check and refuses to
emit `dist/` if it fails.

A conformance linter that does not pass its own lint is a shop with a broken
sign. When this fails, the honest question is which half is wrong: if the check
is right, fix the envelope; if the envelope is right, the check is wrong and a
paying stranger is about to be told the same wrong thing. Do not weaken the
check to make it pass without deciding.

Its counterweight is `worker/positive-control.js`: a **real 402 captured once
from a live production seller**, frozen, which must grade A with zero findings.
A linter that grades every stranger's endpoint an F is indistinguishable, from
the outside, from a linter that has found something. Ground the measurement on a
known-good before trusting any negative verdict.

## What it does

| | | |
|---|---|---|
| `POST /lint` | **$0.01** | Sends one unauthenticated request to a URL you name and lints the response. |
| `POST /lint/envelope` | **$0.005** | The same 64 checks over a response you paste. No outbound request, so it works on staging, on localhost, and on an endpoint that is not deployed yet. |
| `GET /check` | **free** | Service info, the full check catalogue by code, prices, the grade ladder. |

Both paid endpoints return the same shape:

```json
{
  "grade": "A",
  "summary": {
    "versions_detected": [1, 2],
    "payTo": "0x…",
    "network": "eip155:8453",
    "price": "$0.001 (1000 atomic)"
  },
  "findings": [
    {
      "severity": "error",
      "code": "V2_B64_URLSAFE",
      "message": "the PAYMENT-REQUIRED header is not standard base64 …",
      "fix": "Encode the header with STANDARD base64, not base64url. …"
    }
  ],
  "checks_run": 58
}
```

`checks_run` is how many checks **applied**, not how many exist. A v1-only
endpoint legitimately skips every v2 check, and a caller comparing two reports
needs to know the denominator moved.

**The `fix` strings are the product.** A linter that reports "invalid envelope"
and stops has told the seller nothing they did not already know from the
silence.

## The check catalogue

64 checks in six areas. Published in full at `GET /check` and on the page,
before anyone spends anything.

| area | checks | what it covers |
|---|---|---|
| `http` | 6 | 402-for-unauthenticated, free-tier 200s, 5xx, redirects, JSON content-type |
| `v2` | 30 | the `PAYMENT-REQUIRED` header envelope: base64 encoding, CAIP-2 networks, `amount`, the resource object, the EIP-712 domain, `extensions.bazaar` |
| `v1` | 19 | the 402 body envelope: `maxAmountRequired`, plain network names, the flat-string resource, `outputSchema.input.discoverable` — and whether there is a v1 envelope at all |
| `dual` | 5 | when both are published, they must agree on payTo, price, chain, asset and resource |
| `version` | 2 | a v1 payload in the v2 header, or the reverse |
| `report` | 2 | what the linter itself did not read: a long `accepts[]`, a capped report |

### What a report is NOT allowed to do

Three properties the catalogue holds to, because a linter that gets them wrong
is worse than none:

- **A partial report says it is partial.** A response that is not a 402 —
  a redirect, a free-tier 200, a 405 to the POST this linter sends — carries no
  envelope because there was never going to be one there. The envelope checks
  are skipped, `summary.partial` says so, and the status finding is the report.
  A redirect that answered "no x402 envelope was found" was a true sentence
  about the wrong URL, and an F for an envelope nobody had looked at.
- **The grade does not scale with the input.** One fault repeated across forty
  `accepts[]` entries is one finding naming all forty, not forty findings and a
  worse grade than the same fault in one entry.
- **The report is bounded, because the input is not.** At most 8 `accepts[]`
  entries are linted, at most 200 findings are returned, and every string quoted
  back out of the envelope is clipped. Each bound reports itself — a truncated
  report read as a clean one would be worse than the amplification it prevents.

### Grades

| grade | when |
|---|---|
| A | zero errors and zero warnings |
| B | zero errors, one or two warnings |
| C | zero errors, three or more warnings |
| D | one or more errors, none of them core |
| F | any **core** error — the envelope is not usable as published |

*Core* marks the checks whose failure makes the envelope invalid rather than
merely impoverished. One core error is an F: the endpoint does not work. An
ordinary error is a D: it works, and something about it is wrong.

Severities: **error** — a client, a facilitator or the index will reject or
mis-read this. **warn** — it works, but it costs the seller something they
probably want. **info** — a nit, never affects the grade.

## Its own sell side

10x402 sells over x402 exactly the way the chassis does:

- **402-first.** The first unauthenticated call is the 402, not the fourth, and
  it touches no store — no salt read, no quota claim, no D1 write. That keeps a
  continuously scanned public endpoint cheap, and it is what CDP Bazaar's prober
  requires.
- **Dual-stack.** One 402 carries both generations: v1 as the JSON body, v2 as
  standard base64 in a `PAYMENT-REQUIRED` response header. Every v2 field is
  *projected* from the v1 object rather than assembled twice, so the two cannot
  drift — which is, not coincidentally, the `DUAL_*` family of checks applied to
  ourselves.
- **No free tier**, by default and on purpose. One would fail this service's own
  `HTTP_FREE_TIER_200` check. The mechanism is env-gated and kept alive
  (`FREE_TIER_DAILY`), so it stays tested rather than rotting.
- **Real verification.** Payments are verified with the Coinbase CDP facilitator
  before anything is served, and settled *after* the response in
  `ctx.waitUntil`. Nothing is ever fake-verified: `x-payment-verified: true`
  appears only after a facilitator round trip that returned `isValid`, and no
  settlement receipt is emitted for a settlement that has not happened.
- **Nobody is charged for a report that was not served.** Settlement is queued
  only after the report exists; a bad URL, an unreachable target or a malformed
  paste settles nothing, even when the payment verified.
- **Alerts.** Telegram and email when money moves, fired from `ctx.waitUntil`
  after the response, each channel independently caught. Probe noise never
  pages.

## Layout

```
worker/
  worker.js            routing, the 402 flow, quotas, D1, telemetry
  lint.js              THE PRODUCT — 64 checks, pure, no Worker globals
  json-schema.js       a JSON Schema subset, for bazaar info-vs-schema
  catalog.js           endpoints, prices, samples — the single source
  envelope.js          10x402's own v1 + v2 envelopes
  positive-control.js  a real 402 captured from a live seller (frozen)
  fetch-target.js      the SSRF-guarded outbound fetch
  x402.js              CDP facilitator verify/settle, the Ed25519 JWT
  alert-message.js     what an alert says (pure; RFC 5322)
  alerts.js            how it is sent (Telegram, send_email binding)
  schema.sql           D1: salt, counters, call_quota, settlements, lints
build.mjs              generates dist/ and runs the self-lint
mcp/server.mjs         MCP server; a 402 is a price quote, never isError
skills/10x402/         a drop-in agent skill
test/                  six phases, 352 tests, no live or billed calls
```

**The Worker has no production npm dependencies.** The lint engine, the JSON
Schema subset, the envelopes and the CDP JWT are all in `worker/*.js`. The one
thing this service sells is a correct reading of a spec, and a supply chain is a
place for that reading to change without anyone deciding to change it.

## Tests

```bash
npm install
npm test
```

352 tests in six phases. **No live network calls and no billed calls, ever** —
the facilitator, Telegram and the lint targets are all http servers the suite
runs on 127.0.0.1, and the CDP credentials are generated per run and worth
nothing.

| phase | tests | what |
|---|---|---|
| engine | 144 | pure functions: the lint engine against fixtures, the JSON Schema subset, the SSRF URL rules, the positive control. **Boots no worker** — if the engine is wrong, every later phase is measuring the wrong thing, and 0.1s beats four worker boots. |
| served calls | 84 | `/check`, `/lint/envelope`, and the SSRF guard through the live Worker in its **shipped** configuration |
| outbound lint | 42 | `/lint` against mock target servers, with the guard relaxed by `LINT_UNSAFE_TARGETS` |
| production default | 39 | the 402 front door, and **the self-lint invariant** |
| settlement | 17 | verify/settle against a strict per-version mock facilitator |
| alerts | 26 | mock facilitator + mock Telegram, and the RFC 5322 message |

The mock facilitator is **strict about version shape**: v1 and v2 send the same
three-field body to the same endpoint and differ entirely in the shapes inside
it, so a Worker shipping a v1 envelope alongside a v2 payload would look
perfectly healthy against a mock that only echoes canned answers — and would
verify as invalid against the real facilitator. Every hit is shape-checked and a
mismatch answers 400. One test turns that strictness off and asserts the outcome
changes, because a strictness nothing ever trips is indistinguishable from no
strictness.

Run one file directly — it boots its own worker:

```bash
node --test test/lint-engine.test.mjs
```

## Safety

`POST /lint` makes a request on a stranger's behalf, which is the whole threat
model: a caller who can name a URL and see the response has, for one cent,
rented our network position. So:

- **https only**, no credentials in the authority
- **no private or reserved targets** — loopback, RFC 1918, link-local
  (including the cloud metadata address), CGNAT, ULA, IPv4-mapped IPv6
- **no private-network names** — `localhost`, `*.internal`, `*.local`,
  `*.home.arpa`, and bare hostnames with no dot
- **no redirects followed** (`redirect: 'manual'`) — the classic bypass, and a
  real finding for the seller, so it is reported rather than chased
- **one request**, no retry, no preflight
- **256 KB** read cap, streamed and counted rather than buffered whole
- **10s** timeout

**What this does not defend, stated plainly: DNS rebinding.** The guard resolves
nothing — a Worker has no DNS API — so a hostname whose A record points at
127.0.0.1 is not caught here. Cloudflare's egress does not route to our own
private ranges, which removes the usual prize. The honest statement is that this
is a public-URL linter and should not be deployed anywhere its egress can see a
private network.

`LINT_UNSAFE_TARGETS` relaxes the scheme and address rules so the suite can
reach a mock target on 127.0.0.1. It is off unless the value is exactly `"1"`,
no production deployment sets it, and it is named to be alarming on purpose — a
var called `ALLOW_LOCAL` would look like a feature.

## Privacy

`worker/schema.sql` has **no column that could hold a linted URL, a pasted
envelope, or a report.** A conformance linter is handed pre-launch endpoints,
staging hosts and receiving addresses — the shape of someone's unreleased
product — and the only defensible place to keep that is nowhere. The `lints`
table records endpoint, grade and finding counts, and that is all; a test
asserts the schema stays that way.

Caller identity is `SHA-256(daily salt + IP)`, truncated, with the salt
overwritten on the first request of each UTC day. The overwrite is the discard.

## Deploy runbook

**Not yet done.** In order:

1. **Register `10x402.com`** and add the zone to the Cloudflare account. Until
   then the routes in `wrangler.toml` cannot be created and `wrangler deploy`
   will say so.
2. Create the database and note the id:
   ```bash
   npx wrangler d1 create tenx402
   ```
   Replace the `database_id` placeholder in `wrangler.toml`.
3. Apply the schema:
   ```bash
   npx wrangler d1 execute tenx402 --remote --file worker/schema.sql
   ```
4. Set the receiving address. `PAYTO` is a var, not a secret — it is a public
   chain address — but it is deliberately **not committed**, because a receiving
   address in a public repo is one nobody double-checks:
   ```bash
   npx wrangler secret put PAYTO      # or set it in the dashboard as a var
   ```
   Without it, paid calls answer 429 instead of 402, because there is nowhere to
   pay. That is a working state and it is also a revenue-is-zero state.
5. Set the CDP credentials (secrets, never committed):
   ```bash
   npx wrangler secret put CDP_API_KEY_ID
   npx wrangler secret put CDP_API_KEY_SECRET
   ```
   A CDP *Secret API Key* is base64 of 64 bytes — a 32-byte Ed25519 seed
   followed by its public key. The older EC/PEM format is not supported; if
   yours begins `-----BEGIN`, mint a new one.
   Without both, calls are still served (availability-first) but carry
   `x-payment-verified: false` and `x-payment-error: facilitator-unconfigured`,
   and every one is recorded in `settlements`.
6. Optional alerts (secrets):
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   npx wrangler secret put ALERT_EMAIL_TO
   ```
   `ALERT_EMAIL_TO` must be a **verified** Email Routing destination on the
   sending zone. Unset is a working state: a channel with no config is skipped
   before any network call.
7. Set `HOUSE_PAYERS` in `wrangler.toml` to your own test wallet(s), so your own
   test buys read as a drill rather than as a sale. Unset means every payer reads
   as a third party, which fails **too loud** — the right direction here.
8. Deploy the Worker and the static surface:
   ```bash
   node build.mjs          # self-lints, then writes dist/
   npx wrangler deploy
   npx wrangler pages deploy dist --project-name tenx402
   ```
   The Pages project must have **zero Functions**: the Worker owns `/check`,
   `/lint` and `/lint/*` through routes, and a Function would shadow them.
9. Add an edge rate-limiting rule covering the paid paths — the Worker's own
   limits execute *inside* the Worker, so a request they reject is already
   billed:
   ```
   (http.host eq "10x402.com" and
    (http.request.uri.path eq "/lint" or starts_with(http.request.uri.path, "/lint/")))
   ```
   `GET /check` is deliberately left out: it touches no D1 and does no work.

### Verifying a deploy

```bash
curl -sS https://10x402.com/check | head -40
curl -sS -i -X POST https://10x402.com/lint -H 'content-type: application/json' -d '{}' | head -20
```

The second must be a `402` carrying a `payment-required` header. The self-lint
already proved the envelope is conformant before `dist/` was written, so what
these two commands verify is the *deploy*: that the routes are wired, the zone
resolves, and `PAYTO` is set (a `429` here means it is not).

### Reading the ledger

```sql
-- did anyone actually pay
SELECT ts, endpoint, payer, amount, verify_ok, settle_ok, tx_hash, error
FROM settlements ORDER BY ts DESC LIMIT 50;

-- money that moved
SELECT COUNT(*), SUM(CAST(amount AS INTEGER)) FROM settlements WHERE settle_ok = 1;

-- revenue leaking: served, never checked
SELECT ts, endpoint, error FROM settlements
WHERE verify_ok = 0 AND error LIKE 'facilitator-%' ORDER BY ts DESC;

-- is the catalogue finding anything
SELECT grade, COUNT(*) FROM lints GROUP BY grade ORDER BY grade;
```

A grade distribution that is all A is a linter that has stopped looking; one
that is all F is a catalogue that is wrong.

### Retention chores

There is no `scheduled` handler by design — zero crons. Prune periodically:

```sql
DELETE FROM call_quota WHERE day < date('now', '-7 days');
DELETE FROM lints WHERE ts < unixepoch('now', '-180 days');
```

`settlements` is **kept**: it is the revenue record, and `payer` and `tx_hash`
are public chain data an owner revealed by paying.

## Chassis

Derived from [`lemon-toolshed`](https://toolshed.lemon-agent.dev) — the Worker
layout, the 402-first flow, the CDP facilitator and its hand-rolled Ed25519 JWT,
the alerts module, the D1 discipline, and the phased test harness with its
strict per-version mock facilitator. That code has taken two real settlements on
Base, which is why it was worth copying rather than rewriting.

**Extraction into a shared library is deliberately deferred.** Two services is
not enough to know which parts are the chassis and which are one service's
opinion; a premature `@lemon/x402-worker` would freeze the wrong seam, and
copying twice is cheaper than un-abstracting once. Revisit at three.

What changed semantically rather than in name:

- **`V1_BODY_PRESENT` split from `V1_BODY_JSON`** in the engine — absence of an
  envelope is a warning, a broken one is a core error. (New here; the chassis
  has no linter.)
- **`PAYTO_TEST` is a structurally valid address.** The chassis used
  `0xTEST000…`, which is fine when nothing reads it. Here the Worker's own 402 is
  fed through this repo's own linter, and `V1_PAYTO`/`V2_PAYTO` would fail on a
  payTo that is not 40 hex characters — taking the flagship invariant down for a
  reason that has nothing to do with the product.
- **`alerts.js` split into `alert-message.js` (pure) and `alerts.js`
  (channels).** The chassis has one file; importing it into Node pulls in
  `cloudflare:email`, which only workerd can resolve.
- **Nothing is exported from the entry module but the handler.** The chassis
  exports only `default` already; adding a constant for the suite fails the
  Worker at *startup* with `Incorrect type for map entry` — a total outage from
  what looks like a convenience.
- **The `lints` telemetry table** and the SSRF guard are new: this service makes
  an outbound request on a caller's behalf and the chassis does not.
- **A pure test phase that boots no worker**, because most of this product is a
  pure function and the chassis's product is not.

## Licence

Not yet chosen.
