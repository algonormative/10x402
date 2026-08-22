// The `_x402` TXT grammar and the `/.well-known/x402` manifest rules, as pure
// functions. No fetch, no Worker globals, no env — the same purity discipline
// as worker/lint.js, and for the same reason: the suite runs it with no server.
//
// ------------------------------------------------------------------ authority
//
// These rules come from `draft-hawkins-x402-dns-discovery-02`, an IETF Internet-
// Draft, plus one completed IANA allocation:
//
//   TXT,_x402,[draft-hawkins-x402-dns-discovery-01]
//   — IANA "Underscored and Globally Scoped DNS Node Names" registry (RFC 8552),
//     entered 2026-08-11 through designated-expert review.
//
// THAT IS NOT THE x402 SPECIFICATION, and this file does not pretend otherwise.
// This repository's provenance vocabulary has seven kinds — spec, client-code,
// cdp-docs, cdp-validator, live, field-report, house-opinion — and an
// independent Internet-Draft is none of them. It is stronger than a
// house-opinion (a standards body's designated expert reviewed the node name)
// and weaker than `spec` (the x402 project has not adopted it; PR
// x402-foundation/x402#2979 is open and undisposed). The checks that cite it
// therefore carry a distinct kind, `ietf-draft`, and — like `cdp-*` — it may
// decide only the discovery-facing question and may never fail payment or
// client interoperability. An endpoint that publishes no DNS record takes money
// perfectly well. It is unfindable by a resolver, which is a different
// sentence, and the whole point of keeping the regimes apart.
//
// ------------------------------------------------------------ port, not vendor
//
// This is a PORT of `src/x402/discovery.ts` from @flareclaw/x402-trust, not a
// copy of it, and the difference matters enough to say in the file: a vendored
// copy can claim to be byte-identical and a port cannot. Claiming byte-identity
// for something that is not is how a true statement rots into a false one
// without anybody editing it.
//
// What is claimed instead is checkable and stronger: the port reproduces the
// published conformance vectors, verdict for verdict, including hint strings.
// `test/discovery-grammar.test.mjs` runs
// `test/fixtures/discovery-txt-vectors.json` — ten records, six of them
// observed in the wild with the host and date attached — through the functions
// below and asserts every field. If the canonical implementation and this port
// ever diverge on a case the vectors cover, the suite fails here. The second
// implementation is the check, which is this repository's own doctrine for the
// corpus (corpus/FORMAT.md § Self-consistency) applied to itself.

const TXT_VERSION = 'x402-1';
const KINDS = ['facilitator', 'resource-server', 'both'];

/**
 * A record that is present and broken, as distinct from a record that is
 * absent. Carried as a type rather than a message so classification can never
 * be steered by the contents of an attacker-authored TXT record.
 */
export class GrammarViolation extends Error {}

/**
 * Parse a `_x402` TXT record: `v=x402-1; wk=https://…; k=…; net=…; scheme=…`.
 *
 * Returns null for a record that does not declare this version — a future
 * version's record must not fail today's resolver, it must be skipped. Throws
 * for a record that claims this version and then breaks the grammar.
 */
export function parseTxtRecord(txt) {
  const fields = new Map();
  let duplicateKey = null;

  for (const part of String(txt).split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    // A key repeated inside ONE record is malformed, and "last wins" is the
    // dangerous way to handle it: another conformant implementation could
    // reasonably take the first, and the two would then resolve to different
    // manifests with nothing anywhere able to detect the disagreement. Noted
    // here and thrown after the version gate, so a foreign record with a
    // repeated key is still just foreign.
    if (fields.has(key)) duplicateKey = key;
    else fields.set(key, trimmed.slice(eq + 1).trim());
  }

  // Case-SENSITIVE: the token names the format version.
  if (fields.get('v') !== TXT_VERSION) return null;

  if (duplicateKey) throw new GrammarViolation(`duplicate key "${duplicateKey}" in one TXT record — ambiguous, refusing`);
  const wk = fields.get('wk');
  if (!wk) throw new GrammarViolation('TXT record missing wk=<manifest url>');
  if (!wk.startsWith('https://')) throw new GrammarViolation(`wk must be HTTPS: ${wk}`);
  const k = fields.get('k');
  if (k && !KINDS.includes(k)) throw new GrammarViolation(`invalid k=${k}`);

  const list = (key) => fields.get(key).split(',').map((s) => s.trim()).filter(Boolean);
  return {
    v: TXT_VERSION,
    wk,
    ...(k ? { k } : {}),
    ...(fields.has('net') ? { net: list('net') } : {}),
    ...(fields.has('scheme') ? { scheme: list('scheme') } : {}),
  };
}

