# 10x402

*("ten-ex-four-oh-two")*

**Your 402 works. Agents still can't pay you.**

Ship a correct 402 → get indexed → get paid. 10x402 finds the conformance
blockers between those steps and gives you a specific fix for each finding. It
does not promise demand, a Bazaar listing, or a successful payment; it shows you
what in the published 402 can prevent them.

**Status: live at [10x402.com](https://10x402.com) since 2026-08-20.** Zero
third-party revenue to date — the only settlements so far are the house's own
priming and alert-proof calls, and this README will keep saying so until that
changes.

---

## Why a working x402 endpoint can still be undiscoverable

An endpoint can pass `validate`, return a 402, and still not be indexed. The
validator, a client, a facilitator, and Bazaar discovery do not all inspect the
same parts of the response. The failure often shows up as a missing listing, an
agent that cannot read the payment terms, or a payment signature that will not
verify:

- A **url-safe base64** v2 envelope can be discarded by the client *before* it
  is decoded — clients validate against `/^[A-Za-z0-9+/]*={0,2}$/` first — so
  the agent behaves as though no payment terms were published.
- A `bazaar.info` that does not validate against its own `bazaar.schema` is
  a discovery blocker even when the base envelope validates.
- A missing `extra.name` / `extra.version` can make a genuine payment fail as
  `invalid_exact_evm_payload_signature` when the client and facilitator build
  different EIP-712 domains.
- A **free tier** hands the discovery prober a 200 instead of the 402 it expects.
- A `maxAmountRequired` left in a v2 accepts entry means a v2 client reads
  `amount`, finds `undefined`, and has no price to sign against.

10x402 turns those absences into named findings and concrete changes. Its
82-check catalogue covers the HTTP response, x402 v1 and v2, dual-stack
consistency, version hygiene, Bazaar metadata, and two safeguards that disclose
when the report itself had to stop or truncate work. Every check names the
specification section, client source line or CDP requirement its rule comes
from — and where the honest answer is a house opinion, it says that instead.

## The self-lint invariant

**The test suite lints the 402 that the Worker actually serves. Every build also
self-lints all eight paid endpoint envelopes and fails on any finding.**

`test/self-lint.test.mjs` takes 10x402's *own* 402 — for all eight paid
endpoints, in the production configuration, off the wire through wrangler and
workerd — and runs it through 10x402's *own* lint engine. It must grade **A with
zero findings**, info included. Separately, `node build.mjs` constructs all eight
production envelopes, runs the same engine, and refuses to emit `dist/` if any
of them has a finding.

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

## What you lint is your business

The application store keeps no linted URLs, no pasted envelopes, and no reports.
It retains the endpoint id (`lint`, `lint-one`, `presence`, `lint-envelope`,
`lint-envelope-one`, or one of the three `monitor-*` routes), grade (for
`presence`, only the count of registries that listed the target; for the monitor
routes, only which SHAPE of answer was served — `monitor:probed`,
`monitor:readings-only`, `monitor:series`, `monitor:receipt`), and error/warning
counts as aggregate product telemetry, plus the quota and payment records needed
to operate the service. It does not persist the material being linted, and it
never records which host a monitor call asked about.

## Start here

Once the service is deployed, a person can inspect the complete checklist and
prices without paying:

```bash
curl -sS https://10x402.com/check
```

An agent should read [`skills/10x402/SKILL.md`](skills/10x402/SKILL.md) or the
generated `/skill.md`, then call the free `x402_checks` tool before choosing a
paid lint. Use `/lint` for a public URL and `/lint/envelope` for a response you
already captured from local, staging, or authenticated code — and the `/one`
form of either when there is exactly one check you want the answer to.

## What it does

| route | price | what it does |
|---|---|---|
| `POST /lint` | **$0.10** | Probes a URL you name — one unauthenticated request plus one negative-control GET to an impossible path — and lints the result against all 82 checks. |
| `POST /lint/one` | **$0.008** | The same outbound request, reported for **one** check you name. |
| `POST /presence` | **$0.06** | Where the resource stands with the registries: fetches your 402, reads the payTo and resource it declares, then checks the full CDP Bazaar catalog, the x402scan explorer, and the payTo's own chain — USDC settlement activity on Base for a `0x` address, recent signature activity on Solana for a base58 one. Per-registry verdict with evidence; a surface that cannot be read reports `unknown`, never a guessed `not_found`. |
| `POST /lint/envelope` | **$0.04** | The same catalogue over a response you paste. No outbound request, so it works on staging, on localhost, and on an endpoint that is not deployed yet. |
| `POST /lint/envelope/one` | **$0.004** | One named check over a response you paste. The cheapest answer here. |
| `POST /monitor/verdict` | **$0.005** | Parallax: what the three rating instruments said about a host on the latest stored day, what the endpoint answered to an unpaid request on its **declared verb** and on GET, and the read-time flags. `as_of`-stamped; a stored probe older than 36 h is reported as stale rather than as current. |
| `POST /monitor/history` | **$0.03** | Every day this wing has held for one host — readings and probes, oldest first. |
| `POST /monitor/receipt` | **$0.12** | The dispute pack: the series, the contradiction stated in numbers, a SHA-256 digest over the canonical JSON, and an attestation naming the probe method, the UA, and that no payment was ever sent. |
| `GET /monitor` | **free** | The wing index: the latest capture day, the contradiction and wrongly-dead counts, and the contradictions carrying the most settled volume. JSON, or HTML with `Accept: text/html`. |
| `GET /monitor/{host}` | **free** | One host, today: the three instruments side by side, the two-verb probe, the flags. No history — that is the paid route. JSON or HTML. |
| `GET /check` | **free** | Service info, the full check catalogue by code, prices, the grade ladder. |

**The two scopes are two products, bought at two different moments.** A full
report is bought during an incident: a 402 that passes validate and still is not
indexed is the class of problem that eats weeks, because nothing in the stack
says which of the 82 things is wrong. $0.10 is priced against that, and it is
still a fraction of the $25 a signed conformance report costs. A single check is
bought in a test and then again on every commit — it is the CI and regression
product, and it stays micro because a regression product that is not cheap does
not get run.

**The multiples fall out of that rather than being designed.** A full 82-check
report costs 12.5x one check on a live URL and 10x on a pasted response — a 6x
and 7.5x per-check advantage. Singles stay the cheaper buy through 12 questions
live and 9 pasted; past that, buy the report. The two rails differ because the
prices do, which is why every surface computes one multiple per rail rather than
averaging them into a number true of neither — the sentence above is generated
from `BATCH_MULTIPLES` in `worker/catalog.js`, never typed. `GET /check`
publishes the same figures, free, before anyone pays for anything.

The pasted rail is cheaper than the live rail at both scopes, because there is
no outbound probe to make on the caller's behalf. Every price is per **served**
report: a bad URL, an unreachable target, a malformed paste or an unknown check
id settles nothing, even when the payment verified.

The two full-report endpoints return the same shape:

```json
{
  "grade": "F",
  "summary": {
    "versions_detected": [1, 2],
    "payTo": "0x…",
    "network": "eip155:8453",
    "price": "$0.001 (1000 atomic)",
    "bazaar_ready": false,
    "blockers": ["V2_BAZAAR_INFO_VALIDATES"]
  },
  "findings": [
    {
      "severity": "error",
      "code": "V2_B64_URLSAFE",
      "core": true,
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

### One check, and the third outcome

The two `/one` routes take the same body plus a required `check` — exactly one
id from `GET /check` — and answer about that check alone:

```json
{
  "check": "V2_B64_URLSAFE",
  "applied": true,
  "passed": false,
  "finding": { "severity": "error", "code": "V2_B64_URLSAFE", "message": "…", "fix": "…" },
  "regime": "payment",
  "sources": [ { "kind": "client-code", "ref": "…" } ],
  "summary": { "versions_detected": [1, 2], "payTo": "0x…", "network": "eip155:8453", "price": "…" },
  "checks_run": 1
}
```

**`passed: null` with `applied: false` is not a pass.** A v2 check against a
v1-only endpoint did not run at all, and saying "V2_B64_URLSAFE passed" about a
response with no v2 header is the most expensive false negative this service
could sell — so it says what did not happen instead, in `note`. `checks_run` is
1 or 0 on the same rule the full report uses: how many checks *applied*.

A single-check answer deliberately carries **no `bazaar_ready`**. That verdict
is computed over every bazaar-regime check, and this caller bought one check;
the envelope description stays because it is context for the answer rather than
a second answer.

An unknown or missing `check` is a 400 naming the free catalogue. It lints
nothing, settles nothing, and hands back the single-use claim on the payment —
the caller can retry with a real id against the same authorization.

## Two verdicts, because there are two questions

A 402 can be perfectly payable and completely un-indexable at the same time.
For a long time this catalogue answered both with one letter, which meant it
answered neither: a bazaar metadata problem dragged a working endpoint down to a
D, and a seller reading "D" went looking for a payment bug that was not there.

| field | question | computed from |
|---|---|---|
| `grade` | can I be **paid**? | payment-regime findings only |
| `summary.bazaar_ready` | can I be **found**? | bazaar-regime errors, listed in `summary.blockers` |

`bazaar_ready` is `true`, `false`, or `"n/a"` for a v1-only endpoint, whose CDP
requirements are a v2 shape.

**Grade A with `bazaar_ready: false` is the commonest interesting report this
service produces.** It is exactly the situation people describe as "my endpoint
passes validate but is not indexed", and it is the one a single letter cannot
say.

## The three regimes

Every check declares which authority it answers to, because a rule is only true
relative to one.

| regime | checks | authority | effect |
|---|---|---|---|
| `payment` | 49 | the specs' MUSTs, and what @x402/core, @x402/evm, x402-fetch and x402@1.2.0 actually parse, throw on or refuse to sign | sets the grade |
| `bazaar` | 20 | CDP's validator, prober and seller docs | sets `bazaar_ready`; never the grade |
| `hygiene` | 6 | house opinion and client-quirk defense | info only, always |

Only a payment-regime check can be `core`, and a core failure is the only thing
that produces an F.

## Provenance: every rule says where it came from

Each check carries a `sources` array, published at `GET /check` and rendered on
the page under the rule it justifies:

```json
{
  "id": "V2_MAX_TIMEOUT",
  "regime": "payment",
  "severity": "error",
  "core": true,
  "sources": [
    { "kind": "spec", "ref": "specs/x402-specification-v2.md:129 § 5.1.2 — maxTimeoutSeconds, type number, Required" },
    { "kind": "client-code", "ref": "@x402/core@2.23.0 dist/cjs/schemas/index.js:107 — maxTimeoutSeconds: z.number().positive(), required, no coercion" },
    { "kind": "client-code", "ref": "@x402/evm@2.23.0 dist/cjs/index.js:539 — validBefore is computed from it; undefined yields BigInt(\"NaN\"), which throws" },
    { "kind": "cdp-validator", "ref": "cdp-validator-toolshed.json preflight[13] accepts[0].maxTimeoutSeconds (required)" }
  ]
}
```

The kinds are `spec`, `client-code`, `cdp-docs`, `cdp-validator`, `live`,
`field-report` and `house-opinion`. `house-opinion` is a first-class entry rather
than an embarrassment: labelling an opinion as one is what makes the other
citations mean anything. The module refuses to load a check with no sources, so
an uncited rule cannot ship.

The refs are exact and package-relative, which makes a source moving a greppable
event rather than a slow rot: when @x402/core changes its network schema,
`grep -l 'schemas/index.js' worker/lint.js` finds every rule that has to be
re-argued.

## The portable corpus, and a second implementation

`corpus/` holds a **tool-neutral conformance corpus**: 34 recorded 402 responses,
each with three independent expectations — can it be paid under the specification,
will the cited clients parse and execute it, is its registry declaration eligible
at a named provider — plus dimension-scoped evidence behind each one. Nothing in
`corpus/fixtures.json` names a check id or a grade, so any implementation can run
it by writing an adapter. Format spec: [`corpus/FORMAT.md`](corpus/FORMAT.md);
machine-readable shapes in `corpus/schema/`.

It exists because of
[x402-foundation/x402#3104](https://github.com/x402-foundation/x402/issues/3104),
where the x402-doctor proposal and this project turned out to have hit the same
failure modes independently. The corpus is the shared ground; the outcome is
[`DISAGREEMENTS.md`](DISAGREEMENTS.md) — both implementations run over the same
cases, with **no winner declared**.

Six defects in 10x402 were found this way and all six are written up there: two in
the engine, by running the other implementation over our own fixtures, and four in
the corpus itself, by a pre-publication accuracy review
([`CORPUS-REVIEW.md`](CORPUS-REVIEW.md)) that found house rules and provider
observations deciding dimensions the format reserves for the specification. Format
v2 is the repair, and it is mostly a narrowing of what the corpus claims.

The test phase asserts that `corpus/run-10x402.mjs` reproduces every published
expectation, that regenerating the corpus produces the committed file byte for
byte, and that the engine on disk is the engine the corpus pins — so what this
repo ships and what it claims cannot drift apart.

```sh
node corpus/build-fixtures.mjs        # regenerate corpus/fixtures.json (deterministic)
node corpus/run-10x402.mjs            # → corpus/results-10x402.json
node corpus/run-x402-doctor.mjs       # clones the prototype to a temp dir
node corpus/report-disagreements.mjs  # → DISAGREEMENTS.md
node corpus/validate-results.mjs corpus/results-10x402.json   # third-adapter conformance test
```

## The x402 conformance checklist: 82 published checks

The catalogue is published in full at `GET /check` and on the page before anyone
spends anything. Eighty checks inspect HTTP and x402 conformance; two
report safeguards disclose truncated input or findings instead of letting a
partial report read as clean.

| area | checks | what it covers |
|---|---|---|
| `http` | 8 | 402-for-unauthenticated, free-tier 200s, 5xx, redirects, JSON content-type — and the x402#3104 negative control: whether the host tells a real route from an impossible one, and whether it soft-404s |
| `v2` | 44 | the `PAYMENT-REQUIRED` header envelope: base64 encoding, network identifiers and their address families, `amount`, the resource object, the EIP-712 domain, and `extensions.bazaar` down to its input union, its schema's own content rules, and info/schema agreement — including the wrong-parameter-bag contradiction from the x402#3104 census |
| `v1` | 21 | the 402 body envelope: `maxAmountRequired`, the closed plain-name network enum, the `exact`-only scheme enum, the flat-string resource, `outputSchema.input.discoverable` — and whether there is a v1 envelope at all |
| `dual` | 5 | when both are published, offers are matched on (chain, asset) and then compared on payTo, price and resource |
| `version` | 2 | a v1 payload in the v2 header, or the reverse |
| `report` | 2 | what the linter itself did not read: a long `accepts[]`, a clipped body, a capped report |

### What a report is NOT allowed to do

Four properties the catalogue holds to, because a linter that gets them wrong
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
- **The WORK is bounded too, not just the report.** A `bazaar.schema` is
  caller-supplied, and `anyOf` around a `$ref` cycle describes an exponential
  number of paths through a document whose size is linear — 454 bytes bought
  8.9 seconds of CPU. Validation now has a node budget, and says when it stops.
  A 256 KB cap on the answer is not much use if producing it can be made to
  cost ten seconds of isolate.

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
- **One authorization buys one report.** Verifying a payment is a *read* — the
  facilitator answers the same way however often it is asked, and nothing moves
  until settle, which runs after the response. So a single-use claim on the
  presented payment is taken between verify and the work; the loser of the race
  gets a 402 naming the reason and writes no ledger row.
- **Bytes are not an event.** A payment header that does not decode is answered
  with the same 402 an unpaid caller gets — no store access, no facilitator
  call, no `settlements` row. That table is the revenue record, and it means
  "we talked to a facilitator about this", never "someone sent us bytes".
- **Alerts.** Telegram and email when money moves, fired from `ctx.waitUntil`
  after the response, each channel independently caught. Probe noise never
  pages, and each channel has a daily budget so a bad hour cannot mute the
  channel permanently.

## Layout

```
worker/
  worker.js            routing, the 402 flow, quotas, D1, telemetry
  lint.js              THE PRODUCT — 82 checks, pure, no Worker globals
  json-schema.js       a JSON Schema subset, for bazaar info-vs-schema
  catalog.js           endpoints, prices, samples — the single source
  envelope.js          10x402's own v1 + v2 envelopes
  positive-control.js  a real 402 captured from a live seller (frozen)
  presence.js          POST /presence — two registry reads and a chain read
                       chosen by the payTo's address family (Base, or Solana)
  presence-control.js  a real registry observation, frozen, for the sample
  monitor.js           PARALLAX SUBSTRATE: the two crons. Fetches, probes,
                       writes. Never reached from the request path.
  monitor-surfaces.js  PARALLAX SURFACES: the free reads and the three paid
                       routes. Reads D1 and NOTHING else — no fetch, ever.
  monitor-control.js   one real captured day, frozen, for the monitor samples
  sha256.js            a synchronous SHA-256, for the receipt digest (see the
                       note in its header — sampleOutput cannot await)
  fetch-target.js      the SSRF-guarded outbound fetch
  x402.js              CDP facilitator verify/settle, the Ed25519 JWT
  quota.js             the atomic daily claim, written once for four ceilings
  alert-message.js     what an alert says (pure; RFC 5322)
  alerts.js            how it is sent (Telegram, send_email binding)
  schema.sql           D1: salt, counters, call_quota, payment_seen,
                       settlements, lints, monitor_readings, monitor_probes,
                       monitor_days
build.mjs              generates dist/ and runs the self-lint
mcp/server.mjs         MCP server; a 402 is a price quote, never isError
skills/10x402/         a drop-in agent skill
test/                  nine phases, 1086 tests, no live or billed calls
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

1086 tests in nine phases, in two to three minutes. **No live network calls and no
billed calls, ever** — the facilitator, Telegram, the lint targets, the registries
and chain RPCs, the three rating instruments and the probed sellers are all http
servers the suite runs on 127.0.0.1, and the CDP credentials are generated per run
and worth nothing.

| phase | tests | what |
|---|---|---|
| engine | 605 | pure functions: the lint engine against fixtures, the JSON Schema subset, the SSRF URL rules, the positive control, the price sheet. **Boots no worker** — if the engine is wrong, every later phase is measuring the wrong thing, and 0.1s beats four worker boots. |
| served calls | 135 | `/check`, `/lint/envelope`, and the SSRF guard through the live Worker in its **shipped** configuration |
| outbound lint | 71 | `/lint` against mock target servers, with the guard relaxed by `LINT_UNSAFE_TARGETS` |
| presence | 23 | `/presence` against mock registries on 127.0.0.1, including the Solana chain leg: the JSON-RPC request it sends, and that its evidence never borrows the EVM leg's transfer language |
| monitor substrate | 50 | the Parallax crons: three mock instruments, mock sellers, and both crons through the Worker's real `scheduled()` via `--test-scheduled` |
| monitor surfaces | 55 | `/monitor`, `/monitor/{host}` and the three paid routes over **seeded** D1 rows — the three host-page states, the NULL-vs-0 vocabulary, and HTML escaping of third-party text |
| production default | 87 | the 402 front door for all eight paid routes, and **the self-lint invariant** |
| settlement | 29 | verify/settle against a strict per-version mock facilitator |
| alerts | 31 | mock facilitator + mock Telegram, and the RFC 5322 message |

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

`POST /lint` and `POST /lint/one` make a request on a stranger's behalf, which
is the whole threat model: a caller who can name a URL and see the response has,
for two cents, rented our network position. So:

- **https only**, no credentials in the authority
- **ports 443 and 8443 only** — anything else and the service is a port scanner
  rented by the call: the difference between "connection refused" and "timed
  out" *is* the scan result. For the same reason the underlying transport error
  is never quoted back, only "could not reach `<host>`"
- **no private or reserved targets** — loopback, RFC 1918, link-local
  (including the cloud metadata address), CGNAT, ULA, IPv4-mapped IPv6,
  IPv4-compatible IPv6 (`::7f00:1` is 127.0.0.1) and NAT64 (`64:ff9b::/96`,
  which embeds an IPv4 address for a gateway to unwrap)
- **no private-network names** — `localhost`, `*.internal`, `*.local`,
  `*.home.arpa`, and bare hostnames with no dot. A trailing dot is stripped
  first: `localhost.` is the same name and used to walk past every rule here
- **no redirects followed** (`redirect: 'manual'`) — the classic bypass, and a
  real finding for the seller, so it is reported rather than chased
- **one request**, no retry, no preflight
- **256 KB** read cap, streamed and counted rather than buffered whole
- **10s** for the whole call — connect, headers *and* the body read, on one
  deadline. Bounding only the connect is slow-loris-shaped: a target that
  answers instantly and then dribbles held a Worker open for 300s against a
  700ms deadline before this was one clock

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

`payment_seen` holds one SHA-256 per verified payment and a timestamp — a
one-way function of the payload, never the payload, which is a signed
authorization and belongs in a table that exists to hold a boolean about as
much as a URL belongs in `lints`. A test asserts those two columns are all
there are.

## Deploy runbook

**Not yet done.** The order below is not a suggestion — see the ordering note
after step 6.

1. **Register `10x402.com`** and add the zone to the Cloudflare account. Do not
   add the routes yet; step 7 does that, and the reason is the ordering note.
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

   > **SET THESE BEFORE THE ROUTES EXIST. A HARD ORDERING.**
   >
   > A route with no CDP credentials behind it is a live, publicly listed
   > endpoint that serves every paid call for free — availability-first is
   > deliberate and correct once payments work, and is a giveaway before they
   > do. The window is however long it takes to run two `wrangler secret put`
   > commands, and x402 endpoints are scanned continuously: an unpriced one does
   > not stay unnoticed for the length of a coffee break.
   >
   > The `settlements` table records every one of these — the "revenue leaking"
   > query below is exactly this state — and the alert fires on the first. That
   > is a detection mechanism, not a mitigation. Do not go looking for it.

6. Optional alerts (secrets):
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   npx wrangler secret put ALERT_EMAIL_TO
   ```
   `ALERT_EMAIL_TO` must be a **verified** Email Routing destination on the
   sending zone. Unset is a working state: a channel with no config is skipped
   before any network call.
   The alert channels have a daily budget of 20 sends each (`ALERT_DAILY`).
   The send that trips it says so and then the channel is quiet until UTC
   midnight; `settlements` still has everything.
7. Set `HOUSE_PAYERS` in `wrangler.toml` to your own test wallet(s), so your own
   test buys read as a drill rather than as a sale. Unset means every payer reads
   as a third party, which fails **too loud** — the right direction here.
8. **Only now** add the routes in `wrangler.toml`, and deploy:
   ```bash
   PUBLIC_POSTHOG_KEY=phc_... node build.mjs   # self-lints, then writes dist/
   npx wrangler deploy
   npx wrangler pages deploy dist --project-name tenx402-site --branch main
   ```
   The Pages project is `tenx402-site`, NOT `tenx402` — this line said the
   latter until a deploy on 2026-08-24 answered `Project not found`. `tenx402`
   is the D1 database in steps 3-4; the two are different things with confusable
   names, and `wrangler pages project list` is the authority.

   `PUBLIC_POSTHOG_KEY` is optional and build-time only — omit it and `dist/`
   ships with no analytics, which is the right answer for a local build. See
   § Measuring the funnel.
   The Pages project must have **zero Functions**: the Worker owns `/check`,
   `/lint`, `/lint/*`, `/presence*` and `/monitor*` through routes, and a
   Function would shadow them.

### The presence reads

**Nothing to configure.** All four surfaces `POST /presence` reads are free and
keyless — the CDP discovery catalog, the x402scan explorer, Blockscout, and the
public Solana JSON-RPC — so the route works on a fresh deploy with no secret set.

**Which chain gets read is decided by the payTo's ADDRESS SHAPE**, never by the
declared `network`: the declaration is the thing under examination, and a seller
whose network string is wrong is exactly who buys this report. `0x` + 40 hex is
read on Base through Blockscout; a base58 address of 32–44 characters is read on
Solana. Anything else — a role constant like `"merchant"`, an ENS name — reports
`unknown` with the reason named, because "we did not look" is the honest answer
and `none_seen` would be a claim about a chain nobody queried.

**The two legs measure different things, and the report says so.** Base is read
through `tokentx` — USDC transfers that ARRIVED, so `summary.settlement_seen` is
a real yes or no. Solana is read through `getSignaturesForAddress`, which returns
transactions that MENTION the address in any role and either direction: that
shows the address is in use and cannot show that anything settled to it. On a
Solana payTo `settlement_seen` is therefore **null** whatever the leg saw, the
evidence carries a `measures` line saying what was counted, and a failed
transaction still counts as activity — it was signed, submitted and paid for.

**Optional vars.** `PRESENCE_BAZAAR_BASE`, `PRESENCE_SCAN_BASE`,
`PRESENCE_CHAIN_BASE` and `PRESENCE_SOLANA_BASE` are test seams (mock registries
on 127.0.0.1) and are never set in production. `PRESENCE_SOLANA_BASE` is the
whole RPC endpoint URL rather than a host, because JSON-RPC posts every method to
the same address; it defaults to `https://api.mainnet-beta.solana.com`.

### The monitoring wing (Parallax)

The design doc is [`MONITOR.md`](MONITOR.md); this is the operational half.

**The schema step covers it, but only if you ran step 3 after 2026-08-27.**
`monitor_readings`, `monitor_probes` and `monitor_days` are additive tables in
`worker/schema.sql` and every statement in that file is `IF NOT EXISTS`, so
re-applying it on a live database is safe and is how an existing deployment
gets them:

```bash
npx wrangler d1 execute tenx402 --remote --file worker/schema.sql
```

**Two crons, already in `wrangler.toml`.** `17 11 * * *` captures the three
instruments; `47 11 * * *` derives the day's roster and probes it. Both are UTC,
both are idempotent per day, and the strings are duplicated as constants in
`worker/monitor.js` — a test reads the TOML and fails if they drift apart.
Nothing prunes: the daily series is what the wing sells.

**The route.** One pattern, `10x402.com/monitor*`, covers the free index, every
`{host}` lookup and the three paid paths, including query strings. It has to be
a wildcard because `/monitor/{host}` is dynamic — there is no finite set of
exact patterns to write.

**Paid-plan assumption.** The capture makes ~18 subrequests and the probe at
most `MONITOR_PROBE_CAP × 2` (default 400 → 800), against the paid plan's 1000
per invocation. On the free plan the ceiling is 50 and both crons would die
part-way; the wing assumes the paid plan this account is already on.

**Optional vars.** `MONITOR_PROBE_CAP` (default 400, clamped to 900),
`MONITOR_HOUSE_HOSTS` (a comma list added to the always-probed set —
`10x402.com` is hardcoded), `MONITOR_AE_BASE` / `MONITOR_AT_BASE` /
`MONITOR_TIMEOUT_MS` (test seams; never set in production).

**First-day behaviour is a real state and is served as one.** Before the first
capture, `GET /monitor` answers 200 with `state: "no-capture"` and says so;
between each capture and its probe half an hour later, `wrongly_dead` is **null**, which means "not
probed yet" and never zero. Watching a deploy:

```bash
curl -sS https://10x402.com/monitor | jq '{state, as_of, counts}'
npx wrangler tail --format pretty        # each cron logs one line: monitor: cron … → {…}
```

```sql
-- what the day actually captured, and whether the probe half has run
SELECT day, population, captured_ae, captured_at, captured_bazaar,
       roster_size, wrongly_dead, contradictions
FROM monitor_days ORDER BY day DESC LIMIT 7;

-- the finding, per day: dead at the rater, answering 402 on its declared verb
SELECT r.day, r.host, r.ae_settled_14d, p.declared_method, p.declared_status, p.get_status
FROM monitor_readings r JOIN monitor_probes p ON p.day = r.day AND p.host = r.host
WHERE r.ae_uptime = 0 AND p.declared_status = 402
ORDER BY r.day DESC, r.ae_settled_14d DESC LIMIT 20;
```

**The prober is polite and legible on purpose.** Every request carries
`10x402-monitor/0.1 (+https://10x402.com/monitor)`, follows no redirects, reads
at most 4 KB, and **never sends a payment**. If an operator complains, that UA
is greppable in their log and the receipt endpoint publishes the same string.

### About rate limiting at the edge

An earlier version of this runbook ended with "add an edge rate-limiting rule
covering the paid paths", on the reasoning that the Worker's own limits execute
*inside* the Worker, so a request they reject is already billed. That reasoning
is still correct. **The mitigation is not available on this account**, and a
runbook step nobody can perform is worse than no step: it reads, to the next
person, as a control that is in place.

So the bounds are all in the Worker, and they are written to be worth having
without an edge in front of them. In the order a request meets them:

| bound | what it stops |
|---|---|
| the 402 fast path | a scanned public endpoint costs no store access at all |
| an undecodable payment header | answered like the fast path — no D1 write, no facilitator call, no ledger row. Bytes are not an event |
| the global daily counter | a doomsday day, before it spends anyone's personal allowance |
| `VERIFY_DAILY` (50/caller/day) | the outbound-call amplifier: a payload that merely *decodes* is free to produce and costs us an Ed25519 signature and a POST to CDP |
| `payment_seen` | one verified authorization buying more than one report |
| `PAID_DAILY` (2000/caller/day) | runaway served work |
| `ALERT_DAILY` (20/channel/day) | a bad hour muting the notification channel forever |

Each of those is a *billed* request that we answer cheaply, which is the honest
statement — not that they are free. `GET /check` touches no D1 and does no work,
and is deliberately outside all of it.

### Verifying a deploy

```bash
curl -sS https://10x402.com/check | head -40
curl -sS -i -X POST https://10x402.com/lint -H 'content-type: application/json' -d '{}' | head -20
```

The second must be a `402` carrying a `payment-required` header. The self-lint
already proved the envelope is conformant before `dist/` was written, so what
these two commands verify is the *deploy*: that the routes are wired, the zone
resolves, and `PAYTO` is set (a `429` here means it is not).

### Measuring the funnel

The ledger says what was earned. It cannot say what was nearly earned, because
the interesting failures here never write a row: a 402 that nobody pays, a
crawler that reads `/check` every hour and never buys, an indexer prober that
quietly stopped calling. That is what PostHog is for, and it is off by default.

```bash
npx wrangler secret put POSTHOG_PROJECT_TOKEN   # the Worker: quotes and sales
PUBLIC_POSTHOG_KEY=phc_... node build.mjs       # the page: humans who read it
```

Both take the same `phc_` project token. Neither is required — unset is a
working state on both halves, checked before any network call, and the suite
never sets either, so `npm test` makes no live PostHog call by construction.

The two halves measure different audiences and the split is the point. The
snippet in `dist/` sees people: someone who searched *"x402 402 not showing in
bazaar"*, landed here, and either found the answer in the checklist or did not.
The Worker sees **customers** — every agent call, sent as `$http_log` so
PostHog's own traffic classification (`isLikelyBot`, `getBotName`,
`getTrafficType`) can split AI crawlers from AI assistants from indexer probes.
On a service whose entire market is programs, the browser half is the smaller
half; a program runs no JavaScript and appears in no page-based analytics at
all.

Three business events ride alongside the logs, all derived from the response
headers the caller was already sent — `handlePaid` has no analytics code in it
and no new failure mode:

| Event | When | The question it answers |
| --- | --- | --- |
| `x402 quote issued` | a `402` from a paid route | how many agents got as far as a price, and whether any of them are *trying* to pay and failing (`reason`) |
| `x402 report served` | a `200` | how many bought, split by `tier` — `paid`, `free`, or `unverified` (served but the facilitator never confirmed it: revenue leaking) |
| `x402 call refused` | any other status | clients stuck in a loop of 400s or 429s — wanted to buy, could not, and nothing else records it |

`quote issued → report served (tier: paid)` is the whole business as one funnel.

Everything in `## Privacy` above still holds: no linted URL, pasted envelope,
report or raw IP leaves this Worker, `test/analytics.test.mjs` asserts it over
every event the module can emit, and caller grouping is a truncated hash of the
project token and the address, never stored.

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

There are two crons, and **neither of them prunes anything**: they are the
Parallax capture and probe (`MONITOR.md`), they write only the `monitor_*`
tables, and that history is the thing the monitoring wing sells. Retention on
the lint half below is still an operator chore. Prune periodically:

```sql
DELETE FROM call_quota  WHERE day < date('now', '-7 days');
DELETE FROM payment_seen WHERE created_at < unixepoch('now', '-7 days');
DELETE FROM lints       WHERE ts < unixepoch('now', '-180 days');
```

`payment_seen` holds one row per verified payment, so it grows with revenue
rather than with traffic. Seven days is far past any authorization's
`maxTimeoutSeconds` (60), so a pruned row can no longer be replayed — the
signature it belongs to expired six days earlier.

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
