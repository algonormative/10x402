# Accuracy audit of the 64-check catalog — shared brief

You are one of five independent auditors (three Claude, two Codex) verifying
the lint catalog of 10x402, an x402 conformance linter at ~/git/10x402. The
catalog is `CHECKS` in `worker/lint.js` — 64 checks, each with id, area
(http/v1/v2/dual/version/report), severity (error/warn/info), a `core` flag
(core error ⇒ grade F), a summary, and fix text in the implementation.

**The question, per check: is the RULE true?** Not "is the code clean" — is
the claim the check makes about the x402 protocol, its clients, or CDP Bazaar
actually correct, at the right severity, with the right core status, and is
the fix text technically accurate? A linter that flags conformant envelopes
(over-strict) or blesses broken ones (under-strict) is wrong in a way that
matters commercially: this product's only asset is being right.

## Sources of truth (trust order — see .groundtruth/README.md)

1. `.groundtruth/spec-repo/specs/` — the protocol specs (v1, v2,
   transports-v2/http.md, extensions/bazaar.md, schemes/).
2. Client source — what buyers actually parse:
   `node_modules/@x402/core|evm|fetch` (v2) here, and
   `~/git/lemon-toolshed/node_modules/x402-fetch` (v1).
3. `.groundtruth/cdp-validator-toolshed.json` — Coinbase's validator verdict
   on a live conformant endpoint, captured today.
4. `worker/positive-control.js` — a real production 402 (both generations)
   frozen off the wire.
5. Field reports — x402 repo issues #3045, #3104, #3091, #3029.

RFC 2119 discipline: a spec MUST justifies severity `error`; a SHOULD
justifies at most `warn`; a house opinion or client-quirk defense must be
labeled as exactly that in your provenance, never dressed as spec. Where
spec and dominant client behavior disagree, report BOTH — that disagreement
is a finding, not a nuisance.

You may execute the engine — it is pure and needs no server:
`node --input-type=module -e "import('./worker/lint.js').then(async m => { ... })"`
Constructing a probe envelope and watching which checks fire is often the
fastest way to catch over/under-strictness. Do NOT modify any repo file.

## Output — strict format, one file

Write your verdicts to `.groundtruth/audit/<your-lens-name>.jsonl`:
one JSON object per line, one line per check, ALL 64, in catalog order:

{"id":"V2_B64_URLSAFE","verdict":"CONFIRMED","provenance":[{"kind":"client-code","ref":"@x402/core/dist/....js: decodePaymentRequired uses atob(...)"},{"kind":"spec","ref":"specs/transports-v2/http.md § Header encoding"}],"evidence":"one sentence: what you actually observed","correction":null}

- verdict ∈ CONFIRMED | WRONG | OVERSTRICT | UNDERSTRICT | MISCLASSIFIED |
  UNCERTAIN. MISCLASSIFIED = rule right, severity/core/area wrong.
  OVERSTRICT = flags conformant reality. UNDERSTRICT = misses broken reality.
- provenance kinds: spec | client-code | cdp-docs | cdp-validator | live |
  field-report | house-opinion. Every non-UNCERTAIN verdict needs ≥1 entry
  with an exact ref (file § section, or file:line, or URL). house-opinion is
  a legitimate kind — the point is to LABEL it so the catalog can be
  re-derived when sources move.
- correction: null, or one sentence saying what should change.
- After the 64 lines, append lines of the form
  {"summary":true,"non_confirmed":[...ids...],"notes":"..."} (one line).

Uncertainty discipline: UNCERTAIN with a precise question beats a confident
guess. You are one of five; disagreements get adjudicated, invented
provenance poisons the merge.
