#!/usr/bin/env bash
# UA-matrix probe of the DEPLOYED machine surfaces (vault-1wj82).
#
# WHAT IT PROVES: the Pages layer's Browser Integrity Check 403s Python-stdlib
# user agents (`error code: 1010`) on anything the Pages project serves —
# static assets and Pages Functions alike. The fix routes every machine
# surface through the zone Worker, so after `npx wrangler deploy` every cell
# in the matrix below must read 200, and every paid route must read 402 on
# the same UAs (the Worker's front door, unchanged).
#
# OWNER-RUN, POST-DEPLOY, BY HAND. Never called from the test suite (AF-06 —
# it touches the live host) and never billed: it sends only GETs, no
# X-PAYMENT header anywhere, and an unpaid request to a paid route is
# answered 402 before any store or facilitator is touched.
#
#   scripts/probe-ua.sh                     # probes https://10x402.com
#   scripts/probe-ua.sh https://host.dev    # or any deployed twin
set -euo pipefail

HOST="${1:-${PROBE_HOST:-https://10x402.com}}"

SURFACES=(/llms.txt /openapi.json /.well-known/x402 /skill.md /sitemap.xml /robots.txt)
PAID=(/lint /lint/one /lint/envelope /lint/envelope/one /monitor/verdict /monitor/history /monitor/receipt)
# "-" is the no-User-Agent case: curl only OMITS the header when -A is given
# an empty string (a bare request would silently send curl's own UA instead).
UAS=("Python-urllib/3.14" "python-requests/2.32" "curl/8" "node" "-")

fails=0
probe() { # $1 path, $2 ua, $3 expected status
  local path="$1" ua="$2" want="$3" got shown
  if [ "$ua" = "-" ]; then
    got=$(curl -sS -o /dev/null -w '%{http_code}' -A "" "${HOST}${path}")
    shown="(no user-agent)"
  else
    got=$(curl -sS -o /dev/null -w '%{http_code}' -A "$ua" "${HOST}${path}")
    shown="$ua"
  fi
  local mark="ok"
  if [ "$got" != "$want" ]; then
    mark="EXPECTED ${want}"
    fails=$((fails + 1))
  fi
  printf '%-24s %-22s %s  %s\n' "$path" "$shown" "$got" "$mark"
}

echo "probing ${HOST}"
echo
echo "── machine surfaces (all must be 200) ──"
for path in "${SURFACES[@]}"; do
  for ua in "${UAS[@]}"; do probe "$path" "$ua" 200; done
done
echo
echo "── paid routes, unpaid GET (all must be 402 — the front door, no billed call) ──"
for path in "${PAID[@]}"; do
  for ua in "${UAS[@]}"; do probe "$path" "$ua" 402; done
done
echo
if [ "$fails" -gt 0 ]; then
  echo "FAIL: ${fails} probe(s) off-expectation"
  exit 1
fi
echo "PASS: every surface 200, every paid route 402, on every UA"
