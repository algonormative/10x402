#!/usr/bin/env node
// 10x402 MCP server — a thin stdio wrapper over the public HTTP API.
//
// It holds no state, no key and no wallet: every tool is one fetch against
// {BASE}, and the reply is handed back as text. The HTTP surface stays the
// source of truth, so this file never needs to know the check catalogue.
//
//   lint_x402                    {url, method?}             POST {BASE}/lint
//   lint_x402_one_check          {url, check, method?}      POST {BASE}/lint/one
//   lint_x402_envelope           {status, headers?, body?}  POST {BASE}/lint/envelope
//   lint_x402_envelope_one_check {status, check, …}         POST {BASE}/lint/envelope/one
//   check_x402_presence          {url, method?}             POST {BASE}/presence
//   x402_checks                  {}                         GET  {BASE}/check
//
// BASE comes from TENX402_URL, defaulting to production.
//
// ------------------------------------------------------------------ four tools, not two with a flag
//
// The single-check routes are separate TOOLS rather than an optional `check`
// parameter on the existing two, and the reason is the convention below: on this
// server a tool is a thing with A PRICE. A tool whose cost is $0.25 or $0.02
// depending on whether an argument is present cannot state its price in its own
// description, and an agent chooses between tools by reading exactly that. The
// schema does the rest of the work — `check` is REQUIRED here and absent there,
// so a client cannot half-use either shape — and an agent that only wants one
// answer finds a tool that only gives one answer, at the price of one answer.
//
// Run it:
//   npx -y github:chronick/10x402
//   node mcp/server.mjs
//
// ------------------------------------------------------------------ the 402 convention
//
// A 402 IS RETURNED AS A PRICE QUOTE, NOT AS `isError`. On this service the 402
// is the front door — every unpaid call meets it first — and an agent whose
// very first contact with the shop reads `isError: true` learns "broken tool",
// not "priced tool", and never comes back. The text explains the terms and what
// to do about them, as an ordinary result.
//
// Dependencies: @modelcontextprotocol/sdk, and Node 18+ for global fetch.
// Nothing else, deliberately. The low-level Server API is used rather than
// McpServer so the tool schemas are plain JSON Schema and zod is not imported.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE = (process.env.TENX402_URL || 'https://10x402.com').replace(/\/+$/, '');

const NAME = '10x402';
const VERSION = '0.1.0';

// USDC on Base is 6 decimals, so an atomic amount has to be divided down before
// it is shown to anyone as a price.
const USDC_DECIMALS = 6;

