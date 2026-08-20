# Pre-publication accuracy review: portable x402 conformance corpus

Date: 2026-08-20
Recommendation: **HOLD — do not offer the corpus upstream in its current form.**

The corpus has a strong basic shape: it preserves three result dimensions, keeps
`not-evaluated` distinct from pass, invokes the suite's response builders for the
suite-derived fixtures, and reports reproducible agreement counts. The hold is about
truth at the dimension boundaries. The current expectations and adapters still let a
10x402 house rule decide the normative `payment` outcome, claim provider-specific
`discovery` outcomes without provider evidence, and convert unknown/no-challenge cases
into passes. Those are exactly the distinctions the issue-thread contract asks the
corpus to preserve.

## Review limitation

The requested command

```sh
gh api repos/x402-foundation/x402/issues/3104/comments --jq '.[].body'
```

could not connect to `api.github.com` in this sandbox, and the live-browser fallback was
unavailable. I therefore reviewed against the maintainer contract quoted in the review
request (pinned versions, unchanged fixture semantics, three independent outcomes,
evidence classifications preserved, provider observations not promoted to protocol,
and disagreements reported without forcing a winner) plus the public issue body. This
limitation should be cleared before publication if the quoted contract was not complete.

## 1. Fixture truth — HOLD

I checked 12 fixtures: all five calibration fixtures, all three constructed fixtures,
and four adversarial/judgement fixtures. The three constructed fixtures are exactly
`v2-timeout-absent`, `v2-asset-ticker-not-address`, and `solana-dual-stack`.

| fixture | payment | client_interop | discovery | review |
| --- | --- | --- | --- | --- |
| `calibration-spec-canonical-402` | supported pass | plausible but uncited pass | supported CDP-rule fail | Partial: no client-code citation supports the client verdict. |
| `calibration-live-positive-control` | supported pass | plausible but uncited pass | supported but uncited pass | The provenance pack records `index.active` and an accepted simulation, but the fixture omits that provider evidence. |
| `calibration-bazaar-spec-example` | supported pass | unsupported pass | unsupported pass | Spec conformance alone proves neither a pinned client execution nor named-provider indexing. |
| `calibration-cloudflare-batch-settlement` | supported pass | unsupported pass | provider-uncited fail | The scheme profile makes timeout optional, but a generic network-string schema does not prove an executable Cloudflare client. |
| `calibration-solana-spec-envelope` | supported pass | unsupported pass | provider-uncited fail | The SVM scheme example supports payment; no client or provider is cited for the other two outcomes. |
| `v2-timeout-absent` | supported fail | supported fail | unsupported pass | The exact-EVM failure follows; provider indexing does not. |
| `v2-asset-ticker-not-address` | supportable fail | supportable fail | unsupported pass | The EVM signer is the authority, but the fixture incorrectly says the generic core schema requires an address. |
| `solana-dual-stack` | supported pass | only parse-level support | unsupported pass | The citations show shapes/enums, not an executed v2 SVM payment or registry acceptance. |
| `v2-header-b64-whitespace` | unsupported fail | context-dependent fail | supported `n/a` | Its only evidence is client code; HTTP removes the whitespace before a live client sees it. |
| `dual-payto-divergence` | **incorrect fail** | plausible but incompletely supported pass | unsupported pass | The payment failure is explicitly a house opinion; execution through both client generations is not demonstrated. |
| `free-tier-200` | unsupported pass | contract-undecided pass | reasonable discovery `n/a` | No payment is declared; the format does not say whether payment/client are `n/a`, fail, or outside corpus scope. |
| `redirect-instead-of-402` | unsupported pass | incompletely supported pass | reasonable discovery `n/a` | Default-follow is cited, but the target response is absent, so successful payability is not demonstrated. |

### Blocking fixture problems

1. **A house opinion is made a normative payment requirement.**

   `FORMAT.md` defines `payment` as settlement validity "per the normative
   specification" (`corpus/FORMAT.md:23-27`). Nevertheless,
   `dual-payto-divergence` expects `payment: fail(dual-divergence)`
   (`corpus/build-fixtures.mjs:568-575`; generated form
   `corpus/fixtures.json:1199-1223`) while its evidence says, in capitals, that this is
   "NOT A PROTOCOL REQUIREMENT" and labels it `house-opinion`. Neither pinned version
   defines a cross-version equality invariant. The same non-normative reason is added
   to the otherwise legitimate `v2-payto-array.payment` failure
   (`corpus/build-fixtures.mjs:558-565`). Honest labelling is good, but it does not make
   a house rule a valid failure reason in a normative dimension.

