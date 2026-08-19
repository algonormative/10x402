#!/usr/bin/env node
// 10x402 MCP server — a thin stdio wrapper over the public HTTP API.
//
// It holds no state, no key and no wallet: every tool is one fetch against
// {BASE}, and the reply is handed back as text. The HTTP surface stays the
// source of truth, so this file never needs to know the check catalogue.
//
//   lint_x402           {url, method?}                POST {BASE}/lint
//   lint_x402_envelope  {status, headers?, body?}     POST {BASE}/lint/envelope
//   x402_checks         {}                            GET  {BASE}/check
//
// BASE comes from TENX402_URL, defaulting to production.
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
      'successful settlement. Costs $0.01 per call, paid over x402; the first call answers 402 with ' +
      'the terms, which is a price quote and not an error. Follows no redirects, and refuses private ' +
      'addresses, non-https URLs and any port but 443 and 8443 — for those, use lint_x402_envelope.',
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
    name: 'lint_x402_envelope',
    description:
      'Check a 402 response you already have for the same conformance and discovery blockers. Paste ' +
      'its status, headers and body; each finding includes a specific fix. Nothing is fetched, so ' +
      'this works during an x402 v1 vs v2 migration, on staging, on localhost, behind auth, and on ' +
      'an endpoint that is not deployed yet. Costs $0.005, less than lint_x402 because there is no ' +
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
    name: 'x402_checks',
    description:
      'Start here. List the complete 64-check x402 catalogue, including code, severity, ' +
      'one-line summary, prices, and the grade ladder. FREE — no payment. Call this before choosing ' +
      'a paid lint, or to look up what a finding code means.',
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
    ...parsed.endpoints.map((e) => `  ${e.method} ${e.path}  ${e.price}  ${e.description}`),
    '',
    'Grades:',
    ...parsed.grades.map((g) => `  ${g.grade}  ${g.when}`),
    '',
    `Checks (${parsed.checks_total}). "core" marks the ones whose failure makes the envelope`,
    'unusable as published — one of those is an F.',
    '',
  ];
  for (const area of ['http', 'v2', 'v1', 'dual', 'version']) {
    const group = parsed.checks.filter((c) => c.area === area);
    if (!group.length) continue;
    lines.push(`## ${area}`);
    for (const c of group) {
      lines.push(`  ${c.id}  [${c.severity}${c.core ? ', core' : ''}]  ${c.summary}`);
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
      '`info` never affects the grade. Every finding carries a `fix` written to be applied directly.'
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

function formatAmount(atomic) {
  const n = Number(atomic);
  if (!Number.isFinite(n)) return 'an unreadable amount';
  return `$${(n / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `in about ${h}h ${m}m` : `in about ${m}m`;
}

const HANDLERS = {
  lint_x402: lint,
  lint_x402_envelope: lintEnvelope,
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
