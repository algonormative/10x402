# The portable x402 conformance corpus — format v1

`corpus_version: 1`

A corpus of recorded HTTP responses with **tool-neutral expectations**, so that two
conformance implementations can be run over the same cases and their disagreements read
off rather than argued about. Built for
[x402-foundation/x402#3104](https://github.com/x402-foundation/x402/issues/3104).

Nothing in `fixtures.json` names a check id, a rule id, a severity, or a grade. A tool
joins the corpus by writing an **adapter** from its own vocabulary to this one. Two
adapters ship here: `corpus/run-10x402.mjs` and `corpus/run-x402-doctor.mjs`.

---

## Why three outcomes

A response can be payment-valid and unusable by a common client, or payment-valid and
unindexable, or both. Collapsing those into one grade makes remediation ambiguous — a
seller told "C" cannot tell whether their money or their listing is at risk. So every
fixture carries three independent verdicts:

| dimension | the question |
| --- | --- |
| `payment` | Can the declared payment be interpreted and settled under the stated x402 version, **per the normative specification**? |
| `client_interop` | Will the **cited client implementations**, at the pinned versions, parse and execute it correctly? |
| `discovery` | Will registry-specific metadata be accepted and indexed by the **cited provider**? |

`discovery` is a **provider observation** by construction, and is labelled as one
everywhere it appears. A discovery failure is never evidence that a response violates the
protocol. This is the corpus's answer to *"provider observations should not silently become
protocol requirements"*: they are given their own dimension, their own evidence kind, and
no path into the other two.

The v2 specification's own canonical 402 is carried as a **must-pass calibration fixture**
and demonstrates exactly this: it passes `payment` and `client_interop`, and it fails
`discovery`, because it publishes no `extensions.bazaar`. One document, two correct and
opposite answers. A tool that grades the specification's own example anything but clean on
the first two dimensions is miscalibrated, and an earlier version of 10x402 graded it a C.

---

## Verdicts

Each dimension takes one of three values in an expectation:

- **`pass`** — the dimension's question is answered yes.
- **`fail`** — answered no. A `fail` MUST carry at least one `reason_tag`.
- **`n/a`** — **the dimension cannot be judged from this fixture as published.** Not a
  pass, not a failure, and not a hedge: the question does not arise. Two situations reach
  it, and they are the same situation. A v1-only response cannot be judged against
  registry requirements that are a v2 shape. A response whose v2 envelope did not decode,
  or whose `resource` is not the object a registry reads, has no registry metadata to
  judge. In both, there is nothing to index and nothing to inspect.

A results file may additionally record **`not-evaluated`** — *this tool did not run the
rules that would answer this*. An expectation may never use it. It is the only honest
answer for a check that needs something the corpus cannot supply (a live registry, a
settlement), and it is excluded from agreement statistics rather than counted as a pass.

`pass` and `n/a` carry an empty `reason_tags`. Reasons are why a dimension **failed**;
tools differ wildly in what they emit as advisory information and agree far more about what
is fatal, so admitting non-fatal tags into expectations would manufacture disagreements
that are about verbosity. Observational tags are still recorded — in the results files, as
`observed_tags`.

---

## Fixture shape

```jsonc
{
  "id": "v2-header-b64-urlsafe",            // stable, kebab-case, unique
  "title": "v2 header in url-safe base64",
  "response": {                              // the recorded response, verbatim
    "status": 402,
    "headers": { "payment-required": "eyJ4NDAy…" },
    "body": "{\"x402Version\":1,…}"
  },
  "context": { "method": "POST", "url": "https://example.com/api/thing" },
  "expected": {
    "payment":        { "verdict": "fail", "reason_tags": ["b64-urlsafe"] },
    "client_interop": { "verdict": "fail", "reason_tags": ["b64-urlsafe"] },
    "discovery":      { "verdict": "n/a",  "reason_tags": [] }
  },
  "evidence": [
    { "kind": "client-code", "ref": "@x402/core@2.23.0 … Base64EncodedRegex runs before atob()" },
    { "kind": "spec",        "ref": "specs/transports-v2/http.md § Payment Required Signaling" }
  ],
  "origin": { "kind": "10x402-suite", "ref": "test/fixtures/envelopes.mjs — …" },
  "calibration": "must-pass",                // optional
  "notes": "…"                               // optional
}
```

`context.url` is the URL the response was served from and `context.method` the verb it was
fetched with. Both matter: a declared crawler method that disagrees with the probed verb is
a real discovery failure, and it is not visible without the verb.

**The response is the fixture.** Not a URL — a recorded response. That is a deliberate
scope choice with a known cost and a known benefit, and the corpus contains a fixture that
demonstrates both: `v2-header-b64-whitespace` is a header padded with optional whitespace,
which HTTP strips before any live probe can see it, and which survives in a recording. A
live doctor and a recorded corpus see different populations of bug. Neither is a superset.

---

## Evidence, and what is normative

Every fixture cites where its expectation comes from. `kind` says how much weight the
citation carries:

| kind | normative? | means |
| --- | --- | --- |
| `spec` | **yes** | a section of the x402 specification at the pinned commit |
| `client-code` | for that client, at that version, and nothing else | observed behaviour of a pinned client implementation |
| `cdp-validator` | no | observed behaviour of the CDP Bazaar validator |
| `cdp-docs` | no | CDP's published seller documentation |
| `provider-observation` | no | observed behaviour of a named provider, or a live capture |
| `field-report` | no | a reproduced report from the x402 issue tracker |
| `house-opinion` | **no** | this corpus's own reasoning, cited as such |

`house-opinion` exists so that a rule with no external authority cannot masquerade as one.
The clearest case is the dual-stack consistency family: neither specification says a
seller's v1 body and v2 header must agree on payee or price, so every fixture asserting
that carries a `house-opinion` ref that says so in as many words. A reader is entitled to
reject those expectations and keep the rest.

---

## Reason tags

A closed vocabulary, defined in `corpus/vocabulary.mjs` and copied into `fixtures.json`
under `reason_tags` so the file stands alone. Tools map their own finding ids to tags; the
corpus never sees a tool's ids.

The vocabulary is versioned with the corpus. Adding a tag, or changing what one means, is a
`corpus_version` bump, because an expectation written against the old meaning is no longer
the same claim.

Tags are marked `fatal: true` in `vocabulary.mjs` when some rule mapping to them can reach
error severity — only those can appear in an expectation. The rest (`redirect`,
`free-tier-200`, `content-type`, `bazaar-output-example`, `legacy-v1-header-names`, …) are
observational and appear only in results.

---

## Adapters

An adapter reduces one tool's report to nine values: a verdict and a tag set per dimension.
Two rules make the reductions comparable across tools.

**1. One severity contract, applied to both tools.** A dimension **fails** when a finding
that speaks to it is an **error**. A warning or an informational finding is recorded and
fails nothing. This is the single most important thing for making a disagreement
meaningful: without it, the tables would mostly record that two projects draw their
severity lines in different places, which is not a fact about x402.

**2. Provenance decides which dimensions a finding speaks to.** In the 10x402 adapter this
is mechanical, because every check in its catalogue carries a `sources` array:

- cites the specification → speaks to `payment`
- cites client code → speaks to `client_interop`
- cites both → speaks to both
- cites neither (house opinion, a field report, a provider) → `payment`, the strict side
- regime `bazaar` → speaks to `discovery`

This is what the `sources` labelling is *for*: it makes "the spec says so" and "this client
does so" separable after the fact, which is the whole basis of the `payment` /
`client_interop` split.

`discovery` in the 10x402 adapter is the engine's own published `bazaar_ready` verdict
rather than a recount, including its `n/a`.

**One documented override.** The `DUAL_*` family compares a dual-stack seller's two
envelopes with each other. Two of the four cite client code alongside house opinion and two
do not, so rule 2 alone would split one family across two dimensions on the strength of a
citation rather than a meaning. They map to `payment` as a family — the consequence is
money at the wrong address or the wrong price — and every fixture carrying one keeps a
`house-opinion` evidence ref so nobody mistakes it for a protocol requirement.

The x402-doctor adapter cannot use rule 2, because the prototype's findings carry no
provenance; its rules are mapped by subject, and the mapping table is in
`corpus/run-x402-doctor.mjs` with its reasoning. Where the prototype places a rule
differently from 10x402, the difference is **preserved rather than harmonised** — that
placement difference is itself a finding, and `DISAGREEMENTS.md` reports it.

---

## Pins

`fixtures.json` carries a `pins` block. Everything a verdict depends on is in it: the
10x402 commit, `@x402/core` 2.23.0, `x402` 1.2.0, the x402 specification commit, and the
x402-doctor prototype commit **with its licence status**. A `client-code` citation is
meaningless without a version, and a `spec` citation is meaningless without a commit.

The prototype's repository publishes **no licence**, so no code from it is vendored here;
`corpus/run-x402-doctor.mjs` clones it to a temporary directory outside the repository and
imports from the clone. See the header of that file.

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
- **`corpus/run-10x402.mjs` reproduces every expectation, exactly** — verdict and tag set

The last one is a regression gate, not an oracle. Expectations here are hand-authored and
the adapter must reproduce them; when it did not, the mismatch was resolved by deciding
which side was wrong and saying so in writing. On the first run 98 of 102 matched, and the
four that did not resolved as two fixture errors and **two engine defects in 10x402**, both
fixed and both written up in `DISAGREEMENTS.md § Where 10x402 was wrong`. The independent
check on the corpus is the second implementation, not this test.