2. **Provider-specific discovery verdicts are routinely asserted without a provider
   observation.**

   The format asks whether metadata "will ... be accepted and indexed by the cited
   provider" and says provider observations are labelled everywhere they appear
   (`corpus/FORMAT.md:23-33`). A generous count that treats `field-report` as
   provider-related still finds 18 non-`n/a` discovery expectations with none of
   `provider-observation`, `cdp-validator`, `cdp-docs`, or `field-report` evidence.
   Examples include:

   - `calibration-bazaar-spec-example.discovery: pass`
     (`corpus/build-fixtures.mjs:358-367`),
   - `calibration-cloudflare-batch-settlement.discovery: fail`
     (`corpus/build-fixtures.mjs:370-384`),
   - `calibration-solana-spec-envelope.discovery: fail`
     (`corpus/build-fixtures.mjs:387-398`), and
   - `solana-dual-stack.discovery: pass`
     (`corpus/build-fixtures.mjs:673-686`).

   The live positive control is a different provenance defect: repository evidence does
   support its discovery pass (`index.active: true`, a crawl timestamp, and
   `simulation.outcome: "accepted"` in
   `audit/2026-08-19/cdp-validator-toolshed.json:1`), but the fixture cites only the
   seller capture and specs (`corpus/build-fixtures.mjs:335-355`). The provider evidence
   must be attached to the fixture before it is portable.

   This cannot be repaired by treating the Bazaar specification as a provider. The
   pinned Bazaar document says storage/indexing is an implementation detail
   (`.groundtruth/spec-repo/specs/extensions/bazaar.md:422-429`). Either redefine the
   dimension narrowly as static declaration eligibility, or name a provider on each
   fixture and require provider evidence before emitting pass/fail.

3. **No challenge and an unseen redirect target are counted as successful payment
   outcomes.**

   `free-tier-200` and `redirect-instead-of-402` both expect payment and client interop
   to pass (`corpus/build-fixtures.mjs:590-614`). The first contains no payment
   declaration. The second contains only a 307 and a Location; it does not record the
   target's alleged 402. The evidence even calls that envelope "unread". These cases are
   not demonstrated passes. Their pass values reproduce 10x402's warning severities,
   which is tool behaviour, not fixture truth. The existing format does not decide
   whether no-challenge payment/client outcomes should be `n/a`, fail, or excluded; it
   must define that boundary first. `n/a` or exclusion is the safer resolution for a
   recorded-response corpus that lacks a declared payment or redirect target.

4. **The whitespace fixture puts a client-specific raw-input opinion into `payment`.**

   `v2-header-b64-whitespace` fails both payment and client interoperability with only a
   `client-code` citation (`corpus/build-fixtures.mjs:446-457`). The 10x402 audit itself
   says the transport specification is silent on the Base64 alphabet and the client
   resolves the ambiguity (`audit/2026-08-19/fable-spec-truth.jsonl:8`). More
   importantly, the fixture notes concede that HTTP strips this whitespace before a
   live client sees it. A raw map/pasted-response client-interoperability test may be
   useful, but it is not evidence of normative payment failure. The format must also say
   whether `response.headers` represents raw wire syntax or parsed field values.

5. **Several client-interoperability passes lack client evidence or prove parsing but
   not execution.**

   The canonical, live-control, Bazaar-example, and Solana calibration fixtures all
   pass `client_interop` without a `client-code` evidence entry
   (`corpus/build-fixtures.mjs:315-398`). Cloudflare cites only
   `NetworkSchemaV2`, which proves the string contains a colon, not that a pinned client
   can execute `batch-settlement` on `cloudflare:402`
   (`corpus/build-fixtures.mjs:375-380`). This matters because the dimension promises
   both parse **and execute**, not shallow schema acceptance.

6. **Two client-code references are materially inaccurate.**

   - `v2-asset-ticker-not-address` says `@x402/core` requires an eip155 asset to be an
     address (`corpus/build-fixtures.mjs:540-546`; `corpus/fixtures.json:1065-1073`).
     The pinned core schema is `asset: NonEmptyString`; address validation occurs later
     in the EVM signer (`audit/2026-08-19/fable-spec-truth.jsonl:19`). The failure can
     stand, but the evidence must cite the signer/scheme.
   - Both Base64 fixtures locate `Base64EncodedRegex` in
     `dist/cjs/schemas/index.js` (`corpus/build-fixtures.mjs:439-449`). The provenance
     pack locates the regex in the utility chunk and its use in the HTTP/client chunk
     (`audit/2026-08-19/fable-spec-truth.jsonl:8`).

7. **Minor provenance text drift:** the builder header says "Four more" cases were
   constructed (`corpus/build-fixtures.mjs:9-11`), while the actual corpus and
   `FORMAT.md:203-210` correctly say three.

### Positive finding

`amount-below-cdp-floor` keeps CDP's `>= 1000` observation in `discovery` while
payment and client interop pass (`corpus/build-fixtures.mjs:659-670`). Its
`cdp-validator` / `house-opinion` classification is honest. This is the separation the
rest of the corpus should consistently follow.

## 2. Contract fidelity vs the issue thread — HOLD

### What passes