const TOOLS = [
  {
    name: 'lint_x402',
    description:
      'Find conformance blockers when an x402 endpoint passes validate but is not indexed, is not ' +
      'showing up in Bazaar, or publishes terms an agent cannot pay. Sends one unauthenticated ' +
      'request to the live URL and checks the HTTP response, v1 body envelope, v2 PAYMENT-REQUIRED ' +
      'header envelope, dual-stack consistency, and Bazaar discovery metadata. Each finding includes ' +
      'a specific fix. This identifies technical blockers; it does not guarantee indexing, demand, or ' +
      'successful settlement. Costs $0.25 per call, paid over x402; the first call answers 402 with ' +
      'the terms, which is a price quote and not an error. Follows no redirects, and refuses private ' +
      'addresses, non-https URLs and any port but 443 and 8443 — for those, use lint_x402_envelope. ' +
      'It is priced for the incident it resolves: a 402 that validates and still is not indexed. ' +
      'For a single question, lint_x402_one_check answers it for $0.02.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'the https URL of the paid endpoint to lint' },
        method: {
          type: 'string',
          enum: ['POST', 'GET'],
          description: 'how the endpoint is called. Defaults to POST, which is what most paid x402 endpoints take.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_x402_presence',
    description:
      'Find out where a live x402 resource actually stands with the registries — the other half of ' +
      'the stuck-seller question. lint_x402 answers whether the declaration is right; this answers ' +
      'whether the world can see it. Fetches the 402, reads the payTo and resource it declares, ' +
      'then checks three public surfaces: the full CDP Bazaar discovery catalog (scanned end to ' +
      'end), the x402scan explorer, and USDC transfer activity to the payTo on Base. Returns a ' +
      'per-registry verdict (listed / not_found / unknown) with the evidence and a specific way in ' +
      'for each miss; a surface that cannot be read reports unknown, never a guessed not_found. ' +
      'Costs $0.15 per served report, paid over x402; the first call answers 402 with the terms, ' +
      'which is a price quote and not an error.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'the https URL of the live x402 resource to look up' },
        method: {
          type: 'string',
          enum: ['POST', 'GET'],
          description: 'how the endpoint is called. Defaults to POST, which is what most paid x402 endpoints take.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'lint_x402_envelope',
    description:
      'Check a 402 response you already have for the same conformance and discovery blockers. Paste ' +
      'its status, headers and body; each finding includes a specific fix. Nothing is fetched, so ' +
      'this works during an x402 v1 vs v2 migration, on staging, on localhost, behind auth, and on ' +
      'an endpoint that is not deployed yet. Costs $0.10, less than lint_x402 because there is no ' +
      'outbound request. Use it whenever you can already see the response — from a curl, a test, or ' +
      'the code that builds it.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'integer', description: 'the HTTP status the endpoint answered with, e.g. 402' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'the response headers. Names are matched case-insensitively, so copy them however ' +
            'your client printed them. The one that matters most is PAYMENT-REQUIRED.',
        },
        body: { type: 'string', description: 'the response body as raw text, exactly as it came back' },
        url: { type: 'string', description: 'optional: the URL it came from, so resource.url can be cross-checked' },
      },
      required: ['status'],
      additionalProperties: false,
    },
  },
  {
    name: 'lint_x402_one_check',
    description:
      'Answer ONE named conformance check about a live x402 endpoint, for a fraction of the price ' +
      'of the full report. Use it when there is exactly one question — "is my v2 PAYMENT-REQUIRED ' +
      'header base64url", "does my bazaar info validate against its own schema" — and you already ' +
      'know which check answers it. Costs $0.02, paid over x402; the first call answers 402 with ' +
      'the terms, which is a price quote and not an error. Call x402_checks first (free) to get the ' +
      'exact check id. THE ANSWER HAS THREE OUTCOMES: passed, failed with a fix, or DID NOT APPLY ' +
      '— the last is not a pass and must never be reported as one. This is the tool for a CI step ' +
      'asserting one property on every commit. With a stack of questions about the same endpoint, ' +
      'lint_x402 eventually costs less and tells you what you did not think to ask; x402_checks ' +
      'publishes the exact crossover, free, before you pay for anything.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'the https URL of the paid endpoint to lint' },
        check: {
          type: 'string',
          description:
            'exactly one check id from x402_checks, e.g. V2_B64_URLSAFE. An unknown id costs nothing.',
        },
        method: {
          type: 'string',
          enum: ['POST', 'GET'],
          description: 'how the endpoint is called. Defaults to POST, which is what most paid x402 endpoints take.',
        },
      },
      required: ['url', 'check'],
      additionalProperties: false,
    },
  },
  {
    name: 'lint_x402_envelope_one_check',
    description:
      'Answer ONE named conformance check about a 402 response you already have. At $0.01 it is ' +
      'the cheapest answer this service sells, and nothing is fetched, so it works on staging, on ' +
      'localhost, behind auth, and on an endpoint that is not deployed yet. Ideal in a ' +
      'test or a CI step asserting a single property of a 402 that was just built. Call ' +
      'x402_checks first (free) for the exact check id. THE ANSWER HAS THREE OUTCOMES: passed, ' +
      'failed with a fix, or DID NOT APPLY to this response — the last is not a pass.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'integer', description: 'the HTTP status the endpoint answered with, e.g. 402' },
        check: {
          type: 'string',
          description:
            'exactly one check id from x402_checks, e.g. V2_B64_URLSAFE. An unknown id costs nothing.',
        },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'the response headers. Names are matched case-insensitively, so copy them however ' +
            'your client printed them. The one that matters most is PAYMENT-REQUIRED.',
        },
        body: { type: 'string', description: 'the response body as raw text, exactly as it came back' },
        url: { type: 'string', description: 'optional: the URL it came from, so resource.url can be cross-checked' },
      },
      required: ['status', 'check'],
      additionalProperties: false,
    },
  },
  {
    name: 'x402_checks',
    description:
      'Start here. List the complete x402 check catalogue — code, regime, severity, one-line ' +
      'summary and the SOURCES each rule is derived from (spec section, client source line, CDP ' +
      'requirement, or an explicitly labelled house opinion) — plus prices and the grade ladder. ' +
      'FREE — no payment. Call this before choosing a paid lint, to look up what a finding code ' +
      'means, or to check where a rule comes from before quoting it to someone.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

async function request(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new Error(`could not reach ${BASE}: ${String((err && err.message) || err)}`);
  }
}

