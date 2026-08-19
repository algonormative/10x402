// Owner-facing payment alerts: Telegram (instant, primary) and email through
// Cloudflare Email Routing (secondary).
//
// They exist because the `settlements` table is a perfect record that nobody
// reads at 3am, and the one event this service is built to produce — a stranger
// paying for something — is worth a phone buzzing.
//
// FOUR RULES, and together they are the whole design.
//
//   AN ALERT NEVER TOUCHES THE PAYING CALLER. Everything here runs inside
//   ctx.waitUntil, after the response has shipped, and each channel is caught
//   independently. A dead Telegram, a revoked token, an unverified email
//   destination or a missing binding costs a notification and nothing else.
//
//   NO RETRIES. AN ALERT IS NOT A LEDGER. `settlements` is the source of truth;
//   a retry loop here would buy duplicate pings on a flaky network and still
//   lose the alert in a real outage. Fire once, drop it, move on.
//
//   A CHANNEL WITH NO CONFIG IS SKIPPED BEFORE ANY NETWORK CALL. Unset is a
//   working state — a deployment that never sets the secrets must behave
//   exactly as if this file did not exist.
//
//   ONLY VERIFIED MONEY IS WORTH A PING. Malformed headers and
//   facilitator-rejected payments are probe noise — anything on a public x402
//   index is scanned continuously — and paging on them would train the owner to
//   ignore the channel, which is the only way this feature can truly fail. The
//   two things that DO fire are a payment the facilitator accepted (settled or
//   not), and a call served with nothing checked at all.

import { EmailMessage } from 'cloudflare:email';
import { USDC_DECIMALS } from './catalog.js';
import { randomHex } from './x402.js';

// The email channel's identity. It need not be a real mailbox — Email Routing
// sends FROM the zone — but it must be ON the zone.
const ALERT_FROM = 'alerts@lemon-agent.dev';
const ALERT_FROM_NAME = '10x402';

const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org';

// Generous, because nobody is waiting: the response shipped before this ran. It
// exists only so a hung socket cannot pin a waitUntil open indefinitely.
const ALERT_TIMEOUT_MS = 10_000;

/**
 * Atomic USDC (6 decimals) rendered as money: "10000" → "$0.01".
 *
 * Anything that is not a run of digits is passed through labelled rather than
 * coerced — a NaN in a revenue alert is worse than an ugly one.
 */
