# Disagreements: 10x402 vs the x402-doctor prototype

Two independent conformance implementations run over the same portable corpus, reported side by side. **No winner is declared.** Where a tool contradicts a document it itself cites, the row says so and names the document — six times about 10x402, which is the point of running someone else’s implementation over your own fixtures and then having the corpus itself reviewed. See § Where 10x402 was wrong.

Prepared for [x402-foundation/x402#3104](https://github.com/x402-foundation/x402/issues/3104).

## What was run

| | |
| --- | --- |
| Corpus | `corpus/fixtures.json`, corpus_version 3, 34 fixtures |
| 10x402 | https://github.com/algonormative/10x402 @ `2a0f2fb628e4` — adapter `corpus/run-10x402.mjs` |
| x402-doctor | https://github.com/Maha-Strategies/maha-corp-web @ `37233104653b` — adapter `corpus/run-x402-doctor.mjs` |
| Package pins | `@x402/core` 2.23.0, `@x402/evm` 2.23.0, `@x402/fetch` 2.23.0, `@x402/extensions` 2.23.0, `x402` 1.2.0, `x402-fetch` 1.2.0 — each with its registry integrity hash |
| Spec pin | x402-foundation/x402 @ `75b519d0a3a7` |

**The engine is pinned by content, not by commit.** The commit above says where the tree was when the corpus was last stamped; it is marked informational in `pins`, and it is ALWAYS behind this file — writing the file is itself a change to be committed, and it falls further behind with every commit made after a stamp, so no fixed lag is claimed. The AUTHORITY is the git blob hash of every file whose bytes can change an answer — `worker/lint.js`, `worker/json-schema.js`, `worker/envelope.js`, `worker/positive-control.js`, `test/fixtures/envelopes.mjs`, `corpus/vocabulary.mjs`, `corpus/run-10x402.mjs`, `corpus/client-probe.json`, `corpus/client-probe.lock.json` — and `assertPinnedBlobs()` recomputes them and refuses to run on a mismatch, before the engine executes. A published result therefore cannot claim to be the output of code that is not the code that produced it.

**Licence.** The prototype’s repository publishes no licence — no `LICENSE` file, no `license` field in `package.json`, and `license: null` from the GitHub API — so all rights are reserved and **no code from it is vendored into this repository**. `corpus/run-x402-doctor.mjs` clones it to a temporary directory at the pinned commit and imports `diagnoseX402Endpoint()` from there. What is committed here is our mapping and the SHA.

**No payments, no third-party network.** The adapter passes no `paidProbe`, so a settlement is structurally impossible rather than merely unrequested. Each recorded response is re-served from `127.0.0.1` and the fixture’s own origin is mapped onto it; every other host is refused at the fetch boundary. The only host the prototype attempted was the CDP Bazaar merchant lookup, which was refused — see § Not evaluated.

## Agreement

| | count | of |
| --- | ---: | ---: |
| Dimension-verdicts in the corpus | 102 | 34 fixtures × 3 dimensions |
| Scope-excluded (the corpus cannot judge this from this recording) | 4 | 3.9% of all |
| Not comparable (one tool did not evaluate) | 25 | 24.5% of all |
| Comparable (both tools reached a verdict) | 73 | 71.6% of all |
| **Agreed** | **58** | **79.5% of comparable** |
| Disagreed | 15 | 20.5% of comparable |
| Agreed on the verdict, differed on the reason | 12 | 20.7% of agreements |

**Three exclusions, and they are different things.** `not-evaluated` means a TOOL did not run the rules that would answer the question — for the prototype that is the live-versus-indexed comparison, which needs a registry an offline corpus does not have. `scope-excluded` means the CORPUS cannot support an answer from this recording, whichever tool is asked: a response with no challenge in it declares no payment, and a recorded corpus cannot demonstrate payability it never recorded. Neither is counted as an agreement, and neither is counted as a pass. What each tool would have said on the scope-excluded rows is reported in full under § Scope-excluded.

Both tools pass the calibration fixture — the v2 transport specification’s own canonical 402 — on `payment` and `client_interop`, and both fail it on `discovery`, which is the demonstration the three dimensions were separated for.

## Disagreements

| fixture | dimension | 10x402 | x402-doctor | class |
| --- | --- | --- | --- | --- |
| `calibration-cloudflare-batch-settlement` | payment | pass | fail (timeout-form) | defect |
| `calibration-cloudflare-batch-settlement` | client_interop | pass | fail (timeout-form) | defect |
| `perfect-v1-only` | payment | pass | fail (envelope-absent) | scope |
| `perfect-v1-only` | client_interop | pass | fail (envelope-absent) | scope |
| `v2-header-b64-urlsafe` | payment | pass | fail (b64-urlsafe) | placement |
| `v2-header-b64-whitespace` | client_interop | fail (b64-urlsafe) | pass | transport |
| `v1-network-caip2` | payment | fail (network-form) | pass | scope |
| `v1-network-caip2` | client_interop | fail (network-form) | pass | scope |
| `extra-eip712-absent` | payment | fail (missing-eip712-extra) | pass | coverage |
| `extra-eip712-absent` | client_interop | fail (missing-eip712-extra) | pass | coverage |
| `v2-payto-array` | payment | fail (payee-form) | pass | defect |
| `v2-payto-array` | client_interop | fail (payee-form) | pass | defect |
| `dual-network-unmapped-chain` | client_interop | fail (network-unknown) | pass | scope |
| `free-tier-200` | discovery | n/a | fail (status-not-402) | judgement |
| `redirect-instead-of-402` | discovery | n/a | fail (status-not-402) | judgement |

- **scope** — the tools cover different ground by design
- **judgement** — both read the same bytes and disagree about what they mean
- **coverage** — one tool has no rule for this fault
- **defect** — one tool contradicts a document it itself cites
- **transport** — the fault is not observable over a live HTTP probe at all
- **placement** — both tools see the same fault and their adapters file it under different dimensions. This is a disagreement about WHERE a finding belongs, not about whether it is real, and it is reported separately because conflating the two makes an adapter choice look like two implementations reaching opposite conclusions

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
- `client-code` — corpus/client-probe.json (corpus/probe-clients.mjs, run against the committed corpus/client-probe.lock.json) — OBSERVED: `decodePaymentRequiredHeader` ACCEPTS this envelope, and so does `x402HTTPClient#getPaymentRequiredResponse`, which is the path a client actually takes. That is what the parse-level pass rests on. PARSE-LEVEL AND NO FURTHER: no pinned client in this corpus implements `batch-settlement`, so nothing evidences that a client can EXECUTE this offer, and the corpus does not claim it can
- `client-code` — corpus/client-probe.json (corpus/probe-clients.mjs, run against the committed corpus/client-probe.lock.json) — AND THE DIVERGENCE, RECORDED RATHER THAN HIDDEN: the exported `PaymentRequiredV2Schema.safeParse` REJECTS this same envelope, with exactly one issue — `accepts.0.maxTimeoutSeconds`, invalid_type, "Required". The decoder and the schema shipped in one package disagree about a 402 the batch-settlement scheme publishes as its own example, because the decode path runs no zod at all. An earlier version of this fixture cited the zod schemas as the basis for the PASS, which is the opposite of what they do
- `cdp-validator` — audit/2026-08-19/cdp-validator-toolshed.json preflight has_bazaar_extension (severity: required) — absent here
- `cdp-validator` — audit/2026-08-19/cdp-validator-toolshed.json preflight accepts[0].network (severity: required), expected "a facilitator-supported network (Base, Solana, Polygon, Arbitrum, World)" — cloudflare:402 is not among them, so the declaration is ineligible at this provider whatever else it does

#### `perfect-v1-only` — payment, client_interop

*perfect v1-only 402*

- **10x402**: pass
- **x402-doctor**: fail (envelope-absent)
- **Class**: scope

The prototype is v2-only by construction: it requires the `PAYMENT-REQUIRED` header and rejects any challenge whose `x402Version` is not 2. A v1-only seller therefore fails both payment rules. 10x402 reads the v1 body, notes that `@x402/core` falls back to it when there is no header, and calls the endpoint payable — while separately answering `n/a` on discovery, because CDP’s indexing requirements are a v2 shape. This is a difference in declared scope, not in reading: the prototype’s issue text scopes it to the v2 flow.

Evidence on the fixture:

- `spec` — specs/transports-v1/http.md § Payment Required Signaling
- `client-code` — @x402/core@2.23.0 dist/esm/chunk-N4QXZG2Z.mjs (PaymentRequirements/ResourceInfo zod schemas) — @x402/core falls back to a v1 body when there is no header, so the declaration is readable. PARSE-LEVEL
- `cdp-validator` — audit/2026-08-19/cdp-validator-toolshed.json preflight payment_required_header (severity: required) — a v2-shaped requirement this v1-only seller has no declaration to answer

#### `v2-header-b64-urlsafe` — payment

*v2 header in url-safe base64*

- **10x402**: pass
- **x402-doctor**: fail (b64-urlsafe)
- **Class**: placement

BOTH TOOLS REFUSE THE ENVELOPE AND THEY FILE THE REFUSAL DIFFERENTLY. The header is base64url, `@x402/core` tests `Base64EncodedRegex` against the raw value and throws before `atob`, and neither implementation disputes any of that — the two `client_interop` verdicts agree, with the same reason tag. What differs is the payment dimension. 10x402 passes it, because the v2 transport specification says the header carries "Base64-encoded" JSON and is SILENT on the alphabet: there is no normative text that base64url violates, so the fault is a client-interoperability fault and nothing else. The prototype has one verdict per finding and no dimension to separate them into, so the adapter that maps it necessarily reports the refusal in both. It is worth being blunt that an earlier version of THIS corpus made the same conflation from the other end — it failed the payment dimension here on the strength of a spec citation that does not say what it was being made to say, and the pre-publication review caught it.

Evidence on the fixture:

- `client-code` — @x402/core@2.23.0 dist/esm/chunk-UQQR4X3S.mjs:95 — `var Base64EncodedRegex = /^[A-Za-z0-9+/]*={0,2}$/`
- `client-code` — @x402/core@2.23.0 dist/esm/chunk-BA2VL4DT.mjs:2199-2204 — decodePaymentRequiredHeader tests the regex against the RAW header value and throws BEFORE atob()
- `client-code` — corpus/client-probe.json (corpus/probe-clients.mjs, run against the committed corpus/client-probe.lock.json) — OBSERVED: `decodePaymentRequiredHeader` THROWS "Invalid payment required header" on this header value, and `Base64EncodedRegex.test` returns false. Note the envelope underneath is well formed — recovered leniently it passes `PaymentRequiredV2Schema` — so the fault is purely transport-layer, which is the whole of the client-interoperability claim
- `spec` — specs/transports-v2/http.md § Payment Required Signaling — "Base64-encoded", and SILENT on the alphabet. CONTEXT, NOT AUTHORITY: this citation is why the corpus does NOT fail the payment dimension here
- `field-report` — x402-foundation/x402#3104 — reported as a case the doctor prototype did not yet cover

#### `v2-header-b64-whitespace` — client_interop

*a v2 header padded with whitespace*

- **10x402**: fail (b64-urlsafe)
- **x402-doctor**: pass
- **Class**: transport

THE MOST INSTRUCTIVE ROW IN THE TABLE, and neither tool is wrong. The fixture is a v2 header with a leading and trailing space. HTTP defines optional whitespace around a header value as not part of the value, so it is stripped by the parser before any client sees it — the prototype probes a URL, is handed a clean header, and correctly reports nothing. 10x402 lints a RECORDED response, where the padding survives, and fails CLIENT INTEROPERABILITY because `@x402/core`’s `Base64EncodedRegex` runs against the raw header value before `atob`. Note what the corpus does NOT do here any more: it makes no payment claim at all. This corpus defines `response.headers` as PARSED FIELD VALUES, so a padded value is one that reached the client by a path with no HTTP parser in it — a facilitator replaying a stored declaration, an SDK reading a cache, a pasted capture. The fixture is labelled `population: "raw-input"` and scoped to exactly that population. An earlier version failed the payment dimension on it, which put a client-specific raw-input opinion inside a normative dimension. The two tools see different populations of bug, and that remains the concrete argument for a corpus of recorded responses alongside a live doctor.

Evidence on the fixture:

- `client-code` — @x402/core@2.23.0 dist/esm/chunk-UQQR4X3S.mjs:95 — `var Base64EncodedRegex = /^[A-Za-z0-9+/]*={0,2}$/` — a leading or trailing space fails the regex before any decode
- `client-code` — @x402/core@2.23.0 dist/esm/chunk-BA2VL4DT.mjs:2199-2204 — decodePaymentRequiredHeader tests the regex against the RAW header value and throws BEFORE atob()
- `client-code` — corpus/client-probe.json (corpus/probe-clients.mjs, run against the committed corpus/client-probe.lock.json) — OBSERVED: `decodePaymentRequiredHeader` THROWS "Invalid payment required header" on the padded value. The probe never makes an HTTP round trip, which is exactly why it can see a fault a live doctor structurally cannot
- `house-opinion` — `response.headers` in this corpus are PARSED FIELD VALUES, so a padded value is one that reached the client by a path with no HTTP parser in it — a stored declaration replayed by a facilitator, an SDK reading a cache, a pasted capture. The fixture is scoped to that population and makes no claim about an HTTP-delivered one
- `spec` — specs/transports-v2/http.md § Payment Required Signaling — "Base64-encoded", and SILENT on padding as on the alphabet. The declared terms are conformant and settleable, which is why the payment dimension PASSES and the fault is confined to the client that refuses to decode it
- `spec` — specs/x402-specification-v1.md § 5.1.2 (PaymentRequirements table) — and the v1 body in this dual-stack response is intact and independently payable

#### `v1-network-caip2` — payment, client_interop

*v1 envelope naming the network in CAIP-2*

- **10x402**: fail (network-form)
- **x402-doctor**: pass
- **Class**: scope

The v2 half of this response is perfect and the v1 body carries the v2 network spelling. The prototype never reads the body, so it sees nothing wrong; 10x402 reads it against `x402@1.2.0`’s closed enum of bare network names and fails it. Same scope difference as perfect-v1-only, arriving from the other side: a dual-stack seller can be broken in a half a v2-only tool does not look at.

Evidence on the fixture:

- `spec` — specs/x402-specification-v1.md § 5.1.2 (PaymentRequirements table)
- `client-code` — x402@1.2.0 dist/esm/chunk-V3RMM5AE.mjs (PaymentRequirementsSchema) — the v1 network field is a closed enum of bare names, so the entry throws invalid_enum_value at parse. PARSE-LEVEL
- `cdp-validator` — audit/2026-08-19/cdp-validator-toolshed.json preflight — the required set the v2 half satisfies

#### `extra-eip712-absent` — payment, client_interop

*no EIP-712 domain in `extra`*

- **10x402**: fail (missing-eip712-extra)
- **x402-doctor**: pass
- **Class**: coverage

The prototype validates scheme, network, amount, timeout, asset and payee, and does not inspect `extra`. On an EIP-3009 chain the `exact` scheme signs a typed-data domain built from `extra.name` and `extra.version`; `@x402/evm` throws at payment CREATION when either is absent, so no payment is attempted at all. 10x402 fails both payment dimensions on it. This is a gap rather than a disagreement — there is no rule on the other side to disagree with — and it is the failure class the 10x402 catalogue describes as the silent one, because nothing in the seller’s logs mentions it.

Evidence on the fixture:

- `spec` — specs/schemes/exact/scheme_exact_evm.md — extra.name and extra.version are required for the default eip3009 assetTransferMethod
- `client-code` — @x402/evm@2.23.0 dist/esm/chunk-REWHAFTU.mjs:49-53 — EXECUTE-LEVEL: `if (!requirements.extra?.name \|\| !requirements.extra?.version) throw` at payment CREATION, with no fallback
- `client-code` — corpus/client-probe.json (corpus/probe-clients.mjs, run against the committed corpus/client-probe.lock.json) — AND THE LIMIT OF WHAT WAS OBSERVED: this envelope PARSES cleanly at every reachable entry point, which is the point of the fixture — nothing in the decode or validate layer objects. The signer is `not-exercisable-offline` without a key and a chain, so the execute-level claim rests on reading @x402/evm at the pinned version rather than on running it
- `cdp-validator` — audit/2026-08-19/cdp-validator-toolshed.json preflight — the required set the bazaar half satisfies

#### `v2-payto-array` — payment, client_interop

*payTo as an array holding a valid address*

- **10x402**: fail (payee-form)
- **x402-doctor**: pass
- **Class**: defect

The fixture’s `payTo` is `["0x…"]` — a one-element ARRAY holding a valid address. The prototype checks it with `EVM_ADDRESS.test(requirement.payTo)`, and `RegExp.prototype.test` coerces its argument with `String()`, which turns a one-element array into the element. The address regex passes and the envelope is reported clean, although both the `@x402/core` zod schema and viem reject a non-string outright, so no client can pay it. This is verifiable in one line: `/^0x[a-fA-F0-9]{40}$/.test(["0x…"]) === true`. It is worth saying that 10x402 shipped the identical hole — `String(entry.payTo || "")` — and closed it in its 2026-08-19 audit, which is why the fixture exists. The trap is the type coercion, not either codebase.

Evidence on the fixture:

- `spec` — specs/x402-specification-v2.md § 5.1.2 (PaymentRequirements table)
- `client-code` — @x402/core@2.23.0 dist/esm/chunk-N4QXZG2Z.mjs (PaymentRequirements/ResourceInfo zod schemas) — the zod schema rejects a non-string payTo
- `client-code` — corpus/client-probe.json (corpus/probe-clients.mjs, run against the committed corpus/client-probe.lock.json) — OBSERVED: `PaymentRequiredV2Schema.safeParse` rejects with `accepts.0.payTo`, invalid_type, "Expected string, received array"; `decodePaymentRequiredHeader` accepts it, so a decoding client carries the array as far as the signer
- `client-code` — @x402/evm@2.23.0 dist/esm/chunk-REWHAFTU.mjs — EXECUTE-LEVEL: viem’s getAddress rejects a non-string outright, so the transfer authorisation cannot be built
- `cdp-validator` — audit/2026-08-19/cdp-validator-toolshed.json preflight accepts[0].payTo (severity: required) — "payTo address present", captured with a string address as the actual value. An earlier version of this corpus read that as a PRESENCE rule satisfied by an array; the captured detail says address, and the wrapped value is exactly the type-coercion trap this fixture exists to demonstrate

#### `dual-network-unmapped-chain` — client_interop

*dual-stack on a chain outside the linter’s table*

- **10x402**: fail (network-unknown)
- **x402-doctor**: pass
- **Class**: scope

A correctly paired dual-stack seller on Arbitrum. The v2 half is conformant; the v1 half spells the network `arbitrum`, which is not a member of the closed enum in `x402@1.2.0`, so `x402-fetch` throws `invalid_enum_value` and cannot pay that entry. The prototype does not read v1 and reports nothing. Note what 10x402 does NOT do here: the payment dimension passes. Nothing in either specification closes that enum — it is a fact about one client at one version, which is the whole reason `client_interop` is a separate dimension.

Evidence on the fixture:

- `client-code` — x402@1.2.0 dist/esm/chunk-V3RMM5AE.mjs (PaymentRequirementsSchema) — "arbitrum" is not a member of the v1 closed enum, so x402-fetch throws invalid_enum_value on this entry at parse. PARSE-LEVEL
- `spec` — specs/x402-specification-v1.md § 5.1.2 (PaymentRequirements table) — nothing in either specification closes that enum, which is why the payment dimension passes
- `house-opinion` — the v1↔v2 chain equivalence table covers the nine chains x402 clients ship with; outside it the pair is unverified, not divergent. NOT NORMATIVE
- `cdp-validator` — audit/2026-08-19/cdp-validator-toolshed.json preflight — the required set the v2 half satisfies

#### `free-tier-200` — discovery

*free tier: 200 to an unauthenticated caller*

- **10x402**: n/a
- **x402-doctor**: fail (status-not-402)
- **Class**: judgement

THE SHARPEST DISAGREEMENT IN THE CORPUS, and it now sits in the dimension it was always about. The endpoint answers an unauthenticated caller with 200. The prototype reports an error whose text is "The unpaid request returned HTTP 200; Bazaar requires HTTP 402" — one sentence carrying a transport observation and a NAMED-PROVIDER policy, and the corpus now maps that mixed-scope rule to both, rather than to payment and client interoperability alone. The prototype therefore says the declaration is ineligible at the provider it names, and it has a documented requirement to point at. 10x402 answers `n/a`, on the reading that under the corpus’s static-declaration definition there is no v2 registry declaration in this response to judge for eligibility at all: the question is not "does this fail the provider’s rules", it is "is there a declaration here". Both readings are defensible and the difference is real. What is NOT here any more is the pair of payment/client-interoperability rows this fixture used to generate. Those were an artefact of two things: the adapter filing a provider policy under the payment dimension, and the corpus expecting a `pass` where no challenge was recorded at all. Both are fixed, and the four rows are reported under § Scope-excluded with what each tool would have said.

Evidence on the fixture:

- `house-opinion` — NO CHALLENGE WAS RECORDED, so neither `pass` nor `fail` is available. A 200 to an anonymous caller declares no payment: there is nothing to interpret, nothing to settle, and nothing for a client to parse or execute. A recorded corpus cannot demonstrate payability it never recorded, and it must not manufacture a failure out of an absence either. See FORMAT.md § The recorded-challenge precondition
- `client-code` — x402-fetch@1.2.0 dist/esm/index.mjs:19-23 — `if (response.status !== 402) return response`; the client never enters the payment flow, which is why there is no client verdict to reach
- `cdp-validator` — audit/2026-08-19/cdp-validator-toolshed.json preflight returns_402 (severity: required) — a documented provider requirement this response does not meet
- `cdp-docs` — https://docs.cdp.coinbase.com/x402/seller/get-discovered — endpoints are health-probed on an interval and a non-402 is grounds for delisting

#### `redirect-instead-of-402` — discovery

*a redirect instead of a 402*

- **10x402**: n/a
- **x402-doctor**: fail (status-not-402)
- **Class**: judgement

A 307 where the 402 was advertised, and the same mixed-scope rule as `free-tier-200`. The prototype fetches with `redirect: "manual"`, sees the 307, and reports that the advertised URL does not answer 402 — which for the named provider is exactly right, because the provider probes the advertised URL and not the final one. 10x402 answers `n/a`: this response carries no v2 declaration, so under the static-declaration reading there is nothing to judge for eligibility. Neither tool can say what is at the other end of the redirect, and the corpus no longer pretends otherwise — the target response is not in the recording, so payment and client interoperability are `n/a` for both. The right fix for that is to record the target response as a second exchange, not to infer a verdict from a Location header, and it is noted on the fixture as the concrete next thing this corpus should carry.

Evidence on the fixture:

- `house-opinion` — THE TARGET RESPONSE IS NOT IN THE RECORDING. The fixture is a 307 and a Location header; whatever the target answers was never captured, so "the envelope is reachable" is an assumption and not an observation. Payment and client interoperability are therefore `n/a`. See FORMAT.md § The recorded-challenge precondition
- `client-code` — @x402/fetch@2.23.0 dist/esm/index.mjs:10 — `await fetch(request)`, the default redirect mode, so a live client WOULD follow the redirect. That is why the corpus does not fail this fixture; it is not why it could pass one
- `cdp-validator` — audit/2026-08-19/cdp-validator-toolshed.json preflight returns_402 (severity: required) — the provider probes the ADVERTISED url, and this one does not answer 402

## Same verdict, different reason

These rows agree on whether the fixture passes and disagree on why. They matter because the reason is what a seller acts on: two tools can both say "not indexable" and send the operator to two different lines of JSON.

| fixture | dimension | 10x402 | x402-doctor |
| --- | --- | --- | --- |
| `calibration-spec-canonical-402` | discovery | fail (bazaar-extension-absent) | fail (bazaar-input-shape) |
| `calibration-cloudflare-batch-settlement` | discovery | fail (network-unsupported-by-provider, bazaar-extension-absent) | fail (bazaar-input-shape) |
| `calibration-solana-spec-envelope` | discovery | fail (bazaar-extension-absent) | fail (bazaar-input-shape) |
| `no-envelope-html-body` | payment | fail (envelope-not-json, envelope-absent) | fail (envelope-absent) |
| `no-envelope-html-body` | client_interop | fail (envelope-not-json, envelope-absent) | fail (envelope-absent) |
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

## Scope-excluded

A dimension the CORPUS cannot judge from the recording it holds. Both tools are held to `n/a` here, so these rows are excluded from the agreement figures rather than counted as agreements — two implementations forced to the same non-answer have not agreed about anything. **The opinion is not discarded with the verdict**: whatever each tool would have reported is kept in its results file under `scope_suppressed` and printed below.

| fixture | dimension | 10x402 would say | x402-doctor would say | why excluded |
| --- | --- | --- | --- | --- |
| `free-tier-200` | payment | nothing to report | fail (status-not-402) | no challenge is recorded in this fixture |
| `free-tier-200` | client_interop | observed only: free-tier-200 | fail (status-not-402) | no challenge is recorded in this fixture |
| `redirect-instead-of-402` | payment | observed only: redirect | fail (status-not-402) | no challenge is recorded in this fixture |
| `redirect-instead-of-402` | client_interop | observed only: redirect | fail (status-not-402) | no challenge is recorded in this fixture |

Both fixtures are cases where the response contains no payment declaration at all: a 200 to an anonymous caller, and a 307 whose target response was never captured. The mechanical rule is published with the corpus — `judgeableFrom()` in `corpus/vocabulary.mjs`, and the `judgeable` block on every fixture — so a third adapter reaches the same set from the file rather than from a convention. The right way to make the redirect case judgeable is to record the target response as a second exchange; inferring payability from a Location header is not the same thing and the corpus no longer does it.

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

25 of 102 dimension-verdicts fell into this category.

## Where 10x402 was wrong

Running someone else’s implementation over our own fixtures found two defects in ours. Both are fixed in the commit this report was generated from; both were found by a CALIBRATION fixture rather than by a broken one, which is the argument for keeping known-good documents in a corpus of broken ones.

1. **A provider’s price floor applied outside the provider’s own domain.** `V2_AMOUNT_MINIMUM` enforced CDP’s 1000-atomic-unit minimum on every offer. On the Cloudflare batch-settlement profile — `network: "cloudflare:402"`, `asset: "USD"`, `amount: "1"`, one cent in ISO 4217 — it reported a spec-defined 402 as too cheap to index, for an index that does not carry that network at all. This is precisely the failure mode the thread named: a provider observation becoming a protocol requirement. The check is now gated on `CDP_FACILITATOR_CHAINS`, and `V2_NETWORK_SUPPORTED` already says the chain is outside CDP’s set.

2. **"Indexable" reported when nothing had been inspected.** `bazaar_ready` was computed from the ABSENCE of blocking findings. Where the registry checks could not run at all — the v2 header did not decode, or `resource` arrived as the v1 flat string, so there is no `ResourceInfo` object to read — there were no blockers, and the engine answered `true` to a seller whose envelope no indexer can read. It now answers `n/a`, joining the v1-only case under the same rule: not a failure, a question this response cannot answer. Found by `v2-resource-flat-string`.


A pre-publication accuracy review of the corpus itself (`CORPUS-REVIEW.md`) found four more, and all four were the same fault wearing different clothes — a 10x402 position deciding a dimension the corpus defines as belonging to somebody else’s document:

3. **A house rule as a normative payment failure.** `dual-payto-divergence` expected `payment: fail` while its own evidence said, in capitals, that no specification requires a dual-stack seller’s two envelopes to agree. The same non-normative reason was added to `v2-payto-array`’s otherwise legitimate failure. Both are gone: the adapter rule is now that a finding with no operative `spec` or `client-code` citation FAILS NOTHING and is recorded as an observation, and the `DUAL_*` override that forced the family into `payment` regardless has been deleted. The house position survives in the results file, where an unsourced rule belongs.

4. **A contextual spec citation counted as authority.** The adapter read "this check cites the specification somewhere" as "this check may fail the payment dimension", so the base64url family failed `payment` on the strength of a transport-spec line that says the header is "Base64-encoded" and is SILENT on the alphabet — a fact 10x402’s own provenance audit records in as many words. Citations are now marked operative or contextual in the check catalogue, the provenance that decided each finding’s dimensions is written into the results file beside it, and both base64 fixtures pass `payment` and fail `client_interop`.

5. **A pass where nothing had been recorded.** `free-tier-200` and `redirect-instead-of-402` expected `payment: pass` and `client_interop: pass`. The first contains no payment declaration; the second contains a 307 and a Location, and not the response at the other end of it. Those passes reproduced 10x402’s warning severities as fixture truth. Both dimensions are now `n/a` on both fixtures and excluded from the statistics — see § Scope-excluded.

6. **A discovery verdict with no named provider.** Eighteen non-`n/a` discovery expectations carried no provider evidence at all, while the dimension’s own question named a provider. The dimension is now defined narrowly as STATIC DECLARATION ELIGIBILITY, every non-`n/a` discovery verdict carries a structured `discovery_target` naming the provider and the documented requirement it turns on, and the builder refuses to emit one that does not. Indexed, listed and crawled outcomes are reserved for a live adapter and are out of scope here — including on the live positive control, whose `index.active: true` capture is recorded and explicitly is not the basis of its verdict.

## Reproducing

```sh
node corpus/build-fixtures.mjs       # regenerate corpus/fixtures.json — BYTE-IDENTICAL unless a fixture changed
node corpus/run-10x402.mjs           # → corpus/results-10x402.json (asserts the pinned engine blobs first)
node corpus/run-x402-doctor.mjs      # clones the prototype to a temp dir → corpus/results-x402-doctor.json
node corpus/report-disagreements.mjs # → DISAGREEMENTS.md
node corpus/validate-results.mjs corpus/results-10x402.json   # the third-adapter conformance test
npm test                             # the corpus phase asserts run-10x402 reproduces every expectation
```

A third implementation joins by writing an adapter, emitting a results file in the shape `corpus/schema/results.schema.json` defines, and running `corpus/validate-results.mjs` against it. That script is the conformance test: it checks the file against the schema, that every fixture is answered, that reason tags are drawn from the vocabulary and are fatal ones, that `n/a` and `not-evaluated` are used the way the format defines them, and that the scope rules were applied. It needs nothing from this repository’s engine and imports no worker code.

Generated by `corpus/report-disagreements.mjs` from results dated 2026-08-20 and 2026-08-20.