async function post(path, payload) {
  const res = await request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.text();

  if (res.status === 402) return text(explainPayment(path, body, res));
  if (res.status === 429) return fail(explainQuota(path, body, res));
  if (res.status === 400 || res.status === 413) return fail(explainRefusal(path, body, res));
  if (!res.ok) return fail(`POST ${path} answered ${res.status}: ${body.trim()}`);

  return text(renderReport(body, res));
}

// ------------------------------------------------------------------ tools

async function lint(args) {
  const url = String(args.url || '').trim();
  if (!url) return fail('`url` is required — the https URL of the endpoint to lint.');
  const payload = { url };
  if (args.method) payload.method = String(args.method).toUpperCase();
  return post('/lint', payload);
}

async function checkPresence(args) {
  const url = String(args.url || '').trim();
  if (!url) return fail('`url` is required — the https URL of the live x402 resource to look up.');
  const payload = { url };
  if (args.method) payload.method = String(args.method).toUpperCase();
  return post('/presence', payload);
}

async function lintEnvelope(args) {
  if (args.status === undefined) {
    return fail(
      '`status` is required — the HTTP status the endpoint answered with (402 for a normal x402 ' +
        'challenge). Include `headers` and `body` too; each one you omit is a set of checks that ' +
        'cannot run.'
    );
  }
  const payload = { status: Number(args.status) };
  if (args.headers) payload.headers = args.headers;
  if (args.body !== undefined) payload.body = args.body;
  if (args.url) payload.url = args.url;
  return post('/lint/envelope', payload);
}

// The single-check pair. The missing-`check` refusal happens HERE, before the
// request: the service would answer the same 400 for free, but a round trip to
// be told a required field is missing is a round trip nobody needed.
const NEED_CHECK =
  '`check` is required — these tools answer about exactly one check. Call x402_checks (free) for ' +
  'the catalogue, e.g. {"check": "V2_B64_URLSAFE"}. To check everything at once, use lint_x402 ' +
  'or lint_x402_envelope instead.';

async function lintOneCheck(args) {
  const url = String(args.url || '').trim();
  if (!url) return fail('`url` is required — the https URL of the endpoint to lint.');
  if (!String(args.check || '').trim()) return fail(NEED_CHECK);
  const payload = { url, check: String(args.check).trim() };
  if (args.method) payload.method = String(args.method).toUpperCase();
  return post('/lint/one', payload);
}

async function lintEnvelopeOneCheck(args) {
  if (args.status === undefined) {
    return fail('`status` is required — the HTTP status the endpoint answered with (402 for a normal x402 challenge).');
  }
  if (!String(args.check || '').trim()) return fail(NEED_CHECK);
  const payload = { status: Number(args.status), check: String(args.check).trim() };
  if (args.headers) payload.headers = args.headers;
  if (args.body !== undefined) payload.body = args.body;
  if (args.url) payload.url = args.url;
  return post('/lint/envelope/one', payload);
}