/** Keys observed in the wild carrying the manifest URL under another name. */
const NEAR_MISS_URL_KEYS = ['url', 'manifest', 'x402-manifest', 'wk', 'href', 'uri'];

/**
 * What a `_x402` record IS, when it is not conformant.
 *
 * `parseTxtRecord` returning null is correct as a GATE and useless as a
 * DIAGNOSIS. A census of the Bazaar catalog on 2026-08-22 (1,609 hosts) found
 * five publishers at `_x402` in three mutually incompatible syntaxes:
 *
 *   v=x4021;descriptor=api;url=https://api.telemost.io/.well-known/x402
 *   v=x4021;url=https://tablint.dev/.well-known/x402
 *   x402-manifest=https://vibesprings.net/.well-known/x402.json
 *   https://api.auor.io/.well-known/x402                     (bare URL, no key)
 *
 * Every one points at its own domain — zero records anywhere in that census
 * pointed off-domain — so this is independent convergence, not squatting, and
 * two of them are two tokens from conformant. The risk to the name is
 * fragmentation, and a tool that silently skips a near-miss is how
 * fragmentation goes unreported: the publisher stays invisible and nobody ever
 * tells them they were one character away.
 *
 * Strict gate, generous diagnosis. `parseTxtRecord` is unchanged by any of this.
 */
export function diagnoseTxtRecord(txt) {
  try {
    const record = parseTxtRecord(txt);
    if (record) return { kind: 'conformant', record };
  } catch (err) {
    if (err instanceof GrammarViolation) return { kind: 'malformed', message: err.message };
    throw err;
  }

  const raw = String(txt).trim();
  const hints = [];
  let manifestUrl;

  // Shape 1: a bare https URL, no key at all.
  if (/^https:\/\/\S+$/i.test(raw)) {
    return { kind: 'near-miss', hints: ['record is a bare URL; the grammar is `v=x402-1; wk=<url>`'], manifestUrl: raw };
  }

  const fields = new Map();
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    fields.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }

  // Shape 2: a version token differing only by punctuation or case.
  const v = fields.get('v');
  if (v && v !== TXT_VERSION && v.toLowerCase().replace(/[-_.\s]/g, '') === TXT_VERSION.replace(/-/g, '')) {
    hints.push(`version token is "${v}"; it must be exactly "${TXT_VERSION}"`);
  }

  // Shape 3: the manifest URL present under a key that is not wk=.
  for (const key of NEAR_MISS_URL_KEYS) {
    const val = fields.get(key);
    if (key !== 'wk' && val && /^https:\/\//i.test(val)) {
      manifestUrl = val;
      hints.push(`manifest URL is carried in "${key}="; the grammar names it "wk="`);
      break;
    }
  }

  if (hints.length === 0) return { kind: 'foreign' };
  return { kind: 'near-miss', hints, ...(manifestUrl ? { manifestUrl } : {}) };
}

/** Render the conformant record for a manifest URL — the fix string, generated. */
export function buildTxtRecord({ manifestUrl, kind, networks, schemes }) {
  const parts = [`v=${TXT_VERSION}`, `wk=${manifestUrl}`];
  if (kind) parts.push(`k=${kind}`);
  if (networks?.length) parts.push(`net=${networks.join(',')}`);
  if (schemes?.length) parts.push(`scheme=${schemes.join(',')}`);
  return parts.join('; ');
}

/**
 * The wk URL must live on the queried domain or below it. A TXT record may not
 * hand a crawler somebody else's manifest.
 */
