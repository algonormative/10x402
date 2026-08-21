# field-notes — the harvest loop's working surface

The maintained source of truth for the `x402-field-harvest` routine's tick
(spec: vault `meta/routines/x402-field-harvest.md`). The routine reads this
file end-to-end at STEP 0 and follows it; its own prompt only carries the
hard constraints. Humans edit this file; the routine never does.

**What this loop is.** The checks that earn their keep in `worker/lint.js`
came from failure reports: a seller stuck in a thread, a measurement someone
published, a validator behaving differently than its docs. This directory is
where those reports become *candidates* — provenance-carrying proposals that
an interactive engine session later implements (or rejects, with the reason
recorded). The routine automates the reading half; judgment stays human.

## The tick

1. **SWEEP.** Read new issues, discussions, and comments since the per-repo
   watermark in [`sweep-state.json`](sweep-state.json), across:
   `x402-foundation/x402` (issues + discussions), `coinbase/x402`,
   `Merit-Systems/x402scan` (issues). Public `gh` reads only. Advance the
   watermark to the newest item actually read, per repo — never to "now".
2. **CLASSIFY** each item into exactly one of:
   - **known** — an existing check id already covers it. If the report adds
     a new specimen or number, append it to that id's entry under
     [`evidence.md`](evidence.md) (create the file on first use).
   - **candidate** — a failure mode no check covers. Goes to PROPOSE.
   - **re-derivation flag** — a spec change, client release, or validator
     behavior shift that moves a document some check's `sources:` cites.
     Name the check ids affected; do not guess the new verdicts.
   - **noise** — one line saying why (support question, duplicate, not
     x402-conformance-shaped). Silence is not an allowed classification.
3. **PROPOSE** — at most 3 candidates per tick, deduped against the free
   catalogue (`GET https://10x402.com/check`) and everything already in
   [`candidates.md`](candidates.md). Use the candidate format below,
   complete: an entry missing provenance is not a candidate, it is a rumor.
4. **SHIP** — one branch, one PR: `field-harvest: <date> — <n> candidates,
   <m> re-derivations`. Body leads with a plain table (candidate · thread ·
   one-line verdict). Never merge; never touch `worker/`, `corpus/`, or
   `guides.mjs`. A tick with nothing new ships nothing — update the
   watermark and stop; a quiet ecosystem is a valid observation, and
   `sweep-state.json` counts consecutive quiet ticks for the kill criteria.

## Candidate format (candidates.md)

```markdown
### <proposed-check-id-or-slug> (<date>, status: proposed)

- **Failure mode:** one sentence, seller's-eye view.
- **Specimen:** the concrete case — host/shape/bytes as reported. Label
  measured vs asserted.
- **Provenance:** thread URL + comment timestamp + reporter; what they
  measured vs claimed. If it contradicts a spec section, say so and cite
  both sides — record the contradiction, never resolve it silently.
- **Proposed shape:** id / area / regime / severity, and WHY that regime
  (payment grades; bazaar blocks indexing; hygiene informs).
- **Proposed sources:** the `sources:[...]` block in the house format
  (`spec()` / `client()` / `validator()` / `field()` / `house()`).
- **Fixture sketch:** can a recorded response express it? If yes, the
  one-thing-changed delta from the reference envelope. If it needs a live
  observation, say which (and it may be live-only, like the negative
  control). If verifying it would require paying an endpoint:
  `verification: requires-spend` — owner's call.
- **Guide impact:** which of /guides/ (if any) should mention it.
```

Statuses move only in human sessions: `proposed → accepted (beads id) →
shipped (commit)` or `proposed → rejected (reason, kept for the record)`.

## Provenance rules (non-negotiable)

- Every number carries a date and a source. "276 of 14,691 on 2026-08-20"
  is a fact; "most listings are broken" is not writable here.
- Provider observations must not become protocol requirements — a CDP
  behavior is `validator`/`field` evidence, never `spec`.
- The reporter's own corrections supersede their earlier claims (the #3104
  negative-control thread self-corrected twice; the corrected numbers are
  the citable ones).