- All five pin keys currently required by the corpus test are present
  (`corpus/fixtures.json:7-34`;
  `test/corpus.test.mjs:35-45`). The 10x402 pin `853ed3f5...` resolves in the local
  repository. The x402 spec pin `75b519d0...` resolves in the checked provenance clone.
  The doctor prototype pin `37233104...` resolves in the runner's retained temporary
  clone.
  The current `worker/lint.js` and `test/fixtures/envelopes.mjs` blobs are byte-identical
  to their blobs at the 10x402 pin.
- The 26 suite-derived corpus responses all exactly match the current/pinned suite
  builders. `fromSuite()` really finds the suite fixture and invokes `found.response()`
  (`corpus/build-fixtures.mjs:98-103`); assembly copies its response and context
  (`corpus/build-fixtures.mjs:692-711`). The semantics-unchanged claim is credible for
  the selected 26 fixtures.
- Three expectations are present everywhere, and expectation `pass` / `fail` / `n/a`
  is kept separate from result-only `not-evaluated` (`corpus/FORMAT.md:43-65`;
  `corpus/vocabulary.mjs:200-203`; `test/corpus.test.mjs:77-105`).
- `DISAGREEMENTS.md` explicitly disclaims an overall winner (`DISAGREEMENTS.md:1-5`).

### Contract problems

1. **The pin/reproduction path can silently mislabel the code that ran.**

   The fixture builder records whatever repository `HEAD` is at regeneration time
   (`corpus/build-fixtures.mjs:40-46`), while `run-10x402.mjs` imports the current
   `../worker/lint.js` and copies the old corpus pin into its result metadata
   (`corpus/run-10x402.mjs:42-43,133-144`). Today the worker blob happens to equal the
   pinned blob, so the committed result is substantively accurate. There is no guard
   preserving that fact after the next engine edit. Also, the reported 10x402 commit
   predates both the adapter and the corpus, so checking out the reported commit does
   not reproduce the reported command. Pin the engine blob/commit independently and
   assert it before execution; do not derive the published pin from moving `HEAD`.

2. **Regeneration is nondeterministic and the claimed unchanged-fixture test does not
   test bytes.**

   `build-fixtures.mjs` writes the current date and current HEAD
   (`corpus/build-fixtures.mjs:42-46,729-759`). Running the documented reproduction
   command at current HEAD would change `generated` and the 10x402 pin even when no
   fixture or engine semantics changed. The test named "exported unchanged" checks
   only that origin strings have the expected prefix
   (`test/corpus.test.mjs:194-207`); it does not invoke the builders or compare response
   bytes. Add a deterministic rebuild/diff gate.

3. **Not every verdict dependency is pinned despite the claim in `FORMAT.md:190-199`.**

   Fixture evidence cites unversioned `@x402/evm`
   (`corpus/build-fixtures.mjs:517-520,552-555`), and cites
   `@x402/fetch@2.23.0` without a corresponding pin key
   (`corpus/build-fixtures.mjs:607-613`). It also treats the separate
   `x402-fetch@1.2.0` package as covered by the `x402` pin
   (`corpus/build-fixtures.mjs:52-54,82-85`). The doctor runner installs
   `@x402/extensions@2.23.0`, a result-affecting dependency absent from the corpus pins
   (`corpus/run-x402-doctor.mjs:68-94,326-345`). The client packages are not declared or
   locked in this repository's `package.json`/`package-lock.json` either. Pin every
   package named by evidence or execution, preferably with registry integrity hashes.

4. **Offline rules are not preserved at per-fixture granularity.**

   Ten doctor rules are declared not evaluable offline
   (`corpus/vocabulary.mjs:182-198`), but `mapReport()` records a per-fixture skipped rule
   only if that rule appeared in `report.findings`
   (`corpus/run-x402-doctor.mjs:223-226`). In the committed results, normally only
   `x402.bazaar.lookup` appears per fixture; the other nine exist only in a top-level
   list. Dimension-level `not-evaluated` is not conflated with pass, which is good, but
   the evidence of exactly which rules ran/skipped is incomplete.

## 3. Adapter honesty — HOLD

### What passes

- The 10x402 check-id-to-tag table is total for all 75 checks and is gated by a test
  (`corpus/vocabulary.mjs:71-148`; `test/corpus.test.mjs:120-136`).
- The doctor tag and dimension tables cover every **evaluated** rule that appeared in
  the committed results; offline-only rules such as `x402.bazaar.lookup` bypass those
  tables via the skip set. `tool_detail.unmapped` is empty throughout
  (`corpus/vocabulary.mjs:150-180`; `corpus/run-x402-doctor.mjs:169-198`).
- Both adapters apply the same explicit error-only failure threshold, so warnings and
  notes remain observations (`corpus/run-10x402.mjs:83-105`;
  `corpus/run-x402-doctor.mjs:213-255`).

### Distortions