export function formatUsdc(atomic) {
  const raw = String(atomic ?? '');
  if (!/^\d+$/.test(raw)) return `${raw || 'unknown'} (atomic)`;
  const padded = raw.padStart(USDC_DECIMALS + 1, '0');
  const whole = padded.slice(0, -USDC_DECIMALS);
  const frac = padded.slice(-USDC_DECIMALS).replace(/0+$/, '');
  return `$${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * Is this payer one of the house's own wallets?
 *
 * HOUSE_PAYERS is a non-secret var of public chain addresses, and it exists so
 * the owner's own test buys read as a drill. The distinction is the entire point
 * of the channel: if a test buy and a stranger's purchase produced the same
 * message, the loud one would stop meaning anything. Unset means every payer is
 * a third party, which fails towards TOO LOUD — the right direction here.
 */
export function isHousePayer(env, payer) {
  if (!payer) return false;
  const target = String(payer).trim().toLowerCase();
  return String(env?.HOUSE_PAYERS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(target);
}

/**
 * The alert's first line — the Telegram opener and the email subject, the same
 * string on purpose so a lock screen and an inbox preview say the same thing.
 */
export function alertHeadline(env, alert) {
  const amount = formatUsdc(alert.amount);
  const house = isHousePayer(env, alert.payer);
  const payer = alert.payer || 'unknown';

  if (alert.kind === 'unverified') {
    // The house marker still goes on: the owner's own probe hitting a down
    // facilitator is a configuration story, not a revenue story. The warning
    // stays either way — the leak is real in both cases.
    return (
      `SERVED WITHOUT VERIFICATION${house ? ' (test payer)' : ''} — ` +
      `${amount} ${alert.tool} — payer ${payer} — x-payment-error: ${alert.error}`
    );
  }

  const settled = alert.settleOk === 1 ? 'settled' : `SETTLE FAILED (${alert.error || 'unknown'})`;
  const lead = house ? 'test settlement' : 'THIRD PARTY PAID';
  return `${lead} — ${amount} ${alert.tool} — payer ${payer} — tx ${alert.txHash || 'none'} — ${settled}`;
}

/** The headline plus the detail a human needs before deciding to care. */
export function alertMessage(env, alert) {
  const subject = alertHeadline(env, alert);
  const lines = [subject, '', `endpoint ${alert.tool}`];
  lines.push(`amount   ${formatUsdc(alert.amount)}  (${alert.amount} atomic USDC on Base)`);
  lines.push(`payer    ${alert.payer || 'unknown'}`);

  if (alert.kind === 'unverified') {
    lines.push(`checked  NO — ${alert.error}`);
    lines.push('');
    lines.push('This lint was SERVED and the payment was never checked, so nobody paid for');
    lines.push('it. Serving anyway is deliberate (availability-first at a cent a call), but a');
    lines.push('run of these is the paid rail quietly down.');
  } else {
    lines.push('checked  yes — the facilitator returned isValid');
    lines.push(
      alert.settleOk === 1
        ? `settled  yes — ${alert.txHash}`
        : `settled  NO — ${alert.error || 'unknown'} (verified, so the caller was served)`
    );
    if (alert.settleOk === 1 && alert.txHash) {
      lines.push(`explorer https://basescan.org/tx/${alert.txHash}`);
    }
  }

  lines.push('');
  lines.push('The settlements table is the source of truth; this is a courtesy ping.');
  return { subject, text: lines.join('\n') };
}

/**
 * Fire every configured channel. NEVER THROWS, NEVER RETRIES.
 *
 * `allSettled` rather than `all` is load-bearing: the channels must not be able
 * to cancel each other, so a Telegram outage still leaves the email to arrive.
 */
export async function sendPaymentAlert(env, alert) {
  try {
    const { subject, text } = alertMessage(env, alert);
    await Promise.allSettled([sendTelegramAlert(env, text), sendEmailAlert(env, subject, text)]);
  } catch {
    /* best-effort by construction — see the rules at the top */
  }
}

/**
 * Telegram — the primary channel, because it is the one that buzzes.
 * TELEGRAM_API_BASE is overridable so the suite can point it at a local mock.
 */
