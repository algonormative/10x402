// The FOURTH presence surface: the one the seller publishes themselves.
//
// /presence already answers "am I in somebody else's index" three ways — the
// CDP Bazaar catalog, the x402scan explorer, settlement on Base. All three are
// indexes a seller must EARN: Bazaar rows are written by settlement, x402scan
// by registration, the chain by a real payment. A seller who has published
// nothing and settled nothing gets three `not_found`s and three fixes that all
// begin "first, go do something else".
//
// The self-published surface is the one they control outright. `_x402.<domain>`
// in DNS and `/.well-known/x402` over HTTPS need no settlement, no registration
// and nobody's permission — and a resolver following the discovery draft finds
// a seller through them without any index in the middle. It is also, measurably,
// the surface most sellers get wrong in a way nobody has ever told them about.
//
// ----------------------------------------------------------- what the census found
//
// 1,609 hosts from the Bazaar catalog, 2026-08-22, read-only, one DNS query and
// at most one GET each, per-host negative controls on both legs:
//
//   910 hosts (522 domains) serve a document at /.well-known/x402
//     3 of those are structurally valid
//   426 fail on nothing except the `kind` field
//   727 are mechanically fixable in total
//     1 host publishes a conformant _x402 TXT record
//     5 publish a near-miss, in three mutually incompatible syntaxes
//     0 records anywhere point off-domain
//
// The shape of that is the argument for this surface existing. Several hundred
// operators independently decided to publish a discovery document, agreed on
// the LOCATION, and each invented the CONTENTS — these are hand-authored and
// mutually inconsistent, sharing a `version: 1` convention no specification
// asked for. Nothing in the stack tells any of them. They are not unlisted
// because they did something hard wrong; they are unlisted because the one
// thing they did unprompted is the one thing nothing checks.
//
// ------------------------------------------------------------------ verdicts
//
// The top-level verdict stays in this route's existing three-value vocabulary —
// `listed` / `not_found` / `unknown` — so `summary.listed of N` keeps meaning
// what it meant. The precision lives in `evidence.dns` and `evidence.manifest`,
// which carry the sub-state, and in `fix`, which names the exact edit.
//
//   listed     a conformant _x402 record resolves for this host AND the
//              manifest it points at validates. This is the only state in which
//              a resolver following the draft finds this host at all.
//   not_found  anything short of that. The evidence says which half, and
//              near-miss is reported as near-miss rather than as absence.
//   unknown    a read failed, or a negative control fired. NEVER a guess.
//
// ------------------------------------------------------------------ controls
//
// Two negative controls per host, run FIRST, because without them this whole
// surface reports fiction:
//
//   TXT   _zzq-x402-control-9931.<name>. A zone with a wildcard TXT answers
//         every name, so `_x402.acu.run` returns that zone's SPF record and a
//         naive reader counts an adopter. The first full census run reported 18
//         hosts publishing a rival dialect; per-host controls cut it to 9, then
//         to 5. Every number moved DOWN as the instrument got honest.
//   HTTP  /.well-known/zzq-x402-control-9931. A host answering 200 for every
//         path hands back its own index page as a "manifest". Grading that
//         `invalid` would put a defect on a host that never claimed to publish
//         anything, so it is excluded rather than graded — the same posture as
//         the lint engine's HTTP_SOFT_404 and, for the DNS half, the same
//         hardening Circadian-agent applied on x402#3104.
//
// A negative control cannot detect the other failure — a reader that returns
// nothing for everything looks identical to a world with no records in it. The
// known-positive is therefore an invariant of the SUITE, not of a paid request:
// test/discovery-presence.test.mjs runs this observer against a mock serving
// the real api.sirenic.eu record bytes and requires `published`. Running a
// live known-positive on every paid call would mean billing a stranger's
// endpoint to prove our resolver works, which is not their bill to pay.
//
// -------------------------------------------------------------- Workers and DNS
//
// A Worker has no DNS API (see the note in worker/fetch-target.js). The lookup
// is therefore DNS-over-HTTPS — ordinary `fetch` against a JSON resolver — and
// the resolver base rides in on PRESENCE_DOH_BASE exactly like the other three
// surfaces, so the suite points it at 127.0.0.1 and never touches a live one.

