// What a payment alert SAYS — the headline, the body, and the RFC 5322 message.
//
// Split out of worker/alerts.js so it can be imported by Node. alerts.js pulls
// in `cloudflare:email`, which only workerd can resolve, and a test process
// that merely wants to check that a Subject line is folded correctly should not
// have to boot a Worker to do it. The split is along a real seam anyway:
// everything here is a pure function of (env, alert), and everything there
// touches the network or a binding.
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

import { USDC_DECIMALS } from './catalog.js';
import { randomHex } from './x402.js';

// The email channel's identity. It need not be a real mailbox — Email Routing
// sends FROM the zone — but it must be ON the zone.
export const ALERT_FROM = 'alerts@lemon-agent.dev';
const ALERT_FROM_NAME = '10x402';

/**
 * Atomic USDC (6 decimals) rendered as money: "100000" → "$0.10".
 *
 * NEVER SHORTER THAN CENTS. Trailing zeros go, but not past two decimals: a
 * revenue alert reading "$0.1" next to one reading "$0.02" is a 10x misread in
 * the single message whose whole job is telling a human what moved. Sub-cent
 * amounts keep the digits they need ("5000" → "$0.005").
 *
 * Anything that is not a run of digits is passed through labelled rather than
 * coerced — a NaN in a revenue alert is worse than an ugly one.
 */
export function formatUsdc(atomic) {
  const raw = String(atomic ?? '');
  if (!/^\d+$/.test(raw)) return `${raw || 'unknown'} (atomic)`;
  const padded = raw.padStart(USDC_DECIMALS + 1, '0');
  const whole = padded.slice(0, -USDC_DECIMALS);
  const frac = padded.slice(-USDC_DECIMALS).replace(/0+$/, '').padEnd(2, '0');
  return `$${whole}.${frac}`;
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
 * The payer, as it may appear in a message.
 *
 * BEFORE VERIFY, THE PAYER IS A CLAIM THE CALLER TYPED. It is read out of
 * `payload.authorization.from`, and the unverified-serve path alerts with
 * exactly that value — so an address field holding fifty kilobytes became fifty
 * kilobytes of Telegram body and fifty kilobytes of email Subject header, from
 * one unauthenticated request. An EVM address is 42 characters; anything past
 * 80 is not an address that got long, it is something else.
 */
const payerLabel = (payer) => {
  const raw = String(payer ?? '').trim();
  if (!raw) return 'unknown';
  return raw.length > 80 ? `${raw.slice(0, 80)}… (+${raw.length - 80} characters)` : raw;
};

/**
 * The alert's first line — the Telegram opener and the email subject, the same
 * string on purpose so a lock screen and an inbox preview say the same thing.
 */
export function alertHeadline(env, alert) {
  const amount = formatUsdc(alert.amount);
  const house = isHousePayer(env, alert.payer);
  const payer = payerLabel(alert.payer);

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
  lines.push(`payer    ${payerLabel(alert.payer)}`);

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