async function checks() {
  const res = await request(`${BASE}/check`);
  const body = await res.text();
  if (!res.ok) return fail(`GET /check answered ${res.status}: ${body.trim()}`);

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return text(body.trim());
  }

  const lines = [
    `${parsed.service} — ${parsed.tagline}`,
    '',
    'Endpoints:',
    ...parsed.endpoints.map(
      (e) => `  ${e.method} ${e.path}  ${e.price}  ${e.scope ? `[${e.scope}]  ` : ''}${e.description}`
    ),
    ...(parsed.pricing?.note ? ['', `  ${parsed.pricing.note}`] : []),
    '',
    'Grades:',
    ...parsed.grades.map((g) => `  ${g.grade}  ${g.when}`),
    '',
    'Two verdicts:',
    '  grade         can I be PAID. From payment-regime findings only.',
    '  bazaar_ready  can I be FOUND. From bazaar-regime errors, blockers named.',
    '                "n/a" for a v1-only endpoint. Grade A with bazaar_ready false',
    '                is a real and common answer: payable, and not catalogued.',
    '',
    ...(parsed.regimes ? Object.entries(parsed.regimes).map(([name, what]) => `  ${name}: ${what}`) : []),
    '',
    `Checks (${parsed.checks_total}). "core" marks the ones whose failure makes the envelope`,
    'unusable as published — one of those is an F. Only a payment-regime check can be core.',
    'Each check lists its sources; quote them when you quote the rule.',
    '',
  ];
  // 'report' included: the two bound-disclosure checks are part of the catalogue
  // and leaving them out made the printed list disagree with checks_total.
  for (const area of ['http', 'v2', 'v1', 'dual', 'version', 'report']) {
    const group = parsed.checks.filter((c) => c.area === area);
    if (!group.length) continue;
    lines.push(`## ${area}`);
    for (const c of group) {
      lines.push(`  ${c.id}  [${c.regime ?? '?'}, ${c.severity}${c.core ? ', core' : ''}]  ${c.summary}`);
      for (const src of c.sources ?? []) lines.push(`      ${src.kind}: ${src.ref}`);
    }
    lines.push('');
  }
  return text(lines.join('\n'));
}

// ------------------------------------------------------------------ rendering
//
// The report is the product, so it comes back whole — as JSON, because the
// caller may want to act on it programmatically. What is added is a short
// reading guide first, because a wall of sixty-field JSON with no ordering
// advice is a report an agent will skim and misprioritise.