export function isWkInDomain(wkUrl, domain) {
  try {
    const host = new URL(wkUrl).hostname.toLowerCase();
    const d = String(domain).toLowerCase().replace(/\.$/, '');
    return host === d || host.endsWith(`.${d}`);
  } catch {
    return false;
  }
}

export const MAX_ANCESTOR_STEPS = 2;

/**
 * The `_x402` owner names to query for a host, nearest first.
 *
 * WHY A WALK AT ALL, and why a bounded one. `_x402.<domain>` never said WHICH
 * domain a consumer holding a resource URL should ask for, and the omission is
 * not academic: the draft's own author publishes at the apex with the manifest
 * on a service subdomain — the natural arrangement for one DNS zone in front of
 * several hosts — so the narrow reading recorded the spec's author as a
 * non-publisher. Revision -02 answers it: the host first, then at most two
 * ancestors, and never a name with fewer than two labels.
 *
 * The Public Suffix List is deliberately NOT consulted. It is a mutable
 * third-party file, and a resolver whose answer depends on which snapshot of it
 * you happen to have is not deterministic. Two labels plus the coverage rule
 * below does the same work without the dependency.
 */
export function discoveryNamesFor(hostOrUrl) {
  let host = String(hostOrUrl).trim().toLowerCase();
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return [];
    }
  }
  host = host.replace(/\.$/, '').replace(/:\d+$/, '');
  if (!host || host.startsWith('.') || host.includes('/') || host.includes(' ')) return [];

  // AN ADDRESS LITERAL HAS NO NAME TO PUBLISH UNDER, so it gets no names at
  // all — not even itself. Without this the label walk treats the dots in an
  // IPv4 address as delegation and asks for `_x402.0.0.1` and `_x402.0.1`,
  // which are somebody else's zones and nothing to do with the target. Found
  // by wiring this surface into a suite whose mock target is 127.0.0.1; the
  // canonical implementation has the same gap and it is reported upstream.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':')) return [];

  const labels = host.split('.');
  if (labels.length < 2 || labels.some((l) => l === '')) return host ? [host] : [];
  const names = [host];
  for (let i = 1; i <= MAX_ANCESTOR_STEPS && labels.length - i >= 2; i++) {
    names.push(labels.slice(i).join('.'));
  }
  return names;
}

/**
 * Does a manifest found at `ownerName` speak for `host`?
 *
 * True unconditionally when it was found at the host itself. For an ancestor
 * the manifest MUST NAME the host — otherwise one record on a shared-hosting
 * platform would vouch for every tenant beneath it, including tenants who
 * published nothing, and the discovery layer would manufacture adopters it does
 * not have. That is not hypothetical: a deliberate control in the census showed
 * `zzq-discovery-control-9931.flareclaw.app`, a host that does not exist,
 * inheriting its parent's record.
 *
 * A named host only counts when the owner could legitimately speak for it, so a
 * manifest cannot vouch for a host outside its own zone either.
 */
export function manifestCoversHost(manifest, ownerName, host) {
  const owner = String(ownerName).toLowerCase().replace(/\.$/, '');
  const target = String(host).toLowerCase().replace(/\.$/, '');
  if (owner === target) return true;
  if (!(target === owner || target.endsWith(`.${owner}`))) return false;
  if (typeof manifest !== 'object' || manifest === null) return false;

  const hostOf = (u) => {
    if (typeof u !== 'string') return null;
    try {
      return new URL(u).hostname.toLowerCase();
    } catch {
      return null;
    }
  };

  const named = [];
  const base = hostOf(manifest.facilitator?.baseUrl);
  if (base) named.push(base);
  if (Array.isArray(manifest.resources)) {
    for (const r of manifest.resources) {
      const h = hostOf(typeof r === 'string' ? r : (r?.url ?? r?.resource));
      if (h) named.push(h);
    }
  }
  return named.some((n) => n === target && (n === owner || n.endsWith(`.${owner}`)));
}

/**
 * A rooted relative path, safe to concatenate onto baseUrl and fetch.
 *
 * A leading single "/" makes authority injection impossible — nothing after it
 * reaches the authority component — and "@", "://", "//", whitespace and
 * backslash are refused outright. Without this an endpoint value aims a
 * conforming crawler at a third party, which is the amplification the
 * same-origin rule on baseUrl exists to stop, moved one field down.
 */
