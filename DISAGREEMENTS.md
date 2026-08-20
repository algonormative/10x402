# Disagreements: 10x402 vs the x402-doctor prototype

Two independent conformance implementations run over the same portable corpus, reported side by side. **No winner is declared.** Where a tool contradicts a document it itself cites, the row says so and names the document — twice about 10x402, which is the point of running someone else’s implementation over your own fixtures.

Prepared for [x402-foundation/x402#3104](https://github.com/x402-foundation/x402/issues/3104).

## What was run

| | |
| --- | --- |
| Corpus | `corpus/fixtures.json`, corpus_version 1, 34 fixtures |
| 10x402 | https://github.com/chronick/10x402 @ `853ed3f5a722` — adapter `corpus/run-10x402.mjs` |
| x402-doctor | https://github.com/Maha-Strategies/maha-corp-web @ `37233104653b` — adapter `corpus/run-x402-doctor.mjs` |
| Client pins | `@x402/core` 2.23.0, `x402` 1.2.0 |
| Spec pin | x402-foundation/x402 @ `75b519d0a3a7` |

**Licence.** The prototype’s repository publishes no licence — no `LICENSE` file, no `license` field in `package.json`, and `license: null` from the GitHub API — so all rights are reserved and **no code from it is vendored into this repository**. `corpus/run-x402-doctor.mjs` clones it to a temporary directory at the pinned commit and imports `diagnoseX402Endpoint()` from there. What is committed here is our mapping and the SHA.

**No payments, no third-party network.** The adapter passes no `paidProbe`, so a settlement is structurally impossible rather than merely unrequested. Each recorded response is re-served from `127.0.0.1` and the fixture’s own origin is mapped onto it; every other host is refused at the fetch boundary. The only host the prototype attempted was the CDP Bazaar merchant lookup, which was refused — see § Not evaluated.

## Agreement

| | count | of |
| --- | ---: | ---: |
| Dimension-verdicts in the corpus | 102 | 34 fixtures × 3 dimensions |
| Comparable (both tools reached a verdict) | 75 | 73.5% of all |
| **Agreed** | **57** | **76.0% of comparable** |
| Disagreed | 18 | 24.0% of comparable |
| Not comparable (one tool did not evaluate) | 27 | 26.5% of all |
| Agreed on the verdict, differed on the reason | 12 | 21.1% of agreements |

Both tools pass the calibration fixture — the v2 transport specification’s own canonical 402 — on `payment` and `client_interop`, and both fail it on `discovery`, which is the demonstration the three dimensions were separated for.

## Disagreements

| fixture | dimension | 10x402 | x402-doctor | class |
| --- | --- | --- | --- | --- |
| `calibration-cloudflare-batch-settlement` | payment | pass | fail (timeout-form) | defect |
| `calibration-cloudflare-batch-settlement` | client_interop | pass | fail (timeout-form) | defect |
| `perfect-v1-only` | payment | pass | fail (envelope-absent, b64-undecodable) | scope |
| `perfect-v1-only` | client_interop | pass | fail (envelope-absent, b64-undecodable) | scope |
| `v2-header-b64-whitespace` | payment | fail (b64-urlsafe) | pass | transport |
| `v2-header-b64-whitespace` | client_interop | fail (b64-urlsafe) | pass | transport |
| `v1-network-caip2` | payment | fail (network-form) | pass | scope |
| `v1-network-caip2` | client_interop | fail (network-form) | pass | scope |
| `extra-eip712-absent` | payment | fail (missing-eip712-extra) | pass | coverage |
| `extra-eip712-absent` | client_interop | fail (missing-eip712-extra) | pass | coverage |
| `v2-payto-array` | payment | fail (payee-form, dual-divergence) | pass | defect |
| `v2-payto-array` | client_interop | fail (payee-form) | pass | defect |
| `dual-payto-divergence` | payment | fail (dual-divergence) | pass | scope |
| `dual-network-unmapped-chain` | client_interop | fail (network-unknown) | pass | scope |
| `free-tier-200` | payment | pass | fail (status-not-402) | judgement |
| `free-tier-200` | client_interop | pass | fail (status-not-402) | judgement |
| `redirect-instead-of-402` | payment | pass | fail (status-not-402) | judgement |
| `redirect-instead-of-402` | client_interop | pass | fail (status-not-402) | judgement |

- **scope** — the tools cover different ground by design
- **judgement** — both read the same bytes and disagree about what they mean
- **coverage** — one tool has no rule for this fault
- **defect** — one tool contradicts a document it itself cites
- **transport** — the fault is not observable over a live HTTP probe at all

### Each one

#### `calibration-cloudflare-batch-settlement` — payment, client_interop

*the Cloudflare batch-settlement profile*

- **10x402**: pass
- **x402-doctor**: fail (timeout-form)
- **Class**: defect

The prototype requires `maxTimeoutSeconds` to be a positive integer on every offer. This fixture is the batch-settlement scheme’s own published 402, and that scheme’s specification marks the field optional on `cloudflare:402` (`scheme_batch_settlement_cloudflare.md:110`, "optional, see note below"). Neither tool invented a rule: one is applying the core PaymentRequirements table, the other is applying the network’s own scheme profile, and the two documents differ. It is worth recording that 10x402 had the MIRROR of this bug on the same fixture — it applied CDP’s 1000-atomic-unit price floor to an offer denominated in ISO 4217 USD on a network CDP does not settle — and that it was this fixture that surfaced it. A checker that generalises one profile’s rule across all of them fails a spec-defined profile, and both tools did it once.

Evidence on the fixture:

- `spec` — specs/schemes/batch-settlement/scheme_batch_settlement_cloudflare.md — the scheme’s own 402, verbatim
- `spec` — …:110 — maxTimeoutSeconds is optional on this network
- `spec` — …:48 — the network omits `schema` to stay under 2 KB
- `client-code` — @x402/core@2.23.0 dist/cjs/schemas/index.js — NetworkSchemaV2 is min(3) plus a colon, so `cloudflare:402` is legal

#### `perfect-v1-only` — payment, client_interop

*perfect v1-only 402*

- **10x402**: pass
- **x402-doctor**: fail (envelope-absent, b64-undecodable)
- **Class**: scope

The prototype is v2-only by construction: it requires the `PAYMENT-REQUIRED` header and rejects any challenge whose `x402Version` is not 2. A v1-only seller therefore fails both payment rules. 10x402 reads the v1 body, notes that `@x402/core` falls back to it when there is no header, and calls the endpoint payable — while separately answering `n/a` on discovery, because CDP’s indexing requirements are a v2 shape. This is a difference in declared scope, not in reading: the prototype’s issue text scopes it to the v2 flow.

Evidence on the fixture:

- `spec` — specs/transports-v1/http.md § Payment Required Signaling
- `client-code` — @x402/core@2.23.0 dist/cjs/schemas/index.js — @x402/core falls back to a v1 body when there is no header, so this is payable
- `cdp-validator` — audit/2026-08-19/cdp-validator-toolshed.json preflight — the PAYMENT-REQUIRED header is a required preflight, so this is not indexable

#### `v2-header-b64-whitespace` — payment, client_interop

*a v2 header padded with whitespace*

- **10x402**: fail (b64-urlsafe)
- **x402-doctor**: pass
- **Class**: transport

THE MOST INSTRUCTIVE ROW IN THE TABLE, and neither tool is wrong. The fixture is a v2 header with a leading and trailing space. HTTP defines optional whitespace around a header value as not part of the value, so it is stripped by the parser before any client sees it — the prototype probes a URL, is handed a clean header, and correctly reports nothing. 10x402 lints a RECORDED response, where the padding survives, and fails it because `@x402/core`’s `Base64EncodedRegex` runs against the raw header value before `atob`. The fault is real for anything that hands the header to a client without a transport in between — a facilitator forwarding a stored declaration, an SDK reading from a cache — and it is invisible to any live probe. It is the concrete argument for a corpus of recorded responses alongside a live doctor: the two see different populations of bug.

Evidence on the fixture:

- `client-code` — @x402/core@2.23.0 dist/cjs/schemas/index.js — the regex runs on the raw value, so a leading space fails it before decoding

#### `v1-network-caip2` — payment, client_interop

*v1 envelope naming the network in CAIP-2*

- **10x402**: fail (network-form)
- **x402-doctor**: pass
- **Class**: scope

The v2 half of this response is perfect and the v1 body carries the v2 network spelling. The prototype never reads the body, so it sees nothing wrong; 10x402 reads it against `x402@1.2.0`’s closed enum of bare network names and fails it. Same scope difference as perfect-v1-only, arriving from the other side: a dual-stack seller can be broken in a half a v2-only tool does not look at.

Evidence on the fixture:

- `spec` — specs/x402-specification-v1.md § 5.1.2 (PaymentRequirements table)
- `client-code` — x402@1.2.0 dist/esm/chunk-V3RMM5AE.mjs (PaymentRequirementsSchema) — the v1 network field is a closed enum of bare names

#### `extra-eip712-absent` — payment, client_interop

*no EIP-712 domain in `extra`*

- **10x402**: fail (missing-eip712-extra)
- **x402-doctor**: pass
- **Class**: coverage

The prototype validates scheme, network, amount, timeout, asset and payee, and does not inspect `extra`. On an EIP-3009 chain the `exact` scheme signs a typed-data domain built from `extra.name` and `extra.version`; `@x402/evm` throws at payment CREATION when either is absent, so no payment is attempted at all. 10x402 fails both payment dimensions on it. This is a gap rather than a disagreement — there is no rule on the other side to disagree with — and it is the failure class the 10x402 catalogue describes as the silent one, because nothing in the seller’s logs mentions it.

Evidence on the fixture:

- `spec` — specs/schemes/exact/scheme_exact_evm.md — the EIP-3009 domain is signed from extra.name/extra.version
- `client-code` — @x402/evm — throws at payment CREATION when extra.name or extra.version is absent

#### `v2-payto-array` — payment, client_interop

*payTo as an array holding a valid address*

- **10x402**: fail (payee-form, dual-divergence)
- **x402-doctor**: pass
- **Class**: defect

The fixture’s `payTo` is `["0x…"]` — a one-element ARRAY holding a valid address. The prototype checks it with `EVM_ADDRESS.test(requirement.payTo)`, and `RegExp.prototype.test` coerces its argument with `String()`, which turns a one-element array into the element. The address regex passes and the envelope is reported clean, although both the `@x402/core` zod schema and viem reject a non-string outright, so no client can pay it. This is verifiable in one line: `/^0x[a-fA-F0-9]{40}$/.test(["0x…"]) === true`. It is worth saying that 10x402 shipped the identical hole — `String(entry.payTo || "")` — and closed it in its 2026-08-19 audit, which is why the fixture exists. The trap is the type coercion, not either codebase.

Evidence on the fixture:

- `spec` — specs/x402-specification-v2.md § 5.1.2 (PaymentRequirements table)
- `client-code` — @x402/core@2.23.0 dist/cjs/schemas/index.js — the zod schema and viem both reject a non-string payTo
- `house-opinion` — the dual-stack comparison is a house rule; neither specification requires the two envelopes to agree

#### `dual-payto-divergence` — payment

*dual-stack payTo divergence*

- **10x402**: fail (dual-divergence)
- **x402-doctor**: pass
- **Class**: scope

A dual-stack seller whose v1 body and v2 header name different payees. The prototype reads only the v2 header and correctly finds nothing wrong with it. 10x402 compares the two envelopes and fails the payment dimension. THE 10x402 FINDING IS NOT A PROTOCOL REQUIREMENT and the corpus labels it `house-opinion`: neither specification says a dual-stack seller’s two declarations must agree, and each half here is individually valid and individually settleable. What is true is that the seller is being paid at two addresses by two client generations. Whether that belongs in a conformance verdict at all is a live question, which is exactly why the evidence is labelled rather than asserted.

Evidence on the fixture:

- `house-opinion` — NOT A PROTOCOL REQUIREMENT. Neither specification says a dual-stack seller’s two envelopes must name the same payee; both halves are individually valid and individually settleable. 10x402 treats the divergence as a payment-dimension defect because the money lands in two places, and records the evidence as house-opinion so nobody mistakes it for spec.
- `client-code` — x402-fetch@1.2.0 dist/esm/index.mjs:19-23 — a v1 client reads the body; a v2 client reads the header; neither sees the other

#### `dual-network-unmapped-chain` — client_interop

*dual-stack on a chain outside the linter’s table*

- **10x402**: fail (network-unknown)
- **x402-doctor**: pass
- **Class**: scope

A correctly paired dual-stack seller on Arbitrum. The v2 half is conformant; the v1 half spells the network `arbitrum`, which is not a member of the closed enum in `x402@1.2.0`, so `x402-fetch` throws `invalid_enum_value` and cannot pay that entry. The prototype does not read v1 and reports nothing. Note what 10x402 does NOT do here: the payment dimension passes. Nothing in either specification closes that enum — it is a fact about one client at one version, which is the whole reason `client_interop` is a separate dimension.

Evidence on the fixture:

- `client-code` — x402@1.2.0 dist/esm/chunk-V3RMM5AE.mjs (PaymentRequirementsSchema) — "arbitrum" is not a member of the v1 closed enum, so x402-fetch throws invalid_enum_value on this entry
- `house-opinion` — the v1↔v2 chain equivalence table covers the nine chains x402 clients ship with; outside it the pair is unverified, not divergent

#### `free-tier-200` — payment, client_interop

*free tier: 200 to an unauthenticated caller*

- **10x402**: pass
- **x402-doctor**: fail (status-not-402)
- **Class**: judgement

THE SHARPEST DISAGREEMENT IN THE CORPUS, and the one closest to the thread’s own concern. The endpoint answers an unauthenticated caller with 200. The prototype reports an error whose text is "The unpaid request returned HTTP 200; Bazaar requires HTTP 402" — a PROVIDER requirement, named as such in the message, deciding a payment-path verdict. 10x402 reports a warning and passes the payment dimension, on the reading that there is no challenge here to misinterpret: a free tier is a seller’s choice, and the cost of it is a delisting, which the discovery dimension is for. Both readings have a real cost. Ours lets a response that earns an x402 buyer nothing pass the payment dimension; theirs promotes "Bazaar requires" into a protocol verdict. The corpus records ours as the expectation and flags it as the most arguable expectation it contains.

Evidence on the fixture:

- `client-code` — x402-fetch@1.2.0 dist/esm/index.mjs:19-23 — `if (response.status !== 402) return response`; the client never enters the payment flow
- `cdp-validator` — audit/2026-08-19/cdp-validator-toolshed.json preflight returns_402 (required)
- `cdp-docs` — https://docs.cdp.coinbase.com/x402/seller/get-discovered — endpoints are health-probed on an interval

#### `redirect-instead-of-402` — payment, client_interop

*a redirect instead of a 402*

- **10x402**: pass
- **x402-doctor**: fail (status-not-402)
- **Class**: judgement

A 307 where the 402 was advertised. The prototype fetches with `redirect: "manual"`, sees the 307, and errors. 10x402 warns and passes the payment dimension, citing `@x402/fetch` at 2.23.0, which uses ordinary `fetch` and therefore FOLLOWS the redirect — so the envelope is reachable and the real costs are narrower (a 301/302 rewrites POST to GET; a cross-origin hop drops the payment header; the provider probes the advertised URL, not the final one). The disagreement is about whether "unreachable at the advertised URL" is a payment failure or a hazard, and the two tools’ redirect MODES are the reason each reading looks obvious from inside it.

Evidence on the fixture:

- `client-code` — @x402/fetch@2.23.0 dist/esm/index.mjs:10 — `await fetch(request)`, the default redirect mode, so redirects ARE followed
- `house-opinion` — the envelope is at the other end of the redirect, unread; the fixture is about the redirect, not about an absent envelope

## Same verdict, different reason

These rows agree on whether the fixture passes and disagree on why. They matter because the reason is what a seller acts on: two tools can both say "not indexable" and send the operator to two different lines of JSON.

| fixture | dimension | 10x402 | x402-doctor |
| --- | --- | --- | --- |
| `calibration-spec-canonical-402` | discovery | fail (bazaar-extension-absent) | fail (bazaar-input-shape) |
| `calibration-cloudflare-batch-settlement` | discovery | fail (bazaar-extension-absent) | fail (bazaar-input-shape) |
| `calibration-solana-spec-envelope` | discovery | fail (bazaar-extension-absent) | fail (bazaar-input-shape) |
| `no-envelope-html-body` | payment | fail (envelope-not-json, envelope-absent) | fail (envelope-absent, b64-undecodable) |
| `no-envelope-html-body` | client_interop | fail (envelope-not-json, envelope-absent) | fail (envelope-absent, b64-undecodable) |
| `v2-amount-uses-v1-field-name` | payment | fail (missing-required-field) | fail (amount-form) |
| `v2-amount-uses-v1-field-name` | client_interop | fail (missing-required-field) | fail (amount-form) |
| `v2-resource-flat-string` | payment | fail (resource-shape) | fail (wrong-version-field) |
| `v2-resource-flat-string` | client_interop | fail (resource-shape) | fail (wrong-version-field) |
| `bazaar-extension-absent` | discovery | fail (bazaar-extension-absent) | fail (bazaar-input-shape) |
| `bazaar-schema-external-ref` | discovery | fail (bazaar-schema-unresolvable, bazaar-info-schema-mismatch) | fail (bazaar-info-schema-mismatch) |
| `bazaar-input-no-type` | discovery | fail (bazaar-input-shape, bazaar-info-schema-mismatch) | fail (bazaar-info-schema-mismatch) |

- Four fixtures with no `extensions.bazaar` reach the same discovery verdict by different routes. The prototype grades the missing extension a WARNING and then errors on `x402.bazaar.crawler_input` — "no reproducible HTTP input example" — so the verdict comes from the consequence rather than the cause. 10x402 names the cause. A seller reading the two reports is told to add an input example, or to add the extension; only the second is the fix.

- Both tools fail both payment dimensions; the diagnoses are not the same fault. The prototype’s `decodeChallenge` requires `challenge.resource?.url` and throws "listed no terms that could be paid" when the resource is the v1 flat string, so the whole challenge is reported as malformed. 10x402 names the shape and quotes the object to replace it with. Same verdict, and one report tells the seller which line to edit.

- A v2 accepts entry carrying `maxAmountRequired`. The prototype reports `accepts[0].amount must be a positive integer string` — true, and it reads as "your price is malformed" when the price is fine and the field name is not. 10x402 reports the rename and quotes the replacement. The dimension verdicts agree exactly.

- A 402 with an HTML error page and no header. The prototype reports a missing v2 header and then a malformed PAYMENT-REQUIRED — the same absence twice, because `decodeChallenge` does not distinguish "no header" from "undecodable header". 10x402 separates the missing header from the unparseable body.

- On `bazaar-schema-external-ref` and `bazaar-input-no-type` both tools fail discovery. 10x402 carries a second, more specific tag alongside the shared one — the unresolvable `$ref` (which `bazaar.md` says a facilitator MUST NOT resolve), and the absent `type` discriminator. The prototype reports both as a single extension-schema failure, which is the same verdict with less to act on.

## Not evaluated

A corpus of recorded responses has no registry, so the prototype’s live-versus-indexed digest comparison — the check the proposal exists for — cannot run. Those dimension-verdicts are recorded as `not-evaluated`. **None of them is counted as a pass**, and none is counted in the agreement figures above.

Rules held back:

- `x402.bazaar.lookup`
- `x402.bazaar.not_found`
- `x402.bazaar.stale_metadata`
- `x402.bazaar.partial_comparison`
- `x402.declaration_integrity.catalog_malformed`
- `x402.declaration_integrity.catalog_resource`
- `x402.payment.skipped`
- `x402.payment.status`
- `x402.payment.receipt`
- `x402.payment.settled`

One more is reported and should not be read as evidence: `x402.bazaar.crawler_status` replays the declared crawler request, and the fixture server answers the replay with the same recorded response, so it is structurally satisfied for every fixture. The results file marks it `structurally-satisfied`. Replaying the declared input against a live endpoint is the one check in the prototype that a recorded corpus fundamentally cannot carry, and the two approaches are complementary for exactly that reason.

27 of 102 dimension-verdicts fell into this category.

## Where 10x402 was wrong

Running someone else’s implementation over our own fixtures found two defects in ours. Both are fixed in the commit this report was generated from; both were found by a CALIBRATION fixture rather than by a broken one, which is the argument for keeping known-good documents in a corpus of broken ones.

1. **A provider’s price floor applied outside the provider’s own domain.** `V2_AMOUNT_MINIMUM` enforced CDP’s 1000-atomic-unit minimum on every offer. On the Cloudflare batch-settlement profile — `network: "cloudflare:402"`, `asset: "USD"`, `amount: "1"`, one cent in ISO 4217 — it reported a spec-defined 402 as too cheap to index, for an index that does not carry that network at all. This is precisely the failure mode the thread named: a provider observation becoming a protocol requirement. The check is now gated on `CDP_FACILITATOR_CHAINS`, and `V2_NETWORK_SUPPORTED` already says the chain is outside CDP’s set.

2. **"Indexable" reported when nothing had been inspected.** `bazaar_ready` was computed from the ABSENCE of blocking findings. Where the registry checks could not run at all — the v2 header did not decode, or `resource` arrived as the v1 flat string, so there is no `ResourceInfo` object to read — there were no blockers, and the engine answered `true` to a seller whose envelope no indexer can read. It now answers `n/a`, joining the v1-only case under the same rule: not a failure, a question this response cannot answer. Found by `v2-resource-flat-string`.

A third is not a defect and is recorded as a standing judgement rather than fixed: 10x402 passes the payment dimension on `free-tier-200` and `redirect-instead-of-402` where the prototype fails both. The corpus notes on those fixtures say so, and the reasoning is in § Disagreements. It is the most arguable pair of expectations the corpus contains, and it is written down rather than smoothed over.

## Reproducing

```sh
node corpus/build-fixtures.mjs      # regenerate corpus/fixtures.json
node corpus/run-10x402.mjs          # → corpus/results-10x402.json
node corpus/run-x402-doctor.mjs     # clones the prototype to a temp dir → corpus/results-x402-doctor.json
node corpus/report-disagreements.mjs # → DISAGREEMENTS.md
npm test                            # the corpus phase asserts run-10x402 reproduces every expectation
```

Generated by `corpus/report-disagreements.mjs` from results dated 2026-08-20 and 2026-08-20.