function renderReport(body, res) {
  let report;
  try {
    report = JSON.parse(body);
  } catch {
    return body.trim();
  }

  if (report.check) return renderSingle(report, res);

  const errors = report.findings.filter((f) => f.severity === 'error');
  const warns = report.findings.filter((f) => f.severity === 'warn');
  const infos = report.findings.filter((f) => f.severity === 'info');

  // A PARTIAL REPORT MUST NOT LEAD WITH A GRADE THAT READS AS A PASS. When the
  // endpoint answered something other than a 402 there was no envelope to read,
  // so the envelope checks did not run — and "Grade B, from 3 checks that
  // applied" is a sentence an agent will summarise as "it's fine". The caveat
  // goes FIRST, before the number, because that is the order it will be read in.
  const partial = report.summary?.partial;
  const lines = partial
    ? [
        `INCOMPLETE — ${partial}`,
        '',
        `Grade ${report.grade} is about the ${report.checks_run} checks that could run, and is NOT`,
        'a verdict on this endpoint\'s x402 envelope, which has not been read.',
      ]
    : [
        `Grade ${report.grade} — ${errors.length} error(s), ${warns.length} warning(s), ` +
          `${infos.length} info, from ${report.checks_run} checks that applied.`,
        // THE SECOND VERDICT GOES IN THE LEAD, not in the JSON below it. A
        // grade quoted on its own is the failure this split exists to fix:
        // "grade A" reads as "nothing to do" while the listing this seller
        // came here about is still blocked.
        ...(report.summary && 'bazaar_ready' in report.summary
          ? [
              report.summary.bazaar_ready === true
                ? 'Discovery: bazaar_ready — nothing blocks CDP from cataloguing this resource.'
                : report.summary.bazaar_ready === 'n/a'
                  ? 'Discovery: n/a — this is a v1-only endpoint, and CDP\'s requirements are a v2 shape. ' +
                    `Publishing a v2 header envelope is what makes the question apply${
                      report.summary.blockers?.length ? ` (blocked by: ${report.summary.blockers.join(', ')})` : ''
                    }.`
                  : `Discovery: NOT bazaar_ready. Blocked by ${report.summary.blockers?.join(', ') || 'unknown'}. ` +
                    'These do not affect the grade — the endpoint is payable — but CDP will not ' +
                    'catalogue it until they are fixed.',
            ]
          : []),
      ];

  if (partial) {
    // The advice block below is about working through envelope findings, and
    // there are none to work through.
  } else if (report.grade === 'A' && !report.findings.length) {
    lines.push('');
    lines.push('Nothing to fix. This envelope is conformant on every check that applied to it.');
  } else {
    lines.push('');
    lines.push(
      'Work the `error` findings first — those are what a client, a facilitator or the discovery',
      'index will reject or mis-read. Then `warn`: those work, but each one costs the seller',
      'something they probably want (discovery, a listing, a whole generation of clients).',
      '`info` never affects the grade. Every finding carries a `fix` written to be applied directly.',
      '',
      'Findings are in one of three regimes and they answer to different authorities: `payment`',
      'sets the grade, `bazaar` sets bazaar_ready, `hygiene` is advisory. A bazaar-regime error is',
      'not a defect in the 402 — it is a listing that will not happen — so say which kind you are',
      'reporting rather than merging them into one number.'
    );
  }

  if (report.truncated) lines.push('', `Note: ${report.truncated}`);
  if (report.note) lines.push('', `Note: ${report.note}`);

  lines.push('', JSON.stringify(report, null, 2));
  if (res.headers.get('x-payment-verified') === 'true') {
    lines.push('', '[10x402: payment verified and settling — you were charged for this call.]');
  } else if (res.headers.get('x-pricing') === 'pending') {
    lines.push(
      '',
      `[10x402: served WITHOUT the payment being verified (x-payment-error: ` +
        `${res.headers.get('x-payment-error') || 'unknown'}). The payment service could not be ` +
        'reached, so no money moved and you have not been charged. Nothing is owed.]'
    );
  }
  return lines.join('\n');
}

/**
 * One check's answer, and the lead line is the whole job.
 *
 * DID-NOT-APPLY GOES FIRST AND LOUDEST. An agent summarising this for a person
 * will keep the first line and drop the rest, and "V2_B64_URLSAFE — nothing
 * found" about a response with no v2 header is a sentence that would send a
 * seller to look somewhere else for a week. So the not-applied case never gets
 * to say "pass" anywhere near the top, and the JSON below it says `passed:
 * null` for a reader that goes looking.
 */
