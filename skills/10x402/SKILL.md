---
name: 10x402
description: Find response-level blockers when an x402 endpoint passes validate but is not indexed, an x402 service is not showing up in Bazaar, or an x402 v1 vs v2 migration breaks. Runs a 64-check catalogue over the HTTP 402, payment envelopes, and report safeguards; each finding includes a specific fix. Use for x402 seller debugging, PAYMENT-REQUIRED headers, CDP Bazaar listings, extensions.bazaar, discoverability, dual-stack v1/v2 envelopes, and invalid_exact_evm_payload_signature.
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

**Public endpoint — $0.01 per served report:**

```bash
curl -sS -X POST https://10x402.com/lint \
  -H 'content-type: application/json' \
  -d '{"url": "https://their-endpoint.example.com/api/thing"}'
```

**Captured response — $0.005 per served report.** Prefer this whenever you can
already see the response: from a curl, from a test, or from the code that builds
it. It fetches nothing, so it works on staging, on localhost, behind auth, and
on an endpoint that is not deployed yet.

```bash
curl -sS -X POST https://10x402.com/lint/envelope \
  -H 'content-type: application/json' \
  -d '{"status": 402, "headers": {"payment-required": "<base64>"}, "body": "<the 402 body>"}'
```

As MCP tools, call `x402_checks` first (free), then choose `lint_x402` or
`lint_x402_envelope`.

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
self-lints both paid endpoint envelopes and fails on any finding.

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

**Grades:** A = zero errors and zero warnings · B = zero errors, 1–2 warnings ·
C = zero errors, 3+ warnings · D = errors, none core · F = any *core* error,
meaning the envelope is not usable as published.

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
| `V1_DISCOVERABLE` | `discoverable` at the wrong level. It lives **inside** `outputSchema.input`, not one level up. |

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

Support: support@lemon-agent.dev