async function sendTelegramAlert(env, text) {
  // Config presence FIRST, before anything that costs. Both halves are needed:
  // a token with no chat id has nowhere to send.
  if (!env?.TELEGRAM_BOT_TOKEN || !env?.TELEGRAM_CHAT_ID) return;

  const base = (env.TELEGRAM_API_BASE || DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
  try {
    // The RESPONSE IS NOT INSPECTED, and that is a decision: there is nothing to
    // do with a 400 here. No retry, and the money is already recorded. Reading
    // the body would only add a way to throw inside a waitUntil.
    await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      signal: controller.signal,
    });
  } catch {
    /* an unreachable Telegram costs a ping, nothing more */
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Email — the secondary channel, through the `send_email` binding.
 *
 * BOTH halves are checked before anything is built. The binding is absent
 * unless wrangler.toml declares `[[send_email]]` AND the account has Email
 * Routing enabled, so `env.ALERT_EMAIL?.send` is a genuine runtime question;
 * ALERT_EMAIL_TO is a secret and must name a VERIFIED Email Routing destination
 * or Cloudflare rejects the send. Until the zone is live this silently no-ops,
 * which is the intended state during setup rather than a failure to fix.
 */
async function sendEmailAlert(env, subject, text) {
  if (typeof env?.ALERT_EMAIL?.send !== 'function' || !env?.ALERT_EMAIL_TO) return;
  try {
    const raw = rawEmail({ to: env.ALERT_EMAIL_TO, subject, text });
    await env.ALERT_EMAIL.send(new EmailMessage(ALERT_FROM, env.ALERT_EMAIL_TO, raw));
  } catch {
    /* an unverified destination or a dead zone costs a ping */
  }
}

// --- RFC 5322 ---------------------------------------------------------------
//
// Hand-rolled, and the trade is worth stating. A MIME library would be a
// production dependency in a Workers bundle to produce seven headers and a
// plain-text body. What it costs is that the details have to be right, because
// Cloudflare PARSES what it is handed: CRLF line endings, a real Message-ID, a
// Date in the numeric-zone form, and a From: address matching the envelope sender.

const RFC2822_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RFC2822_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// 75 characters is the RFC 2047 § 2 ceiling for one encoded-word. Minus
// "=?UTF-8?B?" (10) and "?=" (2) that leaves 63 for the base64 itself, which
// carries 47 bytes — rounded down to 45, a multiple of 3.
const MAX_ENCODED_WORD_BYTES = 45;

/**
 * A header value, RFC 2047 encoded when it is not plain ASCII, split on
 * CODEPOINT boundaries so a multi-byte character is never cut in half.
 *
 * Embedded newlines are flattened first: a header value that can contain CRLF
 * is a header-injection hole, and this subject is built from an endpoint id and
 * a facilitator's error string.
 */
export function encodeHeaderValue(value) {
  const text = String(value).replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7E]*$/.test(text)) return text;

  const encoder = new TextEncoder();
  const words = [];
  let chunk = '';
  let size = 0;
  for (const ch of text) {
    const width = encoder.encode(ch).length;
    if (size + width > MAX_ENCODED_WORD_BYTES && chunk) {
      words.push(chunk);
      chunk = '';
      size = 0;
    }
    chunk += ch;
    size += width;
  }
  if (chunk) words.push(chunk);

  // Continuation lines join with CRLF + one space: the RFC 5322 folding rule.
  // RFC 2047 drops the whitespace between adjacent encoded-words on decode, so
  // the subject reassembles exactly.
  return words.map((w) => `=?UTF-8?B?${b64(encoder.encode(w))}?=`).join('\r\n ');
}

function b64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function formatMailbox(name, address) {
  if (!name) return `<${address}>`;
  const encoded = encodeHeaderValue(name);
  // An encoded-word is already an atomic token and must NOT be quoted; a plain
  // display name is quoted so punctuation cannot be read as address syntax.
  const display = encoded.startsWith('=?') ? encoded : `"${name.replace(/(["\\])/g, '\\$1')}"`;
  return `${display} <${address}>`;
}

/**
 * RFC 2822 § 3.3 date, in UTC. Built from the UTC getters rather than
 * toUTCString(), which ends in "GMT" where the grammar wants a numeric zone —
 * legal only as obsolete syntax, which is what a strict parser declines.
 */
export function rfc2822Date(date) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${RFC2822_DAYS[date.getUTCDay()]}, ${p(date.getUTCDate())} ` +
    `${RFC2822_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} +0000`
  );
}

/**
 * A Message-ID that is actually unique. Cloudflare REQUIRES the header — a
 * message without one is rejected outright — and a duplicate invites mail
 * clients to thread two unrelated alerts into one.
 */
function newMessageId() {
  const domain = ALERT_FROM.split('@')[1];
  return `<${Date.now().toString(36)}.${randomHex(8)}@${domain}>`;
}

/** The whole message: headers, a blank line, and a plain-text body. */
export function rawEmail({ to, subject, text, date = new Date() }) {
  const headers = [
    `From: ${formatMailbox(ALERT_FROM_NAME, ALERT_FROM)}`,
    `To: ${formatMailbox(null, to)}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${rfc2822Date(date)}`,
    `Message-ID: ${newMessageId()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  // CRLF throughout, including inside the body — a bare LF in an SMTP payload
  // is the classic silently-corrupted-message bug.
  const body = String(text).replace(/\r?\n/g, '\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}