1. **10x402's source-to-dimension map is too coarse and flatters 10x402 on the
   whitespace case.**

   `dimensionsFor()` treats the presence of any `spec` source on a check as authority
   for every instance of that check to fail `payment`
   (`corpus/run-10x402.mjs:47-57`). `V2_B64_URLSAFE` has a generic transport-spec
   citation plus client-code citations (`worker/lint.js:434-440`), so the adapter maps
   the whitespace instance to payment even though that fixture's evidence is client
   code only. Provenance must be attached to the particular finding/rationale, not
   inferred from any source ever attached to the check id.

2. **The documented DUAL override directly violates the payment dimension.**

   The adapter forcibly maps every `DUAL_*` check to payment
   (`corpus/run-10x402.mjs:28-36,47-56`) even though `worker/lint.js:880-914` identifies
   the family as house positions. This makes 10x402 reproduce a 10x402 house rule as
   corpus truth. Labelling the source does not preserve the normative boundary when the
   label still decides the verdict.

3. **10x402 discovery is an engine self-report, not a provider observation.**

   The adapter collects Bazaar findings and then overwrites the verdict from the
   engine's own `summary.bazaar_ready`, clearing failure reasons on pass/`n/a`
   (`corpus/run-10x402.mjs:83-105`). The corpus test then requires the hand-authored
   expectations to equal that same adapter (`test/corpus.test.mjs:138-156`).
   `FORMAT.md:225-230` correctly calls this a regression gate rather than an oracle, but
   it cannot support claims that discovery passes at a named provider.

4. **The doctor adapter mislabels a missing header as undecodable Base64.**

   `paymentRequiredTag()` falls through to `b64-undecodable` whenever the detail does
   not say "listed no terms" and the raw header is not visibly Base64URL
   (`corpus/run-x402-doctor.mjs:200-210`). For `perfect-v1-only` and
   `no-envelope-html-body`, the prototype detail explicitly says there was no header,
   yet the result adds `b64-undecodable`. This distorts the prototype's observation and
   makes the 10x402 diagnosis look more precise. Missing input should map to
   `envelope-absent`; undecodable input requires an actual header.

5. **A mixed provider/transport doctor rule loses its provider scope in mapping.**

   `x402.http.challenge_status` emits "Bazaar requires HTTP 402" in the committed
   result. That text mixes a transport observation (the final response is not 402) with
   a named-provider policy, but the adapter maps it only to `payment` and
   `client_interop` (`corpus/run-x402-doctor.mjs:169-181`; see the generated analyses at
   `DISAGREEMENTS.md:188-217`). This creates the four free-tier/redirect disagreements
   while discarding the scope stated by the prototype. Preserve both the rule and its
   provider wording, then specify whether such a mixed finding maps to discovery,
   payment/client, multiple dimensions, or remains unmapped; discovery-only is not
   established until the no-challenge/redirect contract is settled.

## 4. `DISAGREEMENTS.md` accuracy — HOLD (statistics PASS; analysis HOLD)

### Statistics: PASS

Independent recomputation from `corpus/results-10x402.json` and
`corpus/results-x402-doctor.json` exactly reproduces:

| measure | recomputed |
| --- | ---: |
| total dimension verdicts | 102 |
| comparable | 75 |
| agreed | 57 |
| disagreed | 18 |
| not comparable | 27 |
| same verdict, different reason set | 12 |

Thus the published `57/75`, `18`, and `27` figures and percentages are correct
(`DISAGREEMENTS.md:21-30`; computation in
`corpus/report-disagreements.mjs:223-255,310-319`). None of the 27
`not-evaluated` rows is counted as a pass.

### Analysis: HOLD

- The document explicitly says no overall winner and candidly records two historical
  10x402 defects (`DISAGREEMENTS.md:1-3,269-277`). That is good.
- The central diagnoses for Cloudflare optional timeout, the prototype's v2-only
  scope, v1 CAIP-2 spelling, missing EIP-712 data, array-to-string coercion, and the
  unmapped v1 chain are technically supported and neutrally describe coverage/scope
  differences (`DISAGREEMENTS.md:65-97,112-157,173-186`). This does not cure the
  fixture-evidence gaps identified above, but those six analyses do not force a winner.
- The whitespace analysis says "neither tool is wrong" while the corpus makes the
  10x402 answer the expected normative payment result
  (`DISAGREEMENTS.md:98-110`). The analysis relies on speculative non-HTTP stored
  declarations, not fixture evidence, and does not resolve the raw-vs-parsed-header
  contract.
- The redirect analysis says default-follow means "the envelope is reachable"
  (`DISAGREEMENTS.md:204-217`), but the fixture records no response at the Location
  target. Reachability is an assumption, not an observation. The current pass is
  unsupported unless the target response is added; the format must decide whether that
  leaves `n/a`, fail, or an out-of-scope fixture.
