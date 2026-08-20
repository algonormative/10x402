# Ground-truth pack for the 64-check accuracy audit (2026-08-19)

Primary sources, in trust order:

1. `spec-repo/specs/` — the x402 protocol specs, sparse-cloned from
   github.com/x402-foundation/x402 at depth 1 today. Key files:
   x402-specification-v1.md, x402-specification-v2.md,
   transports-v2/http.md (the PAYMENT-REQUIRED / PAYMENT-SIGNATURE /
   PAYMENT-RESPONSE header contract), transports-v1/http.md,
   extensions/bazaar.md (the discovery extension), schemes/ (exact, upto…).
2. Client source code — what real buyers actually parse:
   - v2: ~/git/10x402/node_modules/@x402/core (+ @x402/evm, @x402/fetch)
   - v1: ~/git/lemon-toolshed/node_modules/x402-fetch and
     ~/git/lemon-toolshed/node_modules/@x402/* (both generations installed)
3. `cdp-validator-toolshed.json` — Coinbase's public validator verdict for a
   live conformant endpoint (toolshed.lemon-agent.dev), captured today.
4. Live wire captures — ~/git/10x402/worker/positive-control.js is a real
   production 402 (v1 body + v2 header) frozen as a fixture.
5. Field reports — github.com/x402-foundation/x402 issues #3045 (Bazaar
   indexing failure, 61 comments), #3104 (x402-doctor proposal), #3091
   (v1-only npm packages), #3029 (ajv on Workers).

A claim in the check catalog is CONFIRMED only if it traces to one of these.
"The reviewer said so" and "it seems right" are not sources.

---

NOTE (preserved copy): this pack originally lived in an untracked
`.groundtruth/` working directory. The spec sparse-clone it references is not
committed (third-party content, 1.7MB) — reproduce it with:
`git clone --depth 1 --filter=blob:none --sparse https://github.com/x402-foundation/x402 spec-repo && cd spec-repo && git sparse-checkout set specs`