import { timeoutMs } from './fetch-target.js';
import {
  diagnoseTxtRecord,
  diagnoseManifest,
  isOneEditAway,
  isWkInDomain,
  buildTxtRecord,
  discoveryNamesFor,
  manifestCoversHost,
} from './discovery-grammar.js';

export const dohBase = (env) => String(env?.PRESENCE_DOH_BASE || 'https://cloudflare-dns.com');

/**
 * Where the well-known path is read from.
 *
 * In production this is `https://<host>` and nothing else — the whole claim of
 * this surface is that the document came from the seller's own origin over TLS,
 * so there is no configuration that can move it. `PRESENCE_WK_ORIGIN` exists
 * for the suite alone, which points it at 127.0.0.1 and routes on the host it
 * carries in the path. Same seam shape as the other three surfaces.
 */
export const wellKnownUrl = (host, path, env) => {
  const override = env?.PRESENCE_WK_ORIGIN;
  // The override is honoured ONLY for loopback. Unlike the other PRESENCE_*
  // seams, this one carries a caller-influenced host into the URL, so a
  // misconfigured or hostile value would turn a paid presence check into an
  // open relay pointed wherever the var says. Loopback-only makes it useful to
  // the suite and useless to anybody else.
  if (override && /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?\/?$/i.test(String(override))) {
    return `${String(override).replace(/\/$/, '')}/${host}${path}`;
  }
  return `https://${host}${path}`;
};

/**
 * The control label. One constant, used for both legs, so a reader grepping an
 * access log can see exactly what we asked for and satisfy themselves it was
 * never going to exist.
 */
export const CONTROL_LABEL = 'zzq-x402-control-9931';

const UA = '10x402-presence/0.1 (+https://10x402.com)';

