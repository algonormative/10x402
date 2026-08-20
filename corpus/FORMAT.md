# The portable x402 conformance corpus — format v3

`corpus_version: 3`

A corpus of recorded HTTP responses with **tool-neutral expectations**, so that two
conformance implementations can be run over the same cases and their disagreements read
off rather than argued about. Built for
[x402-foundation/x402#3104](https://github.com/x402-foundation/x402/issues/3104).

Nothing in `fixtures.json` names a check id, a rule id, a severity, or a grade. A tool
joins the corpus by writing an **adapter** from its own vocabulary to this one. Two
adapters ship here: `corpus/run-10x402.mjs` and `corpus/run-x402-doctor.mjs`.

**Machine-readable:** `corpus/schema/fixtures.schema.json` and
`corpus/schema/results.schema.json` are the normative shapes.
`corpus/validate-results.mjs` is the conformance test a third adapter runs against its own
results file; it imports nothing from this repository's engine.

> **What changed in v2 and v3.** A pre-publication accuracy review (`CORPUS-REVIEW.md`)
> found that v1 let 10x402 house rules decide the normative `payment` dimension, asserted
> provider-specific `discovery` outcomes with no provider named or cited, and turned
> responses containing no challenge at all into passes. v2 was that repair, and it was
> mostly a *narrowing of what the corpus claims*.
>
> A re-review of v2 then found the narrowing implemented but not always told the truth
> under: discovery verdicts that contradicted the provider capture they cited, a
> client-interoperability pass resting on a schema that in fact rejects the fixture, and
> provenance still reduced per check id rather than per finding. **v3 is the repair for
> that, and its method is different: where v2 reasoned about what the pinned clients do,
> v3 RUNS them.** `corpus/probe-clients.mjs` installs the pinned packages from a committed
> lockfile and records what each entry point actually did with each fixture, and that
> record — not a reading of the source — is what the client citations now rest on. Every
> change is listed in § What v2 and v3 changed.

---

## Why three outcomes

A response can be payment-valid and unusable by a common client, or payment-valid and
undiscoverable, or both. Collapsing those into one grade makes remediation ambiguous — a
seller told "C" cannot tell whether their money or their listing is at risk. So every
fixture carries three independent verdicts:

| dimension | the question | what may fail it |
| --- | --- | --- |
| `payment` | Can the declared payment be interpreted and settled under the stated x402 version, **per the normative specification**? | an operative `spec` citation, and nothing else |
| `client_interop` | Will the **cited client implementations**, at the pinned versions, parse and execute it correctly? | an operative `client-code` citation, and nothing else |
| `discovery` | Is the registry-facing declaration present, schema-valid, and does it meet the **named provider's documented requirements as documented**? | a `cdp-validator`, `cdp-docs` or `provider-observation` citation naming the provider |

The third column is the load-bearing one, and it is new in v2. **A citation kind that
cannot fail a dimension cannot decide it.** A `house-opinion` may not fail anything at
all; it may only be recorded as an observation. That is this corpus's answer to *"provider
observations should not silently become protocol requirements"* — the rule is mechanical,
it is applied by both adapters, and `corpus/validate-results.mjs` checks it.

The v2 specification's own canonical 402 is carried as a **must-pass calibration fixture**
and demonstrates exactly this: it passes `payment` and `client_interop`, and it fails
`discovery`, because it publishes no `extensions.bazaar`. One document, two correct and
opposite answers. A tool that grades the specification's own example anything but clean on
the first two dimensions is miscalibrated, and an earlier version of 10x402 graded it a C.

### `payment`

Normative only. A finding may fail this dimension when — and only when — its **operative**
provenance includes a citation into the x402 specification at the pinned commit.

Operative is not the same as present. A check may cite a specification section that
locates the reader without establishing the rule; the clearest case in this corpus is
base64url, where the transport specification says the header carries "Base64-encoded" JSON
and is **silent on the alphabet**. The alphabet is decided by `@x402/core`. So base64url
is a `client_interop` failure and not a `payment` one, and v1 got that wrong by counting a
contextual citation as authority. The distinction is data, not commentary: citations are
marked in the engine's own check catalogue (`ctx()` in `worker/lint.js`), and the
provenance that decided each finding's dimensions is written into the results file beside
the finding, so the reduction is auditable rather than asserted.

**And it is per BRANCH, not per check id.** A check id is one subject; its branches can
rest on different documents, and v2 published the id's whole citation list on whichever
branch fired. Two consequences were real and both were wrong. `V2_PAYTO` failing on a
`solana:*` entry published viem's `getAddress` — an EVM citation on a Solana envelope —
and failed client interoperability with no Solana client cited anywhere. `V2_MAX_TIMEOUT`
firing on a network whose scheme makes the field *optional* published the three documents
that make it *required*, and said it decided `payment` and `client_interop` while failing
neither. In v3 the emitting branch passes its own citations, the finding carries them, and
the results file records both what a finding **could** decide and what it **did** —
which for a warning or a note is nothing at all.

### `client_interop`

**The quantifier.** The dimension is about *the cited client appropriate to the declared
version, scheme and network* — not "every client that exists" and not "some client
somewhere". Each fixture's evidence names the client or clients it is claiming about, and
the claim is about those, at the pinned versions, and about nothing else. Where a
declaration offers several entries, the dimension fails if a cited client cannot handle an
offer the declaration presents to it: a seller whose only Arbitrum entry no v1 client can
parse has a client-interoperability fault even though the v2 entry is perfect.

**The strength of the claim.** Parsing is not executing, and the two need different
evidence, so every `client_interop` expectation carries a `claim_level`:

| level | means | evidence it requires |
| --- | --- | --- |
| `parse` | the cited client's decoder accepts or rejects the declaration | a schema or decode-path citation |
| `execute` | the cited client also **selects** the offer, **signs** it and issues the payment | a citation into a signer or a payment path |

v1 promised "parse **and execute**" everywhere and evidenced parsing. v2 says which it
holds. In this corpus every `execute`-level claim cites `@x402/evm` — the EVM signer is
the only pinned package where selection and signing happen — and **every `client_interop`
pass is `parse`-level**, because no fixture here evidences a successful execution. That is
a downgrade of the corpus's own claims, deliberately: the alternative is a stronger
statement than the evidence supports. The builder refuses to emit an `execute` claim with
no execution citation.

### The claims are OBSERVED, not read

`corpus/probe-clients.mjs` installs the pinned client packages from the committed
`corpus/client-probe.lock.json` and runs every reachable decode and validate entry point
over every fixture, recording the outcome and the verbatim error in
`corpus/client-probe.json`. It exists because v2 asserted that a schema accepts an envelope
which that schema rejects, and nobody had run it.

What running it found is worth stating, because it changes what a client citation can
mean. **`@x402/core@2.23.0` contains two consumers that disagree**, and the corpus cited
the wrong one seven times:

- `decodePaymentRequiredHeader` — what a client actually calls — tests
  `Base64EncodedRegex` against the raw header, then does `JSON.parse(safeBase64Decode(…))`.
  **No zod runs on that path at all.**
- `PaymentRequiredV2Schema` — exported for consumers that validate — rejects seven corpus
  envelopes the decoder accepts.

So "the client rejects this at decode" and "the client's schema rejects this" are
different claims about different code, and a fixture must say which. The sharpest case is
the batch-settlement calibration: the decoder accepts it, the schema rejects it with
`accepts.0.maxTimeoutSeconds: Required`, and v2 cited the schema as the basis for a
**pass**. The verdict survived the correction; the sentence under it did not.

Where a path cannot be exercised offline it is recorded as `not-exercisable-offline` and
never guessed at. That covers every signer path, so the corpus's `execute`-level claims
rest on reading `@x402/evm` at the pinned version — and the two fixtures that depend on it
entirely say so on their own evidence.

### `discovery`

**STATIC DECLARATION ELIGIBILITY, and nothing more.** Is the registry-facing declaration
present, does it validate against the schema published beside it, and does it meet the
named provider's **documented** requirements *as documented*?

What this dimension explicitly does **not** claim, ever:

- that a record **was** indexed,
- that a listing **is** live,
- that a lookup **would** return it,
- anything about a provider's runtime behaviour beyond its published requirements.

Those are live-adapter outcomes. A corpus of recorded responses has no registry and
cannot reach them, and v1 asserted them anyway. They are reserved, by name, for an adapter
that probes a live provider — and a live adapter that adds them should add them as a
fourth dimension or a distinct claim, not by widening this one.

The narrow reading is what makes the dimension answerable from a recording at all, and it
is why the 10x402 adapter may keep using the engine's own `bazaar_ready` verdict: that
verdict evaluates a declaration against CDP's documented preflight, which is exactly the
question as now posed. It is not, and does not claim to be, evidence that anything was
indexed.

**Every non-`n/a` discovery verdict names its provider**, in a structured field:

```jsonc
"discovery_target": {
  "provider": "CDP Bazaar",
  "provider_evidence": "audit/2026-08-19/cdp-validator-toolshed.json",
  "observed": "2026-08-19",
  "claim": "static-declaration-eligibility",
  "basis": "has_bazaar_extension is a REQUIRED preflight and this envelope publishes no extensions.bazaar"
}
```

and carries provider evidence — `cdp-validator`, `cdp-docs` or `provider-observation` —
scoped to the `discovery` dimension. The builder throws rather than emit one that does
not. The Bazaar *specification* is not a provider: the pinned document says storage and
indexing are an implementation detail, so a spec citation can establish schema validity
and cannot establish eligibility at anybody's index.

**A verdict may never contradict the evidence it cites**, and in v2 five of them did.
Every discovery expectation is now checked against the cited capture's own REQUIRED
preflight set, field by field. The capture marks `accepts[0].amount`,
`accepts[0].maxTimeoutSeconds`, `accepts[0].asset`, `accepts[0].payTo` and
`accepts[0].network` required alongside the bazaar-extension family — so a declaration
that omits `maxTimeoutSeconds`, or names a ticker where the provider resolves a token, is
not eligible however complete its bazaar block is. v2 read "the extension is fine" as "the
declaration is eligible" and passed all five. The engine had the matching gap and it was
the same defect twice fixed already in another disguise: `bazaar_ready` computed from an
absence of blockers, in a regime with no rule able to raise one. Four checks were added to
close it, and one existing check was widened.

The recheck also corrected the engine in the seller's favour once. `CDP_FACILITATOR_CHAINS`
listed only the EVM half of a set whose own captured expectation reads "a
facilitator-supported network (Base, **Solana**, Polygon, Arbitrum, World)", so a
conformant Solana seller was told their chain was outside CDP's settlement set by a
document that says the opposite.

The live positive control is the case where this matters most. The repository holds CDP's
own answer for that endpoint — every required preflight passed, `simulation.outcome:
"accepted"`, and `index.active: true` — and v1 cited none of it. All of it is now attached
to the fixture, with the index flag explicitly marked as recorded for completeness and
**not** the basis of the verdict.

---

## Verdicts

Each dimension takes one of three values in an expectation:

- **`pass`** — the dimension's question is answered yes.
- **`fail`** — answered no. A `fail` MUST carry at least one `reason_tag`.
- **`n/a`** — the question cannot be answered from this fixture. Not a pass, not a
  failure, and not a hedge.

`n/a` has **two kinds**, and they are different claims. Every `n/a` says which:

| `na_kind` | means | in the statistics |
| --- | --- | --- |
| `question-does-not-arise` | the recording is complete and the question does not apply to it | comparable — it is a real answer |
| `scope` | the recording cannot support **any** answer | **excluded** |

`question-does-not-arise` is the v1 meaning, unchanged: a v1-only response cannot be
judged against registry requirements that are a v2 shape; a response whose v2 envelope did
not decode has no registry metadata to inspect. In both, the corpus holds the whole
response and the question is what does not apply.

`scope` is new, and it is the boundary v1 did not have. See below.

A results file may additionally record **`not-evaluated`** — *this tool did not run the
rules that would answer this*. An expectation may never use it. It is the only honest
answer for a check that needs something the corpus cannot supply (a live registry, a
settlement), and it is excluded from agreement statistics rather than counted as a pass.

**Three exclusions, three different things.** `not-evaluated` is about a *tool*.
`scope` is about the *corpus*. `question-does-not-arise` is about the *fixture*, and is
not an exclusion at all. Conflating them is how a corpus reports a high agreement rate
that means nothing.

`pass` and `n/a` carry an empty `reason_tags`. Reasons are why a dimension **failed**;
tools differ wildly in what they emit as advisory information and agree far more about what
is fatal, so admitting non-fatal tags into expectations would manufacture disagreements
that are about verbosity. Observational tags are still recorded — in the results files, as
`observed_tags`.

---

## The recorded-challenge precondition

**A recorded corpus cannot demonstrate payability it never recorded.**

`payment` and `client_interop` both ask about a *declared payment*. Where the recording
contains no challenge at all, there is no declaration to interpret, and neither `pass` nor
`fail` is honest — `pass` would claim a payability nothing in the file demonstrates, and
`fail` would manufacture a defect out of an absence.

The rule is mechanical, so that a third adapter reaches the same set:

```
a challenge is recorded  ⟺  status is 402
                          ∨  a non-empty PAYMENT-REQUIRED header is present
                          ∨  the body parses as an x402 envelope
```

When no challenge is recorded, `payment` and `client_interop` are **`n/a`, kind `scope`**,
and are **excluded from the agreement statistics**. `discovery` is always judgeable: under
the static-declaration reading it asks whether a declaration is present and eligible, and
"absent" is an answer.

Note what the rule does *not* do. A **402 with nothing in it** is still judgeable, and
still a failure: a challenge that declares nothing is a broken challenge, not an absent
one. `no-envelope-html-body` fails; `free-tier-200` and `redirect-instead-of-402` are
scope-excluded. The line is whether a challenge was recorded, not whether it was any good.

The rule is published as code — `judgeableFrom()` in `corpus/vocabulary.mjs` — and its
output is written onto every fixture as a `judgeable` block, so a reader can check the
corpus against its own rule rather than take the block on trust.
`corpus/validate-results.mjs` does exactly that.

**Suppressing the verdict is not discarding the opinion.** Both adapters compute what they
would have said and keep it: the tags move to `observed_tags` and are listed under
`scope_suppressed`, and `DISAGREEMENTS.md § Scope-excluded` prints both tools' suppressed
answers side by side. The prototype's reading of a free tier — "Bazaar requires HTTP 402" —
is the sharpest thing in the whole comparison and it is not thrown away; it is just not
allowed to become a verdict the recording cannot support.

**The right fix for the redirect fixture is more recording, not more inference.** It holds
a 307 and a `Location` and no response from the target. Adding the target response as a
second recorded exchange would make the fixture judgeable. Concluding "the envelope is
reachable" from the default redirect mode of a client library is not the same thing, and
v1 did that.

---

## Fixture shape

```jsonc
{
  "id": "v2-header-b64-urlsafe",            // stable, kebab-case, unique
  "title": "v2 header in url-safe base64",
  "response": {                              // the recorded response — see below
    "status": 402,
    "headers": { "payment-required": "eyJ4NDAy…" },
    "body": "{\"x402Version\":1,…}"
  },
  "context": { "method": "POST", "url": "https://example.com/api/thing" },
  "judgeable": { "payment": true, "client_interop": true, "discovery": true },
  "expected": {
    "payment":        { "verdict": "pass", "reason_tags": [] },
    "client_interop": { "verdict": "fail", "reason_tags": ["b64-urlsafe"], "claim_level": "parse" },
    "discovery":      { "verdict": "n/a",  "reason_tags": [], "na_kind": "question-does-not-arise" }
  },
  "evidence": [
    { "kind": "client-code", "ref": "@x402/core@2.23.0 … Base64EncodedRegex runs before atob()",
      "dimensions": ["client_interop"] },
    { "kind": "spec", "ref": "specs/transports-v2/http.md § … — SILENT on the alphabet",
      "dimensions": ["payment"] }
  ],
  "origin": { "kind": "10x402-suite", "ref": "test/fixtures/envelopes.mjs — …" },
  "discovery_target": { … },                 // required when discovery is not n/a
  "calibration": "must-pass",                // optional
  "population": "raw-input",                 // optional — see below
  "notes": "…"                               // optional
}
```

`context.url` is the URL the response was served from and `context.method` the verb it was
fetched with. Both matter: a declared crawler method that disagrees with the probed verb is
a real discovery failure, and it is not visible without the verb.

### `response.headers` are PARSED FIELD VALUES

Not raw wire bytes. A header value in a fixture is what a header parser would hand a
consumer: the field value, after the transport has done what a transport does.

This choice is normative and it changes results, so it is stated rather than left to be
inferred. `v2-header-b64-whitespace` is the fixture that proves it. HTTP defines optional
whitespace around a field value as not part of the value, so a padded value is one that
reached the consumer **by a path with no HTTP parser in it**: a facilitator replaying a
stored declaration, an SDK reading a cache, a pasted capture, a database row. That fixture
carries `population: "raw-input"` and is scoped to exactly that population.

The consequence is that it makes **no payment claim**: `payment` passes, because the
declared terms are conformant and settleable, and `client_interop` fails, because the
pinned client's `Base64EncodedRegex` runs against the value it is given. v1 failed the
payment dimension on it, which put a client-specific raw-input opinion inside a normative
dimension.

A `population` marker declares the delivery path a fixture is about. Absent, the fixture is
about an ordinary HTTP-delivered response. `raw-input` says the value is one that only
reaches a consumer without a transport in between, and a reader who does not care about
that population can discard the fixture on that basis alone.

**The response is the fixture.** Not a URL — a recorded response. That is a deliberate
scope choice with a known cost and a known benefit, and the raw-input fixture demonstrates
both: a live doctor and a recorded corpus see different populations of bug, and neither is
a superset.

---

## Evidence, and what is normative

Every fixture cites where its expectation comes from, and **every citation names the
dimension or dimensions it supports**. A fixture-wide array does not let a reader ask "what
supports the `client_interop` verdict here" and get an answer; a `dimensions` field does.
It is required, non-empty, and the builder throws without it. A dimension with a
non-`n/a` verdict and no citation scoped to it is a build error.

| kind | normative? | may fail | means |
| --- | --- | --- | --- |
| `spec` | **yes** | `payment` | a section of the x402 specification at the pinned commit |
| `client-code` | for that client, at that version, and nothing else | `client_interop` | observed behaviour of a pinned client implementation |
| `cdp-validator` | no | `discovery` | observed behaviour of the CDP Bazaar validator |
| `cdp-docs` | no | `discovery` | CDP's published seller documentation |
| `provider-observation` | no | `discovery` | observed behaviour of a named provider, or a live capture |
| `field-report` | no | — | a reproduced report from the x402 issue tracker |
| `house-opinion` | **no** | **nothing** | this corpus's own reasoning, cited as such |

`house-opinion` exists so that a rule with no external authority cannot masquerade as one,
and in v2 it decides nothing at all. The clearest case is the dual-stack consistency
family: neither specification says a seller's v1 body and v2 header must agree on payee or
price. v1 labelled that honestly *and still made it `expected.payment: fail`*, which is
labelling without consequence. In v2 `dual-payto-divergence` passes all three dimensions,
the house objection is recorded as an observation in the results file, and a reader is
entitled to weigh it at whatever it is worth to them.

---

## Reason tags

A closed vocabulary, defined in `corpus/vocabulary.mjs` and copied into `fixtures.json`
under `reason_tags` so the file stands alone. Tools map their own finding ids to tags; the
corpus never sees a tool's ids.

The vocabulary is versioned with the corpus. Adding a tag, or changing what one means, is a
`corpus_version` bump, because an expectation written against the old meaning is no longer
the same claim.

Tags are marked `fatal: true` in `vocabulary.mjs` when some rule mapping to them can reach
error severity — only those can appear in an expectation or in a results `reason_tags`. The
rest (`redirect`, `free-tier-200`, `content-type`, `bazaar-output-example`,
`legacy-v1-header-names`, …) are observational and appear only in `observed_tags`.

`network-unsupported-by-provider` became fatal in v3, and the change is confined to one
dimension. A provider's required network preflight cannot pass on a network it does not
settle, so the declaration is not *eligible* there — but the envelope remains perfectly
legal x402, and no rule mapping to this tag can fail `payment` or `client_interop`. That
is the same shape as `amount-below-provider-floor`, which has always been fatal in
`discovery` and meaningless anywhere else. A tag's fatality is a statement about what it
can withhold, not about how bad it is.

---

## Adapters

An adapter reduces one tool's report to nine values: a verdict and a tag set per dimension.
Five rules make the reductions comparable across tools. All five are applied by both
adapters that ship here, and a third adapter is expected to apply them too.

**1. One severity contract, applied to both tools.** A dimension **fails** when a finding
that speaks to it is an **error**. A warning or an informational finding is recorded and
fails nothing. This is the single most important thing for making a disagreement
meaningful: without it, the tables would mostly record that two projects draw their
severity lines in different places, which is not a fact about x402.

**A tool with no severity ladder** — one that emits findings without ranking them — should
declare that in its results file under `partial_evaluation` and treat every finding as an
error. It will disagree more, and the disagreements will be legible as what they are.

**2. Per-finding provenance decides which dimensions a finding may fail.** Not per check
id, and not "any source ever attached to the check". In the 10x402 adapter this is
mechanical, because every check in its catalogue carries a `sources` array in which each
citation is marked operative or contextual:

- operative `spec` citation → may fail `payment`
- operative `client-code` citation → may fail `client_interop`
- both → may fail both
- registry regime → may fail `discovery`

The provenance that decided a finding's dimensions is written into the results file beside
that finding, under `provenance`, together with the dimensions it decided (`decides`). A
reader can therefore check the reduction instead of trusting it.

**3. No authority, no verdict.** A finding whose operative provenance is only
`house-opinion`, `field-report`, `cdp-validator`, `cdp-docs` or `provider-observation`
**fails nothing**. It is recorded in `observed_tags` on the dimensions it speaks to.

v1 routed such a finding to `payment`, "the strict side". That single line was the
mechanism by which a house rule became a normative payment verdict, and it took a
documented override with it — the `DUAL_*` family was forcibly mapped to `payment`
regardless of what it cited. Both are gone. There is no override in either adapter now.

**4. Registry regime.** `discovery` in the 10x402 adapter is the engine's own published
`bazaar_ready` verdict rather than a recount, including its `n/a`. Under the narrow
static-declaration reading (§ `discovery`) that is the right kind of claim: it evaluates a
declaration against a provider's documented preflight. `test/corpus.test.mjs` requires the
hand-authored expectations to equal that adapter, which is a **regression gate, not an
oracle** — the independent check on the corpus is the second implementation.

**5. The recorded-challenge precondition** (§ above), applied after everything else so
that what the tool would have said is preserved rather than never computed.

### Mixed-scope rules

A finding whose own text names more than one scope maps to **every dimension it speaks
to**, and the per-dimension rules above then decide what it may fail in each.

The prototype's `x402.http.challenge_status` is the case that forced the rule. It emits
*"The unpaid request returned HTTP 200; Bazaar requires HTTP 402"* — a transport
observation and a named-provider policy in one sentence. v1 mapped it to `payment` and
`client_interop` only, which discarded the provider scope the prototype itself stated and
manufactured four payment-dimension disagreements out of a policy citation. It now maps to
all three, and the corpus's own precondition then makes the payment and client halves
`n/a` on the two fixtures where no challenge was recorded. The provider half survives, in
the dimension it was always about, and it is a real disagreement there.

A mapping table entry that splits a rule this way must say so and say why; the one in
`corpus/run-x402-doctor.mjs` does.

### Unmapped rules

A rule a tool emits that the adapter has no tag or no dimension for is recorded verbatim in
`tool_detail.unmapped` and **decides nothing**. It is never silently dropped and never
guessed at.

**Mapping completeness is a requirement, not an aspiration.** An adapter must be total over
the rules its tool can emit for the corpus it runs: `tool_detail.unmapped` empty across the
whole corpus is the passing condition, and a non-empty one is a defect in the adapter to be
fixed before the results are published. `test/corpus.test.mjs` gates the 10x402 side of
this at the catalogue level, and `corpus/run-x402-doctor.mjs` prints any unmapped rule it
encounters.

### Partial evaluation

A results file declares what it did not run, under `partial_evaluation`:

```jsonc
"partial_evaluation": {
  "rules_held_back": ["x402.bazaar.lookup", …],   // rules that could not run at all
  "per_fixture": "…",                              // where the per-fixture record lives
  "unsupported_versions": "…",                     // protocol versions the tool does not implement
  "note": "…"
}
```

**That list is a declaration and never an excuse.** It says which rules the run could not
execute; it cannot say why any particular question went unanswered, because it does not
know which question it is being offered in place of. The v2 validator treated it as one —
a file that declared anything held back was allowed to leave every `not-evaluated` row
unexplained — and an external re-review showed what that bought: it replaced the list with
the invented string `fictional.rule`, turned every judgeable answer into a reasonless
`not-evaluated`, and the file still validated. Answering nothing and explaining nothing
was conforming.

#### What a third adapter must provide, exactly

Every `not-evaluated` dimension is accounted for **individually**, by one of two routes:

- **the row says why** — a non-empty `not_evaluated_reason` on that dimension; or
- **the fixture says which rule** — that result's own `partial_evaluation.rules_held_back`
  contains a record whose `dimensions` include this dimension.

A per-fixture record is `{ "rule", "status", "dimensions", "note"? }`:

```jsonc
"partial_evaluation": {
  "rules_held_back": [
    { "rule": "x402.bazaar.lookup",  "status": "reported-by-tool", "dimensions": ["discovery"] },
    { "rule": "x402.payment.settled", "status": "held-back",       "dimensions": [],
      "note": "a settlement probe; the corpus decides `payment` from the declaration" }
  ]
}
```

`status` is `reported-by-tool` (the tool raised the rule on this fixture but the run could
not stand behind the outcome) or `held-back` (it was never attempted). Neither decided
anything; the distinction is recorded because *the lookup failed* and *the lookup never
ran* are different facts about the same unanswered question. `dimensions` is required even
when empty — an empty array claims that the rule not running took nothing away from any of
the three questions the corpus asks, which is the honest answer for a check lying outside
them, and a tool that means it should have to write it down.

The list on each fixture is the **complete** set for that fixture, not only the entries
that happen to be load-bearing on it. v1 recorded a skipped rule on a fixture only if the
tool happened to mention it there, so nine of ten held-back rules existed only in a
top-level list and no reader could tell, per fixture, what had actually run.

Three consistency rules bind the two lists together, and `corpus/validate-results.mjs`
enforces all three:

1. **Per dimension, upward.** An unexplained `not-evaluated` must be covered by a record on
   its own fixture naming its own dimension. The file-wide list covers nothing.
2. **Per rule, downward.** Every rule in the file-wide `rules_held_back` must appear in at
   least one per-fixture record. A rule held back on nothing held nothing back — which is
   what a fabricated entry looks like, and how `fictional.rule` is caught.
3. **Per fixture, sideways.** A fixture may not hold back a rule the run never declared.
   The two lists are one declaration seen from two ends.

None of this obliges a tool to carry a per-fixture block. A tool that ran everything it has
declares an empty `rules_held_back` and writes no records, and every `not-evaluated` it
emits — if any — carries its own reason. The two shipped adapters are the two ends of that
range: 10x402 holds nothing back and has no `not-evaluated` verdict anywhere, and the
x402-doctor adapter carries the complete ten-rule list on all thirty-four of its answers.

#### Verdicts under partial evaluation

A dimension whose rules all ran carries a verdict. **A dimension whose deciding rule was
held back is `not-evaluated`, never a pass** — the validator rejects a `pass` on a
dimension the same fixture declares held back — and it carries a `not_evaluated_reason`
saying what was missing, or is covered by the record above. A failing dimension may still
contain held-back subrules: a tool that found one fatal fault and could not check for a
second should say both.

A tool that cannot evaluate a fixture at all — an unsupported protocol version, a
dependency it could not resolve — reports `not-evaluated` on all three dimensions with the
reason, and the fixture is excluded from the comparison rather than scored against it.

### The agreement algorithm

Stated exactly, because "they agreed 79% of the time" is not a number until it is.

For each of the `fixtures × 3` dimension-verdicts, in this order:

1. If the **corpus** declares the dimension not judgeable (`judgeable[dim] === false`), the
   row is **scope-excluded**. Not comparable, not an agreement.
2. Otherwise, if **either** tool reports `not-evaluated`, the row is **not comparable**.
   Not an agreement.
3. Otherwise the row is **comparable**. It **agrees** when the two verdicts are equal as
   strings — `pass`, `fail` and `n/a` compare directly, and an `n/a` from one tool against
   a `pass` from the other is a disagreement, not a near-miss.
4. Among agreements, the **reason sets** are compared as SETS, order-insensitive, using
   `reason_tags` only. `observed_tags` are never compared: they are what each tool chose to
   mention, which is a fact about verbosity. A difference here is counted separately, as
   "agreed on the verdict, differed on the reason", and it is not a disagreement — but it
   is the number a seller cares about, because the reason is what they act on.

`na_kind` is **not** compared. It is the corpus's classification of why an answer is
unavailable, not a tool's verdict.

The implementation is `corpus/report-disagreements.mjs`, and
`corpus/validate-results.mjs` reimplements the same algorithm as a check any tool can run
without this repository's engine.

---

## Joining the corpus: the third-adapter contract

1. Write an adapter from your tool's finding ids to the reason-tag vocabulary in
   `fixtures.json`. Nothing in the corpus names your ids and nothing in your adapter needs
   to name ours.
2. Apply the five adapter rules above, and the agreement algorithm if you report one.
3. Emit a results file in the shape `corpus/schema/results.schema.json` defines. Your
   `tool_detail` is free-form — it is your tool's business — but everything outside it is
   the contract.
4. Run the conformance test:

   ```sh
   node corpus/validate-results.mjs path/to/your-results.json
   ```

   It checks the file against the schema, that every fixture is answered exactly once, that
   reason tags are vocabulary tags and fatal ones, that `fail` says why and `pass` does not,
   that `not-evaluated` carries a reason or is declared held back, and that the scope rules
   were applied — including cross-checking the corpus's own `judgeable` block against the
   published rule, so a corpus that lies about its own scope is caught too. Pass two
   results files to print the agreement statistics between them.

5. If the corpus is wrong about a fixture, say so with a citation. Two of v1's expectations
   were changed that way by an external review, and four more by the review that produced
   v2.

---

## Pins

`fixtures.json` carries a `pins` block. Everything a verdict depends on is in it.

**The engine is pinned by CONTENT, not by commit.** A commit is the wrong handle for "what
code ran": the repository HEAD moves, and v1's published 10x402 commit predated both the
adapter and the corpus, so checking it out did not reproduce the reported command. v2 pins
the git **blob hash** of every file whose bytes can change an answer — `worker/lint.js`,
`worker/envelope.js`, `worker/positive-control.js`, `test/fixtures/envelopes.mjs`,
`corpus/vocabulary.mjs`, `corpus/run-10x402.mjs` — and `assertPinnedBlobs()` in
`corpus/run-10x402.mjs` recomputes them and **refuses to run on a mismatch**. The commit is
still recorded, marked `commit_is: informational`. A published result can therefore not
claim to be the output of code that is not the code that produced it.

The blob set has to be COMPLETE or the claim it makes is false, and in v2 it was not:
`worker/json-schema.js` is imported by `worker/lint.js` and the bazaar schema-validation
checks run through it, so an edit there moved discovery verdicts while the pin block
reported no change. It is pinned now, along with the observed-client record and its
lockfile, because fixture evidence cites that record by name.

**Every package named by evidence or by execution is pinned, with its registry integrity
hash**, under `pins.packages`: `@x402/core`, `@x402/evm`, `@x402/fetch`,
`@x402/extensions`, `x402` and `x402-fetch`. The client probe and the x402-doctor runner
both install from **committed lockfiles** rather than resolving ranges at run time — a
direct pin with a ranged transitive dependency underneath it lets two runs execute
different bytes while reporting the same version. v1 cited `@x402/evm` and `@x402/fetch` with no
pin at all, and treated `x402-fetch` as covered by the `x402` pin, which it is not — they
are separate packages. `@x402/extensions` is cited by no fixture and is pinned anyway,
because `corpus/run-x402-doctor.mjs` installs it and it can change that tool's answers.

A `client-code` citation is meaningless without a version and weak without an integrity
hash. The spec pin is a commit for the same reason.

The prototype's repository publishes **no licence**, so no code from it is vendored here;
`corpus/run-x402-doctor.mjs` clones it to a temporary directory outside the repository and
imports from the clone. See the header of that file.

---

## Determinism

Running `node corpus/build-fixtures.mjs` twice must produce the same bytes, or "the
fixtures were exported unchanged" is unfalsifiable. Two fields would otherwise move on
their own — the generation date and the repository HEAD — so both are **carried forward
from the existing `fixtures.json`** unless `--stamp` is passed. Everything else, including
the content-addressed blob pins, is a pure function of the tree. The results files take
their `ran` date from the corpus's own stamp for the same reason.

```sh
node corpus/build-fixtures.mjs           # deterministic: date and commit carried forward
node corpus/build-fixtures.mjs --stamp   # refresh the date and the recorded HEAD
```

---

## Where the fixtures come from

| origin | how many | what it means |
| --- | --- | --- |
| `10x402-suite` | most | imported from `test/fixtures/envelopes.mjs` and invoked, **not retyped** — the exported corpus is the same object the 10x402 suite asserts on, and cannot drift from it |
| `calibration` | 5 | the v2 transport spec's canonical 402, `bazaar.md`'s worked example, the SVM `exact` scheme's own PaymentRequirements, the Cloudflare batch-settlement profile, and a frozen production capture |
| `constructed` | 3 | cases the thread named that the suite had no fixture for, built here to the same one-thing-changed discipline |

Every suite fixture is a conformant dual-stack 402 with **exactly one thing changed**, so a
verdict on it is a statement about one fault. Regenerate with `node corpus/build-fixtures.mjs`.

---

## Self-consistency

`test/corpus.test.mjs` runs in the pure phase of `npm test` and asserts:

- `fixtures.json` parses, and every fixture has all three expectations
- every `reason_tag` is in the vocabulary, and is one the vocabulary marks fatal
- a `fail` names at least one reason; a `pass` or `n/a` names none
- every citation names the dimensions it supports, and every non-`n/a` verdict has one
- every non-`n/a` `discovery` verdict names a provider and cites provider evidence
- every `execute`-level `client_interop` claim cites an execution path
- the `judgeable` block on every fixture equals what the published rule computes from the
  response
- **the builders reproduce the committed file byte for byte** — `buildCorpus()` is invoked
  and its output compared to `fixtures.json`, and every suite-derived fixture's recorded
  response is deep-equal to the suite builder's own output. v1's test of this name compared
  origin *strings*, which is not the claim.
- the engine blobs on disk equal the blobs the corpus pins
- **`corpus/run-10x402.mjs` reproduces every expectation, exactly** — verdict and tag set

The last one is a regression gate, not an oracle. Expectations here are hand-authored and
the adapter must reproduce them; when it did not, the mismatch was resolved by deciding
which side was wrong and saying so in writing. On the first run 98 of 102 matched, and the
four that did not resolved as two fixture errors and **two engine defects in 10x402**, both
fixed and both written up in `DISAGREEMENTS.md § Where 10x402 was wrong`. The independent
check on the corpus is the second implementation, not this test — and the check on both is
a reader with the specification open, which is how v2 exists.

---

## What v2 and v3 changed

Every item was a finding in `CORPUS-REVIEW.md`. The v2 rows are narrowings of what the
corpus claims; the v3 rows are corrections to claims that were narrow enough and still
untrue.

### v3

| v2 | v3 |
| --- | --- |
| five discovery verdicts passed against a capture whose required set they did not meet | every discovery expectation is checked field by field against the cited capture; four engine checks added and one widened so the adapter reproduces it |
| `CDP_FACILITATOR_CHAINS` held only the EVM half of a set whose captured expectation names Solana | Solana is in the set, and a conformant Solana seller is no longer told otherwise |
| a `client_interop` pass cited a schema that rejects the fixture | the pinned clients are RUN (`corpus/probe-clients.mjs`); seven citations that said "rejected at decode" now name the entry point that actually rejected, and the decoder/schema divergence is recorded rather than smoothed |
| `dual-payto-divergence` claimed both client generations parse it, citing only v1 | both halves observed, both cited |
| provenance was reduced per check id | the emitting branch supplies its own citations; the finding carries them; results record what a finding could decide and what it did |
| an info finding published `decides: [payment, client_interop]` | a warning or a note decides nothing, and the record says so |
| `worker/json-schema.js` was not blob-pinned | pinned, with the probe record and its lockfile |
| the doctor runner did a fresh unlocked install | installs from a committed lockfile and verifies the resolved graph |
| the commit pin claimed to be "one commit behind" | no fixed lag is claimed; it is informational and always behind |
| the validator accepted a fictitious `rules_held_back` with unexplained `not-evaluated` rows | per-dimension accountability is enforced |

### v2

Every item is a narrowing of what the corpus claims.

| v1 | v2 |
| --- | --- |
| a `house-opinion` finding failed `payment`, "the strict side" | it fails nothing and is recorded as an observation |
| the `DUAL_*` family was forcibly mapped to `payment` by a documented override | the override is deleted; the rule decides |
| a check's *any* `spec` citation was authority for `payment` | citations are marked operative or contextual, and the deciding provenance is published per finding |
| `discovery` asked whether metadata "will be accepted and indexed" | `discovery` is static declaration eligibility; indexed/listed/live are reserved for a live adapter |
| 18 discovery verdicts named no provider | every non-`n/a` discovery verdict carries a `discovery_target` and provider evidence, enforced by the builder |
| `client_interop` promised parse **and** execute everywhere | `claim_level` says which; every pass is `parse`, every `execute` cites a signer |
| evidence was one fixture-wide array | every citation names the dimensions it supports |
| a response with no challenge could `pass` payment | the recorded-challenge precondition; `n/a` kind `scope`, excluded from the statistics |
| `response.headers` was undefined as raw or parsed | defined as parsed field values; the whitespace fixture is `population: "raw-input"` and makes no payment claim |
| the pin was the moving repository HEAD | content-addressed blob pins, asserted before the adapter runs |
| `@x402/evm`, `@x402/fetch`, `x402-fetch`, `@x402/extensions` unpinned | all pinned with registry integrity hashes |
| regeneration changed the date and the commit | deterministic by default; `--stamp` to refresh |
| "exported unchanged" compared origin strings | the builder is invoked and the bytes compared |
| a mixed provider/transport rule lost its provider scope | mixed-scope rules map to every dimension they speak to |
| a missing header was reported as undecodable base64 | absent input maps to `envelope-absent` |
| held-back rules were recorded per fixture only if the tool mentioned them | the complete held-back list is on every fixture, with a status |
| no schema, no conformance test, no stated agreement algorithm | `corpus/schema/*.json`, `corpus/validate-results.mjs`, and § The agreement algorithm |