- The free-tier analysis identifies the prototype text as a Bazaar rule but the adapter
  itself placed that rule into payment/client interop
  (`DISAGREEMENTS.md:188-202`; `corpus/run-x402-doctor.mjs:169-181`). This is partly an
  adapter-placement disagreement, not two tools independently reaching protocol
  verdicts.
- The missing-header-to-`b64-undecodable` adapter error feeds the prose claim that the
  prototype reports the same absence twice (`DISAGREEMENTS.md:228-244`). The duplicate
  prototype findings are real; the second reason tag is not.
- `dual-payto-divergence` is presented honestly as a live scope question and explicitly
  non-normative (`DISAGREEMENTS.md:158-171`), but the corpus still forces the 10x402
  house position as `expected.payment`. That contradicts the report's stated neutrality.

The prose does not declare a single overall winner, but the expected verdicts and a few
adapter choices still adjudicate disputed cases in 10x402's favour. Fixing those choices
will necessarily change the agreement table and requires regenerating this document.

## 5. Format quality for an upstream audience — HOLD

A maintainer can understand the intent of `FORMAT.md`, but cannot implement a reliably
comparable third adapter without making material choices the format does not specify:

1. There is no JSON Schema (or equivalent normative schema) for either fixtures or
   result files. Required/optional fields, allowed extra fields, result identity, and
   compatibility rules are prose-only.
2. Evidence is one fixture-wide array rather than being attached to a dimension and
   verdict. A reader cannot mechanically tell which citation supports payment, client
   interop, or discovery.
3. `client_interop` does not define its quantifier: must every cited client work, any
   cited client, or the client appropriate to the declared scheme/version? It also does
   not distinguish schema parsing from selection, signing, and execution.
4. `discovery` has no structured provider identity/version and does not distinguish
   static declaration validity, provider validation, indexing acceptance, and a live
   listing lookup.
5. `n/a` is underspecified outside discovery. The format gives two discovery examples
   (`corpus/FORMAT.md:49-54`) but no rule for no-challenge responses, redirects whose
   target is absent, or a dimension with no cited implementation/provider.
6. Result-side partial evaluation is undefined: whether a failing dimension may also
   contain skipped subrules, how skipped rules are recorded per fixture, and how a
   third tool reports an unavailable dependency or unsupported protocol version.
7. There is no normative unmapped-rule policy, mapping-completeness requirement, or
   rule for tools that do not expose error/warning/note severities.
8. The exact agreement algorithm is not specified (verdict equality, reason-tag set
   equality, treatment of observed tags, and exclusion of `not-evaluated`).
9. `response.headers` is not defined as raw wire syntax or parsed header values. The
   whitespace fixture proves the choice changes the result.
10. Pinning requirements do not define package integrity, transitive adapter
    dependencies, or how an adapter proves the code it executed matches the reported
    pin.
11. The "unchanged fixture" claim has no normative rebuild/diff procedure. The shipped
    test checks origin strings, not fixture equality.

Before upstream publication, add a machine-readable fixture/results schema, make
evidence and target identity dimension-specific, define partial evaluation and
agreement, and ship a minimal conformance test that a third adapter can run against its
own output.

## Verification performed

- Pin checks:
  - `853ed3f5a722c67b26e82c7b68c0a2b56de9abe9` resolves locally.
  - `75b519d0a3a7fd609a00b6d5bf684a6a9131fe25` resolves in
    `.groundtruth/spec-repo`.
  - `37233104653b3ff6ea211169b0201026b12758ed` resolves and is checked out at
    the doctor runner's temporary `prototype` clone.
- Builder equivalence: all 26 suite-derived responses/context objects equal the suite
  builders; the suite contains 46 total fixtures, so this is a selected subset rather
  than the whole suite.
- Current 10x402 adapter output is byte-for-byte identical to the committed
  `results-10x402.json` result array.
- Agreement statistics independently recomputed as 57 agreed / 75 comparable, 18
  disagreed, 27 not comparable, and 12 reason-only differences.
- `node --test test/corpus.test.mjs`: **216 passed, 0 failed**.
- `npm test`: the pure phase completed **454 passed, 0 failed**; the next phase could
  not bind its local worker (`listen EPERM 127.0.0.1`) in this sandbox, so the expected
  762-test full run was **not completed** and must not be reported green.
- Repository was clean before review. No code, fixture, result, or disagreement file was
  modified by this review.

## Ship decision

**HOLD.** Before offering this upstream:

1. Remove house/client/provider-only reasons from the normative `payment` expectation;
   reclassify `dual-payto-divergence` and whitespace, then define the no-challenge /
   redirect boundary before assigning free-tier and redirect verdicts.
2. Give every discovery verdict a structured provider target and provider evidence, or
   redefine the dimension as static discovery eligibility and reserve indexed/listed
   outcomes for live adapters.
3. Correct the client-code citations and require execute-level evidence when claiming
   client interoperability.
