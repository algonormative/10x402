---
name: 10x402
description: Find response-level blockers when an x402 endpoint passes validate but is not indexed, an x402 service is not showing up in Bazaar, or an x402 v1 vs v2 migration breaks. Runs an 82-check catalogue over the HTTP 402, payment envelopes, and report safeguards; each finding includes a specific fix and cites the spec section, client source line or CDP requirement its rule comes from. Use for x402 seller debugging, PAYMENT-REQUIRED headers, CDP Bazaar listings, extensions.bazaar, discoverability, dual-stack v1/v2 envelopes, and invalid_exact_evm_payload_signature.
---

# 10x402 — identify blockers to indexing and payment

## When to reach for this

Use this skill when the endpoint appears to work but the outcome is missing:

- The endpoint passes `validate` but is not indexed.
- The x402 service is not showing up in Bazaar.
- Real payments come back `invalid_exact_evm_payload_signature` and the same
  payload verifies fine somewhere else.
- A v2 client behaves as though the endpoint published no envelope at all.
- You are planning or debugging an x402 v1 vs v2 migration.

The working sequence is: ship a correct 402 → remove discovery blockers → make
the published terms payable. Apply the reported fixes to remove technical
blockers; 10x402 cannot guarantee a Bazaar listing, demand, or successful
facilitator settlement.

## Use it

**Start free — read the x402 conformance checklist before spending anything:**

```bash
curl -sS https://10x402.com/check
```