function renderSingle(report, res) {
  const lines = [];

  if (report.applied === false) {
    lines.push(
      `${report.check} DID NOT APPLY to this response. NOTHING about it was checked, and this is`,
      'NOT a pass — do not report it as one.',
      '',
      report.note || 'Its precondition was not met by this response.',
      '',
      'To find out what IS wrong with this response, buy the full report: lint_x402 for a live',
      'URL, lint_x402_envelope for a pasted one.'
    );
  } else if (report.passed) {
    lines.push(
      `${report.check} PASSED — this response is conformant on that one rule.`,
      '',
      `It is a ${report.regime}-regime check${report.core ? ', and a core one' : ''}, so a failure would have been ` +
        `${report.regime === 'payment' ? 'a payment or grade problem' : report.regime === 'bazaar' ? 'a listing blocker rather than a payment fault' : 'advisory only'}.`,
      'This says nothing about any other check. If the endpoint still misbehaves, the full report',
      'is the next call rather than a second single check.'
    );
  } else {
    const finding = report.finding || {};
    lines.push(
      `${report.check} FAILED — severity ${finding.severity || report.severity}, ${report.regime} regime` +
        `${finding.core ? ', CORE (the envelope is not usable as published)' : ''}.`,
      '',
      finding.message || 'the check emitted a finding',
      '',
      `Fix: ${finding.fix || 'see the finding below'}`
    );
    if (Array.isArray(report.findings) && report.findings.length > 1) {
      lines.push('', `This check emitted ${report.findings.length} findings; each carries its own fix. See the JSON below.`);
    }
  }

  if (report.note && report.applied !== false) lines.push('', `Note: ${report.note}`);

  lines.push(
    '',
    'This is ONE check out of the catalogue, bought at the single-check price. `grade` and',
    '`bazaar_ready` are whole-report verdicts and are deliberately not in this answer.',
    '',
    JSON.stringify(report, null, 2)
  );

  if (res.headers.get('x-payment-verified') === 'true') {
    lines.push('', '[10x402: payment verified and settling — you were charged for this call.]');
  } else if (res.headers.get('x-pricing') === 'pending') {
    lines.push(
      '',
      `[10x402: served WITHOUT the payment being verified (x-payment-error: ` +
        `${res.headers.get('x-payment-error') || 'unknown'}). The payment service could not be ` +
        'reached, so no money moved and you have not been charged. Nothing is owed.]'
    );
  }
  return lines.join('\n');
}

// A 402 is the front door, not an error to swallow. Quote the terms the
// envelope actually names, then say plainly what to do — and, if a payment was
// presented and rejected, exactly why.
function explainPayment(path, body, res) {
  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    envelope = null;
  }
  const offer = (envelope && Array.isArray(envelope.accepts) && envelope.accepts[0]) || null;

  const lines = [
    `POST ${path} answered HTTP 402 — the ordinary answer to a call that carried no payment.`,
    'This is the price, quoted in a form a client can pay. It is not a failure.',
  ];

  if (offer) {
    lines.push(
      '',
      'The x402 envelope asks for:',
      `  price   ${formatAmount(offer.maxAmountRequired)} (${offer.maxAmountRequired} atomic units)`,
      `  asset   USDC on ${offer.network || 'base'} — ${offer.asset || 'unknown asset'}`,
      `  payTo   ${offer.payTo || 'unknown address'}`,
      `  scheme  ${offer.scheme || 'exact'}`,
      `  for     ${offer.resource || `${BASE}${path}`}`
    );
  } else {
    lines.push('', 'The 402 body could not be parsed as an x402 envelope:', body.trim());
  }

  if (res.headers.get('payment-required')) {
    lines.push('', 'A v2 envelope is also published, in the PAYMENT-REQUIRED response header.');
  }

  // A 402 naming an invalidReason is a REJECTED payment, not a first ask: the
  // caller sent something and the facilitator refused it. Retrying the same
  // payload fails the same way, so say what to fix instead.
  if (envelope && envelope.invalidReason) {
    lines.push(
      '',
      `The payment presented was REJECTED: ${envelope.invalidReason}`,
      ...(envelope.invalidMessage ? [`  ${envelope.invalidMessage}`] : []),
      '',
      'Retrying the same payment payload will be rejected again. Common causes:',
      '  insufficient_funds                     the paying wallet has too little USDC on Base',
      '  invalid_exact_evm_payload_signature    the signature does not match the terms above',
      '  malformed_payment_header               the header was not base64-encoded JSON',
      'Sign a fresh payment against the terms above and retry once.'
    );
  }

  lines.push(
    '',
    'To pay, retry through an x402-capable HTTP client (x402-fetch, the x402 SDK, or Coinbase',
    'AgentKit) holding a wallet key with USDC on Base. The client reads this envelope, signs the',
    'payment and retries with a payment header. There is no login and no account — the payment is',
    'the auth. NEVER ask a person to paste a private key or a seed phrase.',
    '',
    'You are only charged for reports that are actually served: a 400 on a bad URL settles nothing,',
    'even when the payment verified.'
  );
  return lines.join('\n');
}