4. Make engine/adapter/dependency pins complete and execution-verified; make corpus
   regeneration deterministic and test byte equality with suite builders.
5. Correct both adapter mappings, regenerate both results and `DISAGREEMENTS.md`, then
   recompute all statistics.
6. Specify the third-adapter/result contract in machine-readable form, re-read the
   maintainer comment in a networked environment, and complete the full 762-test run.

The corpus is close in architecture, but publication now would encode 10x402 policy as
portable protocol truth. That is a contract failure, not a documentation polish issue.

---

## Revision response (2026-08-20)

Written by the revision, appended rather than woven in: the review above is left
exactly as it was received, including the parts it turned out to be right about in a
way that was expensive. Every HOLD item below is mapped to what was changed and where.
The corpus is now **format v2**, and v2 is almost entirely a *narrowing of what the
corpus claims*. `corpus/FORMAT.md § What v2 changed` carries the same list as a table.

**The review limitation is cleared.** `gh api repos/x402-foundation/x402/issues/3104/comments`
was re-read with network access. The maintainer contract quoted in the review request is
complete and accurate — pinned versions, unchanged fixture semantics, three independent
outcomes, evidence classifications preserved, provider observations not promoted to
protocol, disagreements reported without forcing a winner. Two things in the thread are
worth recording explicitly:

- The maintainer's wording for the third dimension is *"Discovery/indexability — will
  registry-specific metadata be accepted and indexed?"*. v2 deliberately **narrows** that
  to static declaration eligibility and reserves *indexed* for a live adapter. That is a
  considered departure from the literal wording, taken because a corpus of recorded
  responses cannot observe indexing, and asserting it was the defect the review found. It
  is stated as a departure in `FORMAT.md § discovery` rather than presented as the
  maintainer's definition.
- Every other element of the requested first integration is met and unchanged: a pinned
  10x402 commit and `@x402/core` version (now blob-pinned and integrity-pinned as well),
  suite fixtures mapped without changing their semantics, the canonical v2 402 carried as
  a must-pass calibration fixture and gated by a test, both implementations run, and
  disagreements reported with no winner.

### § 1 Fixture truth — addressed

| HOLD item | status |
| --- | --- |
| 1. A house opinion is a normative payment requirement (`dual-payto-divergence`, `v2-payto-array`) | **Fixed.** `dual-payto-divergence` now passes all three dimensions. `v2-payto-array`'s payment reason set is `payee-form` alone. The adapter rule changed underneath both: a finding whose operative provenance carries no `spec` and no `client-code` citation **fails nothing** and is recorded in `observed_tags`. v1 routed it to `payment`, "the strict side", which was the mechanism. The `DUAL_*` override is deleted. |
| 2. Provider-specific discovery verdicts with no provider observation | **Fixed by redefinition plus evidence.** `discovery` is now STATIC DECLARATION ELIGIBILITY; indexed/listed/live outcomes are reserved by name for a live adapter. Every non-`n/a` discovery verdict carries a structured `discovery_target` naming the provider, the observation date, and the documented requirement it turns on, plus `cdp-validator`/`cdp-docs`/`provider-observation` evidence scoped to the dimension. The builder throws rather than emit one that does not; a test gates it. |
| 2a. The live positive control omits the provider evidence the repository holds | **Fixed.** `audit/2026-08-19/cdp-validator-toolshed.json` is attached — `"valid": true` with every `severity:required` preflight named, and `simulation.outcome: "accepted"`. `index.active: true` is attached too and **explicitly marked as recorded for completeness and not the basis of the verdict**, because the narrow definition does not assert liveness. |
| 3. No challenge and an unseen redirect target counted as successful payment outcomes | **Fixed.** The recorded-challenge precondition (`FORMAT.md § The recorded-challenge precondition`, `judgeableFrom()` in `corpus/vocabulary.mjs`). `free-tier-200` and `redirect-instead-of-402` are `n/a` on `payment` and `client_interop`, kind `scope`, and are **excluded from the agreement statistics** rather than counted as agreements. Both keep their `discovery` verdicts under the new narrow definition. What each tool would have said is preserved under `scope_suppressed` and printed in `DISAGREEMENTS.md § Scope-excluded`. |
| 4. The whitespace fixture puts a client-specific raw-input opinion into `payment` | **Fixed, and the underlying contract is now stated.** `response.headers` are defined as **parsed field values**, not raw wire bytes (`FORMAT.md § response.headers are PARSED FIELD VALUES`). `v2-header-b64-whitespace` is reclassified as a raw-input/pasted-population **client_interop** case per § 1.4 — it carries `population: "raw-input"`, makes **no payment claim** (payment passes), and fails `client_interop` only. |
| 5. `client_interop` passes with no client evidence, or parse-level evidence for an execute-level promise | **Fixed by downgrading the claim, not by inflating the evidence.** Every `client_interop` expectation now carries `claim_level`. **Every pass in the corpus is `parse`-level**, because no fixture here evidences a successful execution — including the live positive control, whose accepted settlement simulation is a *facilitator* accepting a payment and is filed under `payment`. Every `execute` claim cites `@x402/evm`, and the builder refuses an `execute` claim with no execution citation. The four calibration fixtures that passed with no `client-code` entry now carry one. Cloudflare's says in as many words that no pinned client implements `batch-settlement`, so no execution claim is made. |
| 6. Two materially inaccurate client-code references | **Both corrected.** `v2-asset-ticker-not-address` now says the pinned core schema is `asset: NonEmptyString` — spelling out that the generic schema does **not** require an address and that ISO 4217 codes are spec-legal — and cites `@x402/evm`'s `getAddress(requirements.asset)` as the actual authority. Both base64 fixtures now locate `Base64EncodedRegex` in `dist/esm/chunk-UQQR4X3S.mjs:95` and its use in `chunk-BA2VL4DT.mjs:2199-2204`, matching `audit/2026-08-19/fable-spec-truth.jsonl:8`. |
| 7. "Four more" vs three | **Fixed.** The builder header now says three and names the five calibration fixtures separately. A test asserts the counts (5 calibration, 3 constructed). |