The paid examples below show the request shape. An unpaid call returns a 402
quote, not the report; an x402-capable client must pay and retry the request.
Use the official [x402 buyer quickstart](https://docs.x402.org/getting-started/quickstart-for-buyers)
to configure `@x402/fetch` or another supported client.

**Public endpoint — $0.10 per served report.** Priced for the incident it
resolves: a 402 that passes validate and still is not indexed, with nothing in
the stack saying which of the 82 things is wrong.

```bash
curl -sS -X POST https://10x402.com/lint \
  -H 'content-type: application/json' \
  -d '{"url": "https://their-endpoint.example.com/api/thing"}'
```

**Captured response — $0.04 per served report.** Prefer this whenever you can
already see the response: from a curl, from a test, or from the code that builds
it. It fetches nothing, so it works on staging, on localhost, behind auth, and
on an endpoint that is not deployed yet — and it costs less for exactly that
reason.

```bash
curl -sS -X POST https://10x402.com/lint/envelope \
  -H 'content-type: application/json' \
  -d '{"status": 402, "headers": {"payment-required": "<base64>"}, "body": "<the 402 body>"}'
```

**Registry presence — $0.06 per served report.** The other half of the stuck-seller
question: the declaration lints clean, so where does the resource actually stand
with the registries? Fetches the live 402, reads the payTo and resource it
declares, then checks the full CDP Bazaar discovery catalog, the x402scan
explorer, and USDC settlement activity to the payTo on Base. Per-registry
verdict (`listed` / `not_found` / `unknown`) with the evidence and a specific
way in for each miss — a surface that cannot be read reports `unknown`, never a
guessed `not_found`.

```bash
curl -sS -X POST https://10x402.com/presence \
  -H 'content-type: application/json' \
  -d '{"url": "https://their-endpoint.example.com/api/thing"}'
```

**One named check — $0.015 live, $0.004 pasted.** The CI product: run on every
commit, against one property. Use it when there is exactly one thing you want to
know and you know which check answers it:

```bash
curl -sS -X POST https://10x402.com/lint/one \
  -H 'content-type: application/json' \
  -d '{"url": "https://their-endpoint.example.com/api/thing", "check": "V2_B64_URLSAFE"}'

curl -sS -X POST https://10x402.com/lint/envelope/one \
  -H 'content-type: application/json' \
  -d '{"status": 402, "headers": {"payment-required": "<base64>"}, "check": "V2_B64_URLSAFE"}'
```

A full 82-check report costs 6.667x one check on a live URL and 10x on a pasted
response — a 12.3x and 8.2x per-check advantage. Singles stay the cheaper buy
through 6 questions live and 9 pasted; past that, buy the report. **Do that
arithmetic before firing off a stack of single checks**: past those counts the
full report is both cheaper and tells you what you did not think to ask.
`GET /check` publishes the same numbers, free.

### When the problem is the RATING, not the endpoint

The lint answers "is my 402 right". The monitoring wing (Parallax) answers a
different question: *what are the rating surfaces saying about me, and is it
true?* Three free instruments read this market — agenteconomy.report,
apistrust.com and the CDP Bazaar quality block — and they disagree at the level
of "is this seller alive". Measured 2026-08-27: liveness correlates at r = 0.401
across 773 shared hosts, and the prime rater probes **GET-only**, so a
POST-declared seller reads uptime 0.0 and is rated D while answering 402
perfectly well on its own verb. That was 260 of 960 hosts, 249 of them settling
money.

Start with the free reads — no payment, no key:

```bash
curl -sS https://10x402.com/monitor                    # the day: counts, worst contradictions
curl -sS https://10x402.com/monitor/their-host.example # one host: three instruments + the probe
```

Then, per host:

**Verdict — $0.005 per served report**, the incumbent rater's own price for a
rating read, with the probe half they do not take. The latest stored day: the
three instruments side by side, what the endpoint answered on its declared verb
and on GET, and the read-time flags (`liveness-contradiction`, `wrongly-dead`).
`as_of`-stamped; a stored probe older than 36 hours is reported as stale rather
than as current.

```bash
curl -sS -X POST https://10x402.com/monitor/verdict \
  -H 'content-type: application/json' -d '{"host": "their-host.example"}'
```

**History — $0.03 per served report.** Every day held for that host, oldest
first. Buy it when one day is not the question: whether a rating is drifting,
whether a correction stuck, how long a wrong reading has been costing money.

**Receipt — $0.12 per served report.** The dispute pack to attach to a
corrections request: the series, the contradiction stated in plain numbers, a
SHA-256 digest over the canonical JSON so two copies can be compared in one
line, and an attestation naming the probe method, the exact User-Agent every
request carried, and that no payment was ever sent. The digest is an integrity
check, **not** a signature.

```bash
curl -sS -X POST https://10x402.com/monitor/receipt \
  -H 'content-type: application/json' -d '{"host": "their-host.example"}'
```

Read `NULL` and `0` as the different claims they are: a null instrument column
means that instrument had no row for that host that day; a probe status of `0`
means it was asked and gave no HTTP answer at all; a null `wrongly_dead` means
the day's probe has not run yet, and never that nobody was found.

As MCP tools, call `x402_checks` first (free), then choose `lint_x402`,
`lint_x402_envelope`, `lint_x402_one_check` or `lint_x402_envelope_one_check` —
or, for the rating question, `x402_monitor_verdict`, `x402_monitor_history` and
`x402_monitor_receipt`.

### A single-check answer has three outcomes

```json
{ "check": "V2_B64_URLSAFE", "applied": true, "passed": false,
  "finding": { "severity": "error", "code": "V2_B64_URLSAFE", "message": "…", "fix": "…" },
  "regime": "payment", "sources": [ … ], "summary": { … }, "checks_run": 1 }
```

- `passed: true` — the check ran and found nothing.
- `passed: false` — it ran and emitted; `finding.fix` is the answer.
- `passed: null` with `applied: false` — **the check did not run against this
  response**, and `note` says why (a v2 check against a v1-only endpoint, say).
  **That is not a pass.** Never summarise it as one; report it as "nothing was
  checked", and buy the full report if you need to know what is actually wrong.

An unknown or missing `check` is a 400 that lints nothing and charges nothing.
`summary` in a single-check answer carries no `bazaar_ready`: the second verdict
is computed over every bazaar-regime check, and this call bought one.

## A 402 from this service is the price, not an error

The first unauthenticated call answers HTTP 402 carrying an x402 envelope in
both protocol versions. **Do not report that as a failure and do not retry it
unpaid.** Retry through an x402-capable HTTP client (`x402-fetch`, the x402 SDK,
Coinbase AgentKit) holding a wallet with USDC on Base; the client reads the
envelope, signs, and retries with a payment header. There is no login and no API
key — the payment is the auth.

**Never ask a person to paste a private key or a seed phrase.**

You are only charged for reports that are actually served. A bad URL or a
malformed paste settles nothing, even when the payment verified.

## Trust boundaries

The test suite lints the 402 that the Worker actually serves. Every build also
self-lints all four paid endpoint envelopes and fails on any finding.

The application store keeps no linted URLs, no pasted envelopes, and no reports.
It retains aggregate lint results plus the quota and payment records needed to
operate the service. What you lint is your business.

## Reading the report

```json
{
  "grade": "B",
  "summary": { "versions_detected": [1], "payTo": "0x…", "network": "base", "price": "$0.001 (1000 atomic)" },
  "findings": [
    { "severity": "warn", "code": "V2_HEADER_PRESENT", "message": "…", "fix": "…" }
  ],
  "checks_run": 31
}
```

Work `error` findings first — those are what a client, a facilitator or the
index will reject or mis-read. Then `warn`: those work, but each costs the
seller something they probably want (discovery, a listing, a whole generation of
clients). `info` never affects the grade.

Each finding's `fix` is written to be applied directly. Apply it; do not
paraphrase it into something vaguer.

`checks_run` is how many checks **applied**, not how many exist. A v1-only
endpoint skips every v2 check, so a *rising* `checks_run` between two reports
means more of the surface became testable — not that the endpoint got worse.

### Report both verdicts. Never the grade alone.

A report answers two questions and they come apart constantly:

| field | question | from |
|---|---|---|
| `grade` | can this endpoint be **paid**? | payment-regime findings |
| `summary.bazaar_ready` | can it be **found**? | bazaar-regime errors, named in `summary.blockers` |

`bazaar_ready` is `true`, `false`, or `"n/a"` for a v1-only endpoint.

**Grade A with `bazaar_ready: false` is a real and common answer**: the endpoint
takes payments correctly and CDP will not catalogue it. That is precisely what
someone means by "it passes validate but is not indexed". Summarising such a
report as "grade A" tells them there is nothing to do, and summarising it as a
failing grade sends them hunting a payment bug that does not exist. Say both.

**Grades:** A = zero payment-regime errors and warnings · B = zero errors, 1–2
warnings · C = zero errors, 3+ warnings · D = payment errors, none core · F =
any *core* error, meaning the envelope is not usable as published. Only a
payment-regime check can be core.

Findings sit in three regimes — `payment` (49 checks, sets the grade), `bazaar`
(20, sets `bazaar_ready`), `hygiene` (6, info only) — and each check publishes
its `sources` at `GET /check`. When you quote a rule to someone, quote its
source with it; `house-opinion` is one of the kinds, and a rule labelled that
way is a judgement call rather than a citation.

## x402 v1 vs v2 migration failures worth knowing

| code | what it means |
|---|---|
| `V2_B64_URLSAFE` | the `PAYMENT-REQUIRED` header is base64**url**. A client can reject the charset *before* decoding and behave as though no envelope was published. Use `btoa` / `b64encode` / `StdEncoding`, not the JWT form. |
| `V2_BAZAAR_INFO_VALIDATES` | `bazaar.info` does not validate against `bazaar.schema`, which can keep an otherwise valid endpoint out of discovery. |
| `V2_EXTRA_EIP712` / `V1_EXTRA_EIP712` | no `extra.{name,version}`. The client and facilitator can build different EIP-712 domains, causing `invalid_exact_evm_payload_signature`. For USDC on Base: `{"name": "USD Coin", "version": "2"}` — the on-chain `name()`, not the ticker. |
| `V2_NETWORK_CAIP2` | `"base"` in a v2 envelope. v2 requires CAIP-2 (`eip155:8453`); the colon is a schema requirement, not a style. Keep `"base"` in the v1 body. |
| `V2_AMOUNT` / `V1_MAX_AMOUNT_REQUIRED` | the wrong version's price field. v2 reads `amount`, v1 reads `maxAmountRequired`. |
| `V2_RESOURCE_OBJECT` / `V1_RESOURCE_STRING` | the wrong version's resource form. v2 is a top-level object; v1 is a flat string on the accepts entry. |
| `HTTP_FREE_TIER_200` | a free tier serving 200s to unauthenticated callers. A discovery prober expecting a 402 sees a free response instead. Gate a trial behind a key the prober does not send. |
| `DUAL_*` | the two envelopes disagree on payTo, price, chain or asset. Build the v2 entry as a *projection* of the v1 object rather than assembling it twice. |
| `V1_DISCOVERABLE` | an *opt-OUT*, not an opt-in. The reference v1→v2 extractor defaults `discoverable` to true when absent, so this fires on an explicit `false` or a flag placed outside `outputSchema.input` where it does nothing — never on its absence. |
| `V2_MAX_TIMEOUT` / `V1_MAX_TIMEOUT` | a missing or string-typed `maxTimeoutSeconds`. It is a required JSON **number**: `60`, never `"60"`. The client schema applies no coercion, and the signer computes `validBefore` from it. |
| `V2_BAZAAR_INPUT_TYPE` | `bazaar.info.input` with no `type` discriminator (`"http"` or `"mcp"`). It is what a facilitator reads first to decide which validation rules apply, and its absence is the longest-running Bazaar indexing failure on record. |
| `V2_BAZAAR_SCHEMA_CONTENT` | the bazaar schema must define an `input` property and keep every `$ref`/`$id` a same-document `#` fragment. An external reference is not merely unfetched — facilitators are forbidden from resolving one, so nothing can validate the schema. |
| `V1_SCHEME_KNOWN` / `V1_NETWORK_KNOWN` | v1's scheme and network enums are **closed**. `exact` is the only scheme, and the network must be one of seventeen plain names; anything else is a hard parse error for the whole envelope, not a skipped entry. v2 is open on both by design. |
| `V2_AMOUNT_MINIMUM` | under CDP's 1000-atomic-unit ($0.001) indexing floor. Legal x402, perfectly payable, and not catalogued. |

## What it will not tell you

It checks the published HTTP 402 and its envelopes; it does not attempt a real
payment to the seller. It cannot tell you whether your facilitator would accept
a payment, whether Bazaar has crawled the URL, or whether anyone wants the
service. It follows no redirects and refuses private and reserved addresses and
any port but 443 and 8443. The URL guard does not pre-resolve DNS, so it cannot
defend against DNS rebinding; for anything not publicly reachable, use
`/lint/envelope`.

A report can also be **partial**, and says so in `summary.partial`. When the
endpoint answered something other than a 402 — a redirect, a free-tier 200, a
405 to the POST this sends — there was no envelope to read, so the envelope
checks are skipped rather than reported as a missing envelope. On a 404 or 405,
retry with `{"method": "GET"}` before changing anything: a GET-only endpoint is
as common a cause as a broken route.

`V1_ABSENT` is **info, not a problem**. It means the endpoint publishes a v2
header envelope and no v1 body envelope, which is the current generation of the
protocol done correctly. The only thing it costs is the pre-header clients, and
whether that matters is the seller's call, not the linter's.

Support: support@10x402.com
