# 10x402 content and UI review

> **A RECORD, NOT A LIVE SURFACE.** This is what one content review found and
> changed, dated at the commit that added it. Its "64 checks" is the count on
> that day; the catalogue has since been audited and grown, and every number a
> reader can act on is derived from `CHECKS.length` in `worker/lint.js`. Left
> unedited on purpose: a review rewritten to match the present is a review that
> can no longer be checked against what it reviewed.


## What was weak

- The page and README led with the category and the check count. The useful
  outcome — removing blockers between a working 402, discovery, and payment —
  arrived later.
- Several sentences treated missing demand, Bazaar indexing, or successful
  payment as conclusions the linter could prove. The code checks a published
  HTTP response and its envelopes; it does not query Bazaar, make a payment to
  the seller, or measure demand.
- The page showed paid `curl` requests before explaining that an unauthenticated
  call returns a 402 price quote. “That call really returns this” made the raw
  curl look as though it returned the paid JSON report.
- The free `/check` route — the clearest first step for a person or agent — was
  buried after the paid examples. Prices were correct but scattered.
- The 64-check catalogue was valuable and complete, but six long tables arrived
  with no compact overview or disclosure controls.
- The self-lint evidence sat below the full catalogue. The equally important
  privacy boundary was absent from the page.
- The README sample paired grade A with `V2_B64_URLSAFE`, a core error that must
  produce grade F.
- The HTML had a title, description, and canonical URL, but no complete document
  shell, social metadata, structured data, visible FAQ, or strong heading
  hierarchy.
- Tool and skill descriptions overclaimed “every problem” and used missing
  buyers as a diagnostic signal. A bounded linter can promise a specific fix for
  each finding, not an explanation for every possible business outcome.

## What changed, and why

- Reframed the opening around “Your 402 works. Agents still can’t pay you” and
  the sequence “Ship a correct 402 → get indexed → get paid.” Nearby caveats make
  clear that conformance removes technical blockers rather than guaranteeing any
  of those outcomes.
- Moved the 64 checks into the proof layer. The catalogue is described precisely:
  62 checks inspect HTTP/x402 conformance and two protect the honesty of partial
  or truncated reports.
- Added an early “Start here” path for a person and an agent, with the free
  catalogue first, route choice second, and payment behavior before paid
  examples.
- Consolidated prices into a scan-friendly comparison and labeled them per
  served report. The free catalogue is distinguished from a free lint tier,
  which does not exist.
- Put computed example reports behind disclosure controls and separated the
  unpaid request shape from the report returned after payment and retry.
- Promoted the two code-backed trust boundaries: the Worker-served 402 is tested
  by the linter and every build self-lints both paid envelopes; the application
  store persists no linted URL, pasted envelope, or report.
- Added visible FAQ answers for the search language sellers use: passes validate
  but not indexed, not showing up in Bazaar, v1 vs v2 migration, the x402
  conformance checklist, and endpoint discoverability.
- Added a complete semantic HTML shell, outcome-led title and description,
  canonical/OpenGraph/Twitter metadata, and honest `SoftwareApplication` and
  `FAQPage` JSON-LD. No ratings, users, testimonials, or fabricated demand were
  added.
- Linked the official x402 buyer quickstart at the paid-retry handoff and removed
  the invalid robots directive that treated the homepage as a sitemap.
- Improved accessible scanability with stronger heading levels, real text for
  the “core” marker, scoped table headers/captions, focus styles, responsive
  comparison blocks, and grouped catalogue sections. Dark/light support and the
  dependency-free workshop register remain intact.
- Aligned README, the installable skill, MCP tool descriptions, and catalogue
  descriptions around the same outcome and limitations. Prices, ids, routes,
  schemas, finding text, and runtime logic were left alone.
- Corrected the README report example from grade A to grade F.

## Honesty decisions

- The requested “64 conformance checks” wording was narrowed to a “64-check
  catalogue.” Two entries report truncation/bounds; calling all 64 endpoint
  conformance rules would be imprecise.
- The repository proves that the suite lints the 402 served by a local
  production-configured Worker and that `node build.mjs` fails on any finding
  before emitting `dist/`. It does not contain a CI workflow and the service is
  not deployed, so the copy does not claim that CI currently lints the public
  live domain.
- “The rules the Bazaar docs never wrote down” is retained as positioning
  supplied by the market research. Operational claims around Bazaar are phrased
  as possible blockers, not proof of crawl state or a guaranteed listing.
- Privacy language is scoped to the application store. The service does retain
  aggregate lint telemetry and the quota/payment records needed to operate; it
  does not claim to store nothing.
- The project is described as new, with no customers, testimonials, demand, or
  revenue implied.

## Recommended, not done

- Add focused evergreen pages for Bazaar discovery failures, “passes validate
  but not indexed,” v1-to-v2 migration, and the full conformance checklist. The
  launch page can answer each briefly, but one page cannot rank or teach deeply
  for all four jobs.
- Add a real `sitemap.xml` when those pages exist. The current build produces no
  sitemap document.
- Add an original OpenGraph image only when there is an approved visual asset.
  No external or invented asset was introduced for this pass.
- Add the actual CI workflow, then make the stronger CI trust claim and link to a
  public run. Until deployment, do not call the local workerd test a live-domain
  check.
- After launch, validate JSON-LD with a structured-data tester, submit the site
  to search consoles, and verify canonical/metadata from the public response.
- Add customer evidence only after it exists. Keep launch copy free of synthetic
  testimonials, usage counts, or demand claims.
- Consider a small client-side catalogue filter after observing real use. The
  disclosure-based table is adequate for launch and keeps the page dependency
  free.

## Verification in this workspace

- `node build.mjs` completed and printed `self-lint A with zero findings` for
  both paid endpoints.
- `npm test` was run before and after the edits. Both runs passed all 180
  pure-function tests, then the managed workspace blocked the next phase from
  opening its required `127.0.0.1` listener with `listen EPERM`. The remaining
  236 listener-based tests could not run in this sandbox, so a normal local or CI
  run must confirm the documented 416 total.
- `git diff --check` and JavaScript syntax checks completed without errors.
