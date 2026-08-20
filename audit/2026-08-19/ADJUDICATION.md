# Adjudication — the 64-check accuracy audit (2026-08-19)

Five auditors (fable-spec-truth, opus-false-positives, opus-false-negatives,
codex-spec-conformance, codex-fixtext-severity; JSONLs in `audit/`) returned
14/64 unanimous CONFIRMED. This document is the binding merge. Where an
auditor is cited, its JSONL row carries the exact provenance — implementers
read those rows, this file decides.

## The structural ruling: three regimes, two verdict dimensions

The single largest source of "disagreement" was auditors judging one rule
against different authorities. All three authorities are real; the fix is to
stop collapsing them into one grade:

- **regime: payment** — governed by the specs' MUSTs and what shipping
  clients (@x402/core, @x402/evm, x402-fetch/x402@1.2.0) parse or throw on.
  These findings drive the **grade** (A–F ladder unchanged).
- **regime: bazaar** — governed by CDP's validator/prober/docs (the pinned
  indexing set from fable-spec-truth: 402 + PAYMENT-REQUIRED, x402Version 2,
  https absolute resource.url, amount ≥ 1000, maxTimeoutSeconds, bazaar
  extension with info + schema + info.input with method matching the probed
  verb; description ≤ 500 chars; output/example advisory). These findings
  drive a new summary dimension **`bazaar_ready: true|false|"n/a"`** with
  blockers listed — they do NOT drive the grade unless also payment-breaking.
- **regime: hygiene** — house/client-quirk defenses that break no payment
  and block no indexing. info only. Never grade-affecting.

Every check gets a `regime` field and a `sources: [{kind, ref}]` array — the
merged winning provenance from the audit (kinds: spec | client-code |
cdp-docs | cdp-validator | live | field-report | house-opinion). `/check`,
the site checklist, and the report all carry both. This is the owner's
provenance requirement: when a source of truth moves, the affected checks
are greppable by ref.

**Calibration invariants (new tests, written to fail first):**
1. The v2 spec's own canonical 402 example (transports-v2/http.md) grades **A**.
2. bazaar.md's own worked example passes its checks (object-valued
   output.example included).
3. A spec-conformant Solana (solana:*) envelope grades **A** (kills vault-3rb9y).
4. The batch-settlement `cloudflare:402` / payTo `"merchant"` profile
   produces no core error.
5. worker/positive-control.js still grades A, and 10x402's own 402 still
   self-lints A.

## Cluster rulings

### A. Scheme/network dispatch (kills the EVM hardcoding)
V2_PAYTO, V1_PAYTO, V2_ASSET, V1_ASSET, V2_NETWORK_CAIP2, V2_SCHEME_KNOWN,
V1_SCHEME, V2_EXTRA_EIP712, V1_EXTRA_EIP712.

Validation dispatches on the accept's (scheme, network namespace):
- `eip155:*` → 0x/20-byte payTo, 0x asset address, and (scheme `exact`,
  assetTransferMethod eip3009 or v1 legacy) `extra.name`+`extra.version`
  REQUIRED at **error** (fable: scheme_exact_evm.md marks them required;
  @x402/evm throws at payment creation — payment-breaking, regime payment).
  Permit2/erc7710/SVM entries are exempt from the EIP-712 requirement.
- `solana:*` → base58 payTo/asset shape.
- Other/unknown namespace (incl. `cloudflare:402`) → structural checks only
  (non-empty string payTo/asset) + info "namespace not deeply validated".
- Network syntax: follow @x402/core's actual acceptance (contains `:`,
  sensible charset — implementer cites the regex from the client source),
  with CAIP-2-proper (3–8 char namespace) as an info-level style note when
  violated. eip155 chain-ids outside the CDP facilitator set → bazaar-regime
  warn ("not facilitator-supported"), never grade-affecting.
- v1 scheme: derive the legal enum from x402@1.2.0's zod source (cite
  file:line); non-member → **error** regime payment (the v1 client's zod
  enum hard-throws). v2 unknown scheme stays info (extensible by design),
  but `exact`/`upto` recognized per CDP.