/** One bounded read, returning a parsed body or a NAMED failure. Never throws. */
async function read(url, env, { accept, asJson }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(env));
  try {
    const res = await fetch(url, { headers: { accept, 'user-agent': UA }, signal: controller.signal, redirect: 'follow' });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, why: `answered ${res.status}` };
    if (!asJson) return { ok: true, status: res.status, text, contentType: res.headers.get('content-type') };
    try {
      return { ok: true, status: res.status, json: JSON.parse(text), contentType: res.headers.get('content-type') };
    } catch {
      return { ok: false, status: res.status, why: 'answered 200 with something that is not JSON', notJson: true, contentType: res.headers.get('content-type') };
    }
  } catch (err) {
    return { ok: false, why: err?.name === 'AbortError' ? 'timed out' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * TXT strings at one name, via DNS-over-HTTPS.
 *
 * Two wire details that are easy to get wrong and both change the answer:
 *
 *  - A single TXT RR can be several character-strings, which the JSON resolver
 *    renders as `"part one" "part two"`. They CONCATENATE with no separator.
 *    Splitting on the space instead would shred a long wk= URL into two records
 *    and diagnose both as foreign.
 *  - The Answer array carries the whole chain, CNAMEs included. Only type 16 is
 *    a TXT record; reading the rest as text invents records.
 */
async function lookupTxt(name, env) {
  const url = `${dohBase(env)}/dns-query?name=${encodeURIComponent(name)}&type=TXT`;
  const res = await read(url, env, { accept: 'application/dns-json', asJson: true });
  if (!res.ok) return { ok: false, why: `DNS-over-HTTPS lookup ${res.why}` };

  const body = res.json || {};
  // 0 = NOERROR, 3 = NXDOMAIN. Both are answers. Anything else — SERVFAIL,
  // REFUSED — is the resolver declining, and declining is not evidence of
  // absence, so it becomes `unknown` rather than `not_found`.
  if (body.Status !== 0 && body.Status !== 3) {
    return { ok: false, why: `resolver returned DNS status ${body.Status}` };
  }

  const records = (Array.isArray(body.Answer) ? body.Answer : [])
    .filter((a) => a?.type === 16 && typeof a.data === 'string')
    .map((a) => {
      const chunks = a.data.match(/"(?:[^"\\]|\\.)*"/g);
      return chunks
        ? chunks.map((c) => c.slice(1, -1).replace(/\\(.)/g, '$1')).join('')
        : a.data;
    });

  return { ok: true, records };
}

/**
 * Observe both self-published legs for one host. Network; the assembler below
 * is pure and takes what this returns.
 */
export async function observeSelfPublished(host, env) {
  const names = discoveryNamesFor(host);
  if (names.length === 0) return { ok: false, why: `"${host}" is not a hostname this surface can query` };

  // Controls first, and BOTH are fatal to their own leg only. A wildcard TXT
  // zone says nothing about whether the well-known path is readable.
  const [txtControl, httpControl] = await Promise.all([
    lookupTxt(`_${CONTROL_LABEL}.${names[0]}`, env),
    read(wellKnownUrl(names[0], `/.well-known/${CONTROL_LABEL}`, env), env, { accept: '*/*', asJson: false }),
  ]);

  const dnsUninformative = txtControl.ok && txtControl.records.length > 0;
  const httpUninformative = httpControl.ok && httpControl.status === 200 && (httpControl.text || '').trim().length > 0;

  // The walk: the host first, then bounded ancestors. It STOPS at the first
  // name that answers with any TXT record at all — a host that publishes a
  // broken record has answered the question, and continuing to its parent
  // would replace the host's own broken record with the parent's good one and
  // report a fault that is not there as a success that is not either.
  let dns = { state: 'not_found', owner: null, records: [] };
  if (dnsUninformative) {
    dns = { state: 'uninformative_wildcard', owner: names[0], records: [] };
  } else if (!txtControl.ok) {
    dns = { state: 'unknown', why: txtControl.why, owner: null, records: [] };
  } else {
    for (const name of names) {
      const found = await lookupTxt(`_x402.${name}`, env);
      if (!found.ok) {
        dns = { state: 'unknown', why: found.why, owner: name, records: [] };
        break;
      }
      if (found.records.length > 0) {
        dns = { state: 'answered', owner: name, records: found.records };
        break;
      }
    }
  }

  // The manifest is read from the host itself, and — when a conformant record
  // named one — from the wk URL the record points at. They are usually the same
  // document and are allowed not to be.
  let manifest = { state: 'not_found' };
  if (httpUninformative) {
    manifest = { state: 'uninformative_soft_200' };
  } else if (!httpControl.ok && httpControl.why === 'timed out') {
    manifest = { state: 'unknown', why: 'the negative control timed out, so a read of the well-known path could not be trusted' };
  } else {
    // The URL reported in evidence is always the canonical one, never the test
    // seam: a report that names 127.0.0.1 as the source of a seller's manifest
    // would be a lie about provenance in the one field a reader checks.
    const canonical = `https://${names[0]}/.well-known/x402`;
    const got = await read(wellKnownUrl(names[0], '/.well-known/x402', env), env, { accept: 'application/json', asJson: true });
    if (got.ok) {
      manifest = { state: 'served', document: got.json, contentType: got.contentType, url: canonical };
    } else if (got.notJson) {
      manifest = { state: 'not_json', contentType: got.contentType, url: canonical };
    } else if (typeof got.status === 'number') {
      manifest = { state: 'not_found', status: got.status };
    } else {
      manifest = { state: 'unknown', why: got.why };
    }
  }

  return { ok: true, host: names[0], namesQueried: names, dns, manifest };
}

/** The fix strings. Generated from the observation where possible, never typed. */
function dnsFix(obs, manifestUrl) {
  const record = buildTxtRecord({ manifestUrl: manifestUrl || `https://${obs.host}/.well-known/x402` });
  return `Publish one TXT record at _x402.${obs.host} with the value:  ${record}  — the name is registered with IANA (RFC 8552 registry, entered 2026-08-11) and the grammar is draft-hawkins-x402-dns-discovery-02 § 4. Nothing has to settle first and nobody has to index you: a resolver reads it directly.`;
}

/**
 * Observation → report. PURE. Exported separately from the observer so the
 * suite can drive every branch with no network at all, and so the published
 * sample is this code over a real frozen capture rather than a hand-typed
 * example of what the code is supposed to say.
 */
export function assembleSelfPublished(obs) {
  if (!obs || obs.ok === false) {
    return { verdict: 'unknown', why: obs?.why || 'the self-published surface could not be observed', evidence: null, fix: null };
  }

  // ---- DNS half -----------------------------------------------------------
  let dns;
  if (obs.dns.state === 'unknown') {
    dns = { verdict: 'unknown', why: obs.dns.why };
  } else if (obs.dns.state === 'uninformative_wildcard') {
    dns = {
      verdict: 'unknown',
      why: `the zone answers TXT for _${CONTROL_LABEL}.${obs.host} as well, so it answers every name — a record at _x402 here would be indistinguishable from the wildcard and is not read as adoption`,
    };
  } else if (obs.dns.state === 'not_found') {
    dns = { verdict: 'not_found', names_queried: obs.namesQueried };
  } else {
    const diagnoses = obs.dns.records.map((txt) => ({ txt, ...diagnoseTxtRecord(txt) }));
    const conformant = diagnoses.filter((d) => d.kind === 'conformant');
    if (conformant.length > 1) {
      // Two conformant records at one name is ambiguous, and "take the first"
      // is silently divergent: another resolver could reasonably take the
      // other and reach a different manifest.
      dns = { verdict: 'malformed', found_at: obs.dns.owner, why: `${conformant.length} conformant _x402 records at one name — ambiguous, a resolver must refuse rather than pick` };
    } else if (conformant.length === 1) {
      const record = conformant[0].record;
      dns = isWkInDomain(record.wk, obs.dns.owner)
        ? { verdict: 'published', found_at: obs.dns.owner, record }
        : { verdict: 'malformed', found_at: obs.dns.owner, record, why: `wk points at ${record.wk}, which is outside ${obs.dns.owner} — a record may not hand a crawler another operator's manifest` };
    } else {
      const nearMiss = diagnoses.find((d) => d.kind === 'near-miss');
      const malformed = diagnoses.find((d) => d.kind === 'malformed');
      if (nearMiss) {
        dns = { verdict: 'near_miss', found_at: obs.dns.owner, record: nearMiss.txt, hints: nearMiss.hints, manifest_url_found: nearMiss.manifestUrl ?? null };
      } else if (malformed) {
        dns = { verdict: 'malformed', found_at: obs.dns.owner, record: malformed.txt, why: malformed.message };
      } else {
        // Every record at this name is about something else. That is an
        // absence of an x402 record, not a fault.
        dns = { verdict: 'not_found', names_queried: obs.namesQueried, note: `${diagnoses.length} TXT record(s) at this name, none of them about x402` };
      }
    }
  }

  // ---- manifest half ------------------------------------------------------
  let manifest;
  if (obs.manifest.state === 'unknown') {
    manifest = { verdict: 'unknown', why: obs.manifest.why };
  } else if (obs.manifest.state === 'uninformative_soft_200') {
    manifest = {
      verdict: 'unknown',
      why: `the host answers 200 for /.well-known/${CONTROL_LABEL} as well, so it answers every path — whatever it returns at /.well-known/x402 is not evidence that a manifest was published, and grading it would put a defect on a host that never claimed one`,
    };
  } else if (obs.manifest.state === 'not_found') {
    manifest = { verdict: 'not_found', status: obs.manifest.status ?? null };
  } else if (obs.manifest.state === 'not_json') {
    manifest = { verdict: 'invalid', url: obs.manifest.url, content_type: obs.manifest.contentType ?? null, violations: [{ field: '(root)', message: 'the well-known path answered 200 with something that is not JSON', introducedBy: 'core' }] };
  } else {
    const d = diagnoseManifest(obs.manifest.document);
    const covers = manifestCoversHost(obs.manifest.document, obs.host, obs.host);
    manifest = d.ok
      ? { verdict: 'valid', url: obs.manifest.url, content_type: obs.manifest.contentType ?? null, kind: obs.manifest.document.kind, covers_host: covers }
      : {
          verdict: isOneEditAway(obs.manifest.document) ? 'one_edit_away' : 'invalid',
          url: obs.manifest.url,
          content_type: obs.manifest.contentType ?? null,
          violations: d.violations,
        };
  }

  // ---- the surface verdict ------------------------------------------------
  //
  // `listed` requires BOTH halves, because either one alone leaves a resolver
  // unable to complete the walk: a record pointing at a document that does not
  // validate resolves to nothing, and a valid document nobody can find from DNS
  // is a file on a web server.
  const anyUnknown = dns.verdict === 'unknown' || manifest.verdict === 'unknown';
  const verdict = dns.verdict === 'published' && manifest.verdict === 'valid'
    ? 'listed'
    : anyUnknown
      ? 'unknown'
      : 'not_found';

  const fixes = [];
  if (manifest.verdict === 'one_edit_away') {
    const fields = manifest.violations.map((v) => v.field).join(', ');
    fixes.push(`The manifest at ${manifest.url} is valid x402 and fails only on fields this extension introduces (${fields}). ${manifest.violations.map((v) => `${v.field}: ${v.message}`).join(' ')} That is a one-line edit, not a rewrite — you are in the 727-of-910 population that is mechanically fixable.`);
  } else if (manifest.verdict === 'invalid') {
    fixes.push(`The document at ${manifest.url} does not validate: ${manifest.violations.map((v) => `${v.field}: ${v.message}`).join('; ')}.`);
  } else if (manifest.verdict === 'not_found') {
    fixes.push(`Serve a JSON manifest at https://${obs.host}/.well-known/x402 describing what you sell. It needs x402Version, kind ("facilitator", "resource-server" or "both") and your resources; a starter can be assembled from your existing catalog entries.`);
  }

  if (dns.verdict === 'near_miss') {
    fixes.push(`A record IS published at _x402.${dns.found_at}, under a different grammar: ${dns.hints.join('; ')}. Change the value to:  ${buildTxtRecord({ manifestUrl: dns.manifest_url_found || `https://${obs.host}/.well-known/x402` })}  — you are the closest kind of non-adopter there is, and five publishers in three incompatible syntaxes is the whole reason this check exists.`);
  } else if (dns.verdict === 'malformed') {
    fixes.push(`The record at _x402.${dns.found_at} claims this grammar and breaks it: ${dns.why}.`);
  } else if (dns.verdict === 'not_found') {
    fixes.push(dnsFix(obs, manifest.verdict === 'valid' || manifest.verdict === 'one_edit_away' ? manifest.url : null));
  }

  return {
    verdict,
    evidence: {
      source: 'the seller\'s own DNS and well-known path, read directly — no index in between',
      host: obs.host,
      dns,
      manifest,
      controls: `TXT at _${CONTROL_LABEL}.${obs.host} and GET /.well-known/${CONTROL_LABEL} were run first; a host that answers either one answers everything, and its readings are reported unknown rather than graded`,
    },
    fix: fixes.length > 0 ? fixes.join(' ') : null,
  };
}