// A 429 is one of two things, and they want opposite advice: a deployment with
// no receiving address (waiting never helps) or the per-caller daily ceiling
// (waiting is exactly what helps).
function explainQuota(path, body, res) {
  let seen;
  try {
    seen = JSON.parse(body);
  } catch {
    seen = null;
  }
  const reason = (seen && seen.error) || '';
  const misconfigured = /receiving address/i.test(reason);
  const retryAfter = Number(res.headers.get('retry-after'));

  const lines = [
    `POST ${path} answered HTTP 429 — ${
      misconfigured ? 'this deployment has no receiving address configured.' : 'this caller reached the daily ceiling.'
    }`,
  ];
  if (seen) {
    lines.push('', `  reason  ${reason || 'daily limit reached'}`);
    if (seen.paid_tier) lines.push(`  paid    ${seen.paid_tier}`);
    lines.push(`  retry   ${seen.retry || 'tomorrow UTC'}${Number.isFinite(retryAfter) ? ` (${formatDuration(retryAfter)})` : ''}`);
  } else {
    lines.push('', 'The 429 body could not be parsed:', body.trim());
  }

  lines.push('');
  lines.push(
    misconfigured
      ? 'There is nowhere to send payment on this deployment, so this is a misconfiguration and not ' +
          'a quota: retrying changes nothing, now or tomorrow, and no Retry-After is sent because ' +
          'waiting cannot help.'
      : 'This is a runaway bound on one caller, keyed on the IP address — retrying with a different ' +
          'user-agent changes nothing, and neither does retrying in a loop.'
  );
  return lines.join('\n');
}

// A 400 from these endpoints always carries a `fix`. Surfacing it is the whole
// value of wrapping the error rather than passing the status through.
function explainRefusal(path, body, res) {
  let seen;
  try {
    seen = JSON.parse(body);
  } catch {
    return `POST ${path} answered ${res.status}: ${body.trim()}`;
  }
  const lines = [`POST ${path} answered ${res.status} — ${seen.error || 'the request could not be linted'}.`];
  if (seen.fix) lines.push('', seen.fix);
  lines.push('', 'Nothing was charged: you are only charged for reports that are actually served.');
  return lines.join('\n');
}

// Never fewer than two decimals: "$0.1 USDC" beside "$0.02 USDC" is a 10x
// misread, and this string is the price an agent decides on.
function formatAmount(atomic) {
  const n = Number(atomic);
  if (!Number.isFinite(n)) return 'an unreadable amount';
  return `$${(n / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS).replace(/(\.\d\d\d*?)0+$/, '$1')} USDC`;
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `in about ${h}h ${m}m` : `in about ${m}m`;
}

const HANDLERS = {
  lint_x402: lint,
  lint_x402_one_check: lintOneCheck,
  check_x402_presence: checkPresence,
  lint_x402_envelope: lintEnvelope,
  lint_x402_envelope_one_check: lintEnvelopeOneCheck,
  x402_checks: checks,
};

const server = new Server({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = HANDLERS[req.params.name];
  if (!handler) return fail(`unknown tool "${req.params.name}"`);
  try {
    return await handler(req.params.arguments || {});
  } catch (err) {
    return fail(String((err && err.message) || err));
  }
});

await server.connect(new StdioServerTransport());