- Type strictness everywhere in this cluster: payTo/asset/network must BE
  strings — kill the `String(x||'')` coercions (an array grading A is a
  hole, opus-false-negatives has the probes).

### B. Severity inversions on Required fields (the silent killers)
- V2_MAX_TIMEOUT, V1_MAX_TIMEOUT → **core error** when missing or not a
  positive JSON number (spec Required + zod-required + BigInt("NaN") throw;
  fable + 3 others agree). Kill the Number() coercion that blessed "60".
- V1_MIMETYPE, V1_DESCRIPTION → missing = **error** regime payment
  (x402@1.2.0's zod requires both; a v1 body without them is unparseable by
  every v1 client — client-code provenance beats the spec's "Optional"
  label, and BOTH sources go in `sources`). Empty-string description → warn.
- V1_EXTRA_EIP712 → missing extra = **error** (fable: v1 legacy client signs
  from extra with no fallback; every v1 EVM payment fails signature).
- V2_AMOUNT_ATOMIC → syntax stays payment-regime; add bazaar-regime error
  when < 1000 atomic units (CDP's $0.001 floor, cdp-validator provenance).

### C. The isV1Attempt cascade (v2-echo false F)
- `isV1Attempt()` additionally requires the body's `x402Version !== 2`: a
  body declaring itself v2 is never a v1 attempt.
- VERSION_BODY_SAYS_V2 → **warn**, regime hygiene→payment? No: warn, regime
  payment (v1 clients that read bodies will misparse it), NOT core. Message
  drops the "5 core errors" cascade by construction.
- V1_BODY_NOT_ENVELOPE → **info** (transports-v2 makes bodies a server
  concern; the spec's own example serves `{}` — an info must not stop the
  spec's canonical example from grading A).
- V1_ABSENT stays info; fix text gains the CDP note: the validator lists
  `valid_json` as required, so an EMPTY 402 body may block indexing — serve
  at least `{}` (cdp-validator provenance).

### D. DUAL_* ordering (false F on reordered offers)
Match pairs across the two arrays by (network-chain, asset) before
comparing payTo/price — never index-by-index. Genuine divergence within a
matched pair stays **core error**. No matchable pair → info ("offers do not
overlap across versions; could not verify agreement"). All five DUAL checks
keep regime payment.

### E. Bazaar metadata (regime moves, not deletions)
- V2_RESOURCE_METHOD → the spec-true home is `bazaar.info.input.method`;
  check THAT, against the probed verb, at bazaar-regime **error**
  (CDP matches_request is required-tier). A `resource.method` mismatch with
  input.method becomes a warn; absence of resource.method alone is silent.
- V2_RESOURCE_URL → https + absolute = bazaar-regime **error** (CDP
  url_https required); non-URL string also payment-regime warn (it feeds
  paymentPayload.resource per @x402/core — name that consequence in the fix
  text, per opus-false-negatives' #3045 finding).
- V2_RESOURCE_DESCRIPTION → absent: info. Over 500 chars: bazaar-regime
  error (CDP facilitator-rejection, confirmed verbatim in CDP docs). The
  unsourced "500 chars" claim in the old fix text is now SOURCED — keep it
  with the cdp-docs ref.
- V2_SERVICE_NAME, V2_TAGS → absent: silent. Present-but-invalid (>32 chars,
  non-printable-ASCII, >5 tags): **warn**, bazaar regime (bazaar.md caps,
  spec provenance).
- V2_RESOURCE_MIMETYPE → absent: silent; present-but-nonsense: info.
- V2_BAZAAR_OUTPUT_EXAMPLE → accept ANY defined JSON value (bazaar.md types
  it `any`; its own example is an object). Absent → info, bazaar regime,
  labeled CDP-advisory. The nonEmptyString predicate is WRONG — five-lens
  consensus.
- V2_BAZAAR_INPUT → bazaar-regime **error** (CDP required tier), and
  validate the input union properly including `type` (#3045 bug 4).
- V2_BAZAAR_SCHEMA → add the content MUSTs from bazaar.md §315-322; and the
  json-schema subset MUST emit an explicit "unable to validate: unresolvable
  $ref" finding instead of silently skipping (#3045 bug 5 — this silent
  skip is the exact production failure).
- V2_BAZAAR_INFO_VALIDATES predicate itself was confirmed sound (opus-FP:
  13 legal shapes pass); it inherits the $ref-honesty fix above.

### F. HTTP layer
- HTTP_STATUS_402 → 405/404 to the default POST: **not core** — report at
  error with the fix text suggesting `{"method":"GET"}` retry (a conformant
  GET-only endpoint must not F on our verb guess). A reachable 200/401/403
  stays core. 4xx-with-envelope still lints the envelope.
- HTTP_REDIRECT → stays warn (fable confirmed); fix text: lint the final
  URL, and note apex/www and trailing-slash as the common causes.
- HTTP_FREE_TIER_200, HTTP_CONTENT_TYPE_JSON, V2_SCHEME, V1_OUTPUT_SCHEMA,
  V1_BODY_PRESENT, VERSION_HEADER_SAYS_V1, DUAL_RESOURCE,
  V2_RESOURCE_URL_MATCHES: rules stand; take the fix-text/summary
  corrections from codex-fixtext-severity's rows (it verified 62/64 fixes
  clear their finding — its WRONGs are text-accuracy, not rule truth; e.g.
  V2_HEADER_PRESENT's "never falls back to the body" is FALSE, @x402/core
  falls back — rewrite that sentence, and v1-only is invisible to the
  BAZAAR, not to current buyers).
- VERSION_HEADER_SAYS_V1 → keep error, **drop core** (fable: the header
  union legally admits x402Version 1; @x402/evm ships a v1 client).
- V1_DISCOVERABLE → the flag is opt-OUT (reference extractor defaults true
  when absent — fable's go-source provenance). Absent = silent;
  `discoverable: false` = info "explicitly opted out of discovery".
- V2_B64_URLSAFE → test the RAW header value (no trim) — @x402/core tests
  raw; whitespace-padded base64 must fire (opus-FN probe). Base64 rule
  itself fully confirmed against the client regex.
- V2_NETWORK_CAIP2 / V1_NETWORK_NAME → per cluster A; v1 network enum
  membership enforced at error with x402@1.2.0 zod provenance (implementer:
  read the actual NetworkSchema source and resolve the opus-FP/opus-FN
  disagreement about whether it admits CAIP-2 — whichever the source says
  WINS and gets the file:line cite in `sources`).
- V1_RESOURCE_STRING → absolute-URL required at **error** (z.string().url()
  in both v1 clients; #3045 bug 3's v1 mirror). The v1-cascade gate from
  cluster C applies.

### G. Report honesty
- FINDINGS_TRUNCATED → make it reachable and honest: it fires whenever ANY
  bound clipped the report (accepts cap, findings cap, body byte cap). The
  accepts-skip info merges into it. A check that cannot fire is dead weight.
- checks_run semantics unchanged; `summary.partial` unchanged.
- NEW: `summary.bazaar_ready` (true | false | "n/a" for v1-only) computed
  from bazaar-regime errors, with blocker ids listed.

### H. Out of scope for this pass — filed, not silently dropped
- The request-header contract probe (#3045 bug 2: PAYMENT-SIGNATURE vs
  X-PAYMENT) needs a second outbound request — product roadmap, not a lint
  predicate. File as a beads task (10x402 v1.1 "paid-path probe").
- Multi-accept cross-entry coherence beyond DUAL pairing — existing deferred
  item stands.

## Count discipline

Checks may be added (input.type, schema content MUSTs, discoverable-opt-out
reframe) and none deleted; the catalog count WILL change. Every surface that
says "64" (site copy, README, MCP descriptions, EXAMPLE_MARK-style test
constants, the pill badge) derives from `CHECKS.length` or gets updated —
grep for `64` is part of the definition of done. The self-lint invariant and
all five calibration invariants above gate the result.
