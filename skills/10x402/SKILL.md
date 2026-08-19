---
name: 10x402
description: Diagnose why an x402 endpoint is not working — no buyers, missing from a discovery index, or payments failing with a signature error nobody can reproduce. Lints an x402 402 envelope for conformance and returns every problem with its exact fix. Use for x402 seller debugging, PAYMENT-REQUIRED headers, CDP Bazaar listings, extensions.bazaar, dual-stack v1/v2 envelopes, invalid_exact_evm_payload_signature.
---

# 10x402 — x402 conformance linting

## When to reach for this

The symptom is almost always an **absence**, not an error:

- The endpoint answers 402 and nobody ever pays.
- It never appears in CDP Bazaar, or it appeared once and dropped out.
- Real payments come back `invalid_exact_evm_payload_signature` and the same
  payload verifies fine somewhere else.
- A v2 client behaves as though the endpoint published no envelope at all.

x402 fails silently in every one of those directions. Nothing in the seller's
logs explains any of it, which is exactly why a linter is worth a cent.

## Use it

**Free — see what will be checked before spending anything:**

```bash
curl -sS https://10x402.com/check
```

**Lint a live endpoint — $0.01:**

```bash
curl -sS -X POST https://10x402.com/lint \
  -H 'content-type: application/json' \
  -d '{"url": "https://their-endpoint.example.com/api/thing"}'
```

**Lint a response you already have — $0.005.** Prefer this whenever you can
already see the response: from a curl, from a test, or from the code that builds
it. It fetches nothing, so it works on staging, on localhost, behind auth, and
on an endpoint that is not deployed yet.

```bash
curl -sS -X POST https://10x402.com/lint/envelope \
  -H 'content-type: application/json' \
  -d '{"status": 402, "headers": {"payment-required": "<base64>"}, "body": "<the 402 body>"}'
```

As MCP tools: `x402_checks` (free), `lint_x402`, `lint_x402_envelope`.

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

## The failures worth knowing by heart

| code | what it means |
|---|---|
| `V2_B64_URLSAFE` | the `PAYMENT-REQUIRED` header is base64**url**. Clients validate the charset *before* decoding, so the envelope is discarded unread and the seller looks like they published nothing. Use `btoa` / `b64encode` / `StdEncoding`, not the JWT form. |
| `V2_BAZAAR_INFO_VALIDATES` | `bazaar.info` does not validate against `bazaar.schema`. The facilitator declines to catalogue it **silently** — payments keep working, the listing never appears. |
| `V2_EXTRA_EIP712` / `V1_EXTRA_EIP712` | no `extra.{name,version}`. The client signs over an undefined EIP-712 domain while the facilitator recomputes it from its own table, so every genuine payment fails as `invalid_exact_evm_payload_signature`. For USDC on Base: `{"name": "USD Coin", "version": "2"}` — the on-chain `name()`, not the ticker. |
| `V2_NETWORK_CAIP2` | `"base"` in a v2 envelope. v2 requires CAIP-2 (`eip155:8453`); the colon is a schema requirement, not a style. Keep `"base"` in the v1 body. |
| `V2_AMOUNT` / `V1_MAX_AMOUNT_REQUIRED` | the wrong version's price field. v2 reads `amount`, v1 reads `maxAmountRequired`. |
| `V2_RESOURCE_OBJECT` / `V1_RESOURCE_STRING` | the wrong version's resource form. v2 is a top-level object; v1 is a flat string on the accepts entry. |
| `HTTP_FREE_TIER_200` | a free tier serving 200s to unauthenticated callers. The discovery prober expects a 402 and delists an endpoint that answers otherwise. Gate a trial behind a key the prober does not send. |
| `DUAL_*` | the two envelopes disagree on payTo, price, chain or asset. Build the v2 entry as a *projection* of the v1 object rather than assembling it twice. |
| `V1_DISCOVERABLE` | `discoverable` at the wrong level. It lives **inside** `outputSchema.input`, not one level up. |

## What it will not tell you

It checks the **envelope**, not the payment. It cannot tell you whether your
facilitator would accept a real payment — only whether the terms you published
are ones a client can sign against. It follows no redirects, resolves no DNS,
and refuses private and reserved addresses and any port but 443 and 8443; for
anything not publicly reachable, use `/lint/envelope`.

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