The positive finding on `amount-below-cdp-floor` is preserved and is now the shape the
rest of the corpus follows rather than the exception to it.

### § 2 Contract fidelity — addressed

| HOLD item | status |
| --- | --- |
| 1. The pin can silently mislabel the code that ran | **Fixed.** The engine is pinned by **content**: git blob hashes of `worker/lint.js`, `worker/envelope.js`, `worker/positive-control.js`, `test/fixtures/envelopes.mjs`, `corpus/vocabulary.mjs` and `corpus/run-10x402.mjs`. `assertPinnedBlobs()` recomputes and **refuses to run on a mismatch**, before the engine executes. The commit is kept and marked `commit_is: informational`. Proven with a negative control: appending a comment to `worker/lint.js` makes both the test and the adapter CLI fail by name. |
| 2. Regeneration is nondeterministic; the "unchanged" test does not test bytes | **Both fixed.** The generation date and the recorded HEAD are carried forward from the committed file unless `--stamp` is passed; everything else is a pure function of the tree. The test now **invokes `buildCorpus()`** and compares its output to the committed bytes, and separately deep-equals every suite-derived fixture's recorded response against the suite builder's own output. Proven with a negative control: appending a word to one fixture's `notes` fails the byte test. |
| 3. Not every verdict dependency is pinned | **Fixed.** `pins.packages` carries `@x402/core`, `@x402/evm`, `@x402/fetch`, `@x402/extensions`, `x402` and `x402-fetch`, each with its npm **registry integrity hash**. `x402-fetch` is pinned in its own right — it is a separate package from `x402`. `@x402/extensions` is cited by no fixture and is pinned because the doctor runner installs it. A test walks every evidence ref for a `pkg@version` and fails on one that is not in `pins.packages`. |
| 4. Offline rules not preserved at per-fixture granularity | **Fixed.** Every result now carries the **complete** held-back list, each entry marked `reported-by-tool` or `held-back`, plus a top-level `partial_evaluation` block. `FORMAT.md § Partial evaluation` states the contract, including how a third tool reports an unavailable dependency or an unsupported protocol version. |

### § 3 Adapter honesty — addressed

| HOLD item | status |
| --- | --- |
| 1. The source-to-dimension map is per-check-id, and flatters 10x402 on the whitespace case | **Fixed at the root.** Citations are marked **operative** or **contextual** in the engine's own check catalogue (`ctx()` in `worker/lint.js`), the adapter reduces from the **operative provenance of that finding**, and the provenance that decided each finding's dimensions is written into the results file beside it under `provenance`/`decides`. `V2_B64_URLSAFE`'s transport-spec citation is marked contextual — it says "Base64-encoded" and is silent on the alphabet, which the repository's own audit states — so **both** base64 fixtures now pass `payment` and fail `client_interop`. A module-load guard rejects a check whose every citation is contextual. |
| 2. The documented DUAL override violates the payment dimension | **Deleted.** There is no override in either adapter. A test asserts the `DUAL_*` family can fail neither normative dimension. |
| 3. 10x402 discovery is an engine self-report, not a provider observation | **Cured by the redefinition.** Under static declaration eligibility, evaluating a declaration against a provider's documented preflight is the right kind of claim, and it is no longer used to support anything about indexing. `FORMAT.md § discovery` says what the dimension does not claim, by name. |
| 4. A missing header mislabelled as undecodable base64 | **Fixed.** `paymentRequiredTag()` decides on the input rather than on the prototype's wording, whose single message ("PAYMENT-REQUIRED is missing or malformed") cannot tell the two apart. Absent or empty header → `envelope-absent`. `perfect-v1-only` and `no-envelope-html-body` no longer carry a base64 diagnosis. As a side effect the base64url fixture's tags now match 10x402's exactly, so a spurious reason-difference disappeared as well. |
| 5. A mixed provider/transport rule loses its provider scope | **Fixed and specified.** `FORMAT.md § Mixed-scope rules`: a finding whose own text names more than one scope maps to **every** dimension it speaks to, and the per-dimension rules then decide what it may fail in each. `x402.http.challenge_status` maps to all three, carrying `status-not-402` into `discovery`; the recorded-challenge precondition then makes the payment and client halves `n/a` on the two fixtures concerned. Applied symmetrically — both adapters run the same precondition from the same shared function. |