export function isSafeRelativePath(p) {
  return typeof p === 'string'
    && p.startsWith('/') && !p.startsWith('//')
    && !p.includes('@') && !p.includes('://')
    && !/[\s\\]/.test(p);
}

/**
 * Every structural violation in a manifest, each labelled with WHO introduced
 * the requirement it breaks.
 *
 * The label is the point. A host failing only on `introducedBy:
 * 'x402-discovery'` was a valid x402 manifest before this extension existed and
 * is one mechanical edit from valid after it; a host failing a `core` rule has
 * a different problem. Reporting them identically makes adoption look like a
 * wall instead of an afternoon, and the difference is most of the population:
 * of 910 hosts serving a document at the well-known path, 727 are mechanically
 * fixable and 426 fail on nothing but `kind`.
 *
 * Collecting all of them rather than throwing on the first is a correction of a
 * real defect, reported by Melchiorre Oliva on x402#2979 (2026-08-18): the
 * canonical resolver refused his manifest with `invalid kind: undefined` and
 * read no further, so everything else valid in it went unmentioned and he
 * learned one field per debugging round-trip.
 */
export function diagnoseManifest(manifest) {
  const v = [];
  if (typeof manifest !== 'object' || manifest === null) {
    return { ok: false, violations: [{ field: '(root)', message: 'manifest is not an object', introducedBy: 'core' }] };
  }

  if (typeof manifest.x402Version !== 'number') {
    v.push({ field: 'x402Version', message: 'missing x402Version', introducedBy: 'core' });
  }

  if (!KINDS.includes(manifest.kind)) {
    v.push({
      field: 'kind',
      message: manifest.kind === undefined
        ? 'missing kind — REQUIRED by this extension; add "facilitator", "resource-server" or "both"'
        : `invalid kind: ${JSON.stringify(manifest.kind)}`,
      introducedBy: 'x402-discovery',
    });
  }

  if (manifest.kind === 'facilitator' || manifest.kind === 'both') {
    const f = manifest.facilitator;
    if (!f) {
      v.push({ field: 'facilitator', message: 'kind includes facilitator but facilitator block missing', introducedBy: 'x402-discovery' });
    } else {
      if (typeof f.baseUrl !== 'string' || !f.baseUrl.startsWith('https://')) {
        v.push({ field: 'facilitator.baseUrl', message: 'facilitator.baseUrl must be HTTPS', introducedBy: 'x402-discovery' });
      }
      for (const ep of ['supported', 'verify', 'settle']) {
        const val = f.endpoints?.[ep];
        if (typeof val !== 'string') {
          v.push({ field: `facilitator.endpoints.${ep}`, message: `facilitator.endpoints.${ep} missing`, introducedBy: 'x402-discovery' });
        } else if (!isSafeRelativePath(val)) {
          v.push({ field: `facilitator.endpoints.${ep}`, message: `facilitator.endpoints.${ep} must be a rooted relative path (leading "/", no scheme/authority)`, introducedBy: 'x402-discovery' });
        }
      }
      if (!Array.isArray(f.kinds) || f.kinds.length === 0) {
        v.push({ field: 'facilitator.kinds', message: 'facilitator.kinds must be a non-empty array', introducedBy: 'x402-discovery' });
      } else {
        for (const k of f.kinds) {
          if (typeof k?.scheme !== 'string' || typeof k?.network !== 'string') {
            v.push({ field: 'facilitator.kinds[]', message: 'each kind needs {scheme, network}', introducedBy: 'x402-discovery' });
            break;
          }
        }
      }
    }
  }

  return { ok: v.length === 0, violations: v };
}

/**
 * True when a manifest's ONLY faults are requirements this extension
 * introduced. The population worth counting when anyone asks what the extension
 * costs already-deployed hosts.
 */
export function isOneEditAway(manifest) {
  const d = diagnoseManifest(manifest);
  return !d.ok && d.violations.every((x) => x.introducedBy === 'x402-discovery');
}
