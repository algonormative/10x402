// Sending a payment alert: Telegram (instant, primary) and email through
// Cloudflare Email Routing (secondary).
//
// They exist because the `settlements` table is a perfect record that nobody
// reads at 3am, and the one event this service is built to produce — a stranger
// paying for something — is worth a phone buzzing. What the alert SAYS lives in
// worker/alert-message.js; this file is only about getting it out of the door.
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
//   ignore the channel, which is the only way this feature can truly fail.

import { EmailMessage } from 'cloudflare:email';
import { ALERT_FROM, alertMessage, rawEmail } from './alert-message.js';

const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org';

// Generous, because nobody is waiting: the response shipped before this ran. It
// exists only so a hung socket cannot pin a waitUntil open indefinitely.
const ALERT_TIMEOUT_MS = 10_000;

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