### § 4 `DISAGREEMENTS.md` — regenerated

Every statistic is recomputed and **none of the old numbers survives anywhere** in the
repository (`57`, `75` comparable, `76.0%`, `18`, `27` — grepped). The new figures:

| measure | v1 | v2 |
| --- | ---: | ---: |
| total dimension verdicts | 102 | 102 |
| scope-excluded (the corpus cannot judge) | — | 4 |
| not comparable (a tool did not evaluate) | 27 | 25 |
| comparable | 75 | 73 |
| **agreed** | **57 (76.0%)** | **58 (79.5%)** |
| disagreed | 18 | 15 |
| same verdict, different reason set | 12 | 12 |

The analyses the review found technically supported are unchanged. The three it
challenged are rewritten: the whitespace row now sits in `client_interop` and states the
parsed-header contract; the free-tier and redirect rows are re-keyed to `discovery`,
where the provider policy they were always about now lives, and their payment and
client-interop halves are reported under a new **§ Scope-excluded** section with what
each tool would have said. `dual-payto-divergence` is no longer a disagreement — both
tools pass it. A new **`placement`** class distinguishes "the adapters filed the same
fault in different dimensions" from "two implementations reached opposite conclusions",
because the review was right that conflating them overstates the disagreement.

**§ Where 10x402 was wrong** now carries six entries rather than two: the two engine
defects the second implementation found, and the four this review found in the corpus.

### § 5 Format quality — addressed

All eleven gaps are closed in `corpus/FORMAT.md`, and the ones that can be mechanised are
mechanised rather than described:

1. **Schemas** — `corpus/schema/fixtures.schema.json` and `corpus/schema/results.schema.json`.
2. **Dimension-scoped evidence** — every citation carries a required non-empty `dimensions` array; a non-`n/a` verdict with no citation scoped to it is a build error.
3. **`client_interop` quantifier** — defined as the cited client appropriate to the declared version/scheme/network, with `parse` and `execute` levels separated and evidenced differently.
4. **Structured provider identity** — `discovery_target`, and the four outcomes the dimension does not claim, listed by name.
5. **`n/a` rules** — two `na_kind` values with different statistical treatment, and the mechanical precondition that decides which applies.
6. **Partial evaluation** — declared per file and per fixture; unavailable dependencies and unsupported versions specified.
7. **Unmapped-rule policy and mapping completeness** — an unmapped rule is recorded verbatim and decides nothing; totality is a passing condition, not an aspiration. A tool with no severity ladder is told what to do.
8. **The agreement algorithm** — stated as four ordered steps, with `observed_tags` and `na_kind` explicitly excluded from comparison.
9. **`response.headers`** — defined as parsed field values, with the fixture that proves the choice changes the result labelled `population: "raw-input"`.
10. **Pinning** — content-addressed blobs, registry integrity hashes, transitive adapter dependencies, and an execution-time assertion.
11. **Rebuild/diff procedure** — deterministic by default, with the byte-equality gate in the test suite.

Plus a **third-adapter conformance test**, `corpus/validate-results.mjs`, which any tool
can run against its own results file. It imports nothing from this repository's engine,
and it cross-checks the corpus's own `judgeable` block against the published rule — so a
corpus that lies about its own scope is caught by the same script a stranger runs.

### Verification

- `npm test`: the full run, all six phases, **green** — the phases the review's sandbox
  could not bind are included. The count rose with the new gates.
- Negative controls executed for both new gates, because a gate that passes on its first
  run is unproven: mutating `corpus/fixtures.json` fails the byte-equality test by name,
  and mutating `worker/lint.js` fails both the blob assertion and the adapter CLI.
- The 10x402 adapter reproduces **102 of 102** hand-authored expectations.
- Six fixture expectations changed, and each is a HOLD item above:
  `v2-header-b64-urlsafe.payment` (fail → pass), `v2-header-b64-whitespace.payment`
  (fail → pass), `v2-payto-array.payment` (reason set loses `dual-divergence`),
  `dual-payto-divergence.payment` (fail → pass), `free-tier-200.payment` and
  `.client_interop` (pass → n/a), `redirect-instead-of-402.payment` and `.client_interop`
  (pass → n/a). Nothing else moved.
