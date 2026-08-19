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
import { claimQuota, utcDay } from './quota.js';

const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org';

// Generous, because nobody is waiting: the response shipped before this ran. It
// exists only so a hung socket cannot pin a waitUntil open indefinitely.
const ALERT_TIMEOUT_MS = 10_000;

// ------------------------------------------------------------------ the daily budget
//
// A FIFTH RULE, added after a review pointed out that the four above bound
// everything except HOW MANY. Alerts fire per payment, and the paths that fire
// them include the unverified-serve path — which is exactly the path a
// misconfigured deployment or a facilitator outage puts every single call down.
// The first hour of a CDP outage was an alert per call, on a channel whose only
// purpose is to be noticed, which is how a notification channel dies: not by
// failing, by being muted.
//
// Twenty a day per channel. The cap is not a way of hiding events — the
// `settlements` table has all of them and is the source of truth — it is a way
// of keeping the twenty-first alert from destroying the value of the first.
const ALERT_DAILY = 20;

/** The alert budget. Env-tunable so the suite can exhaust it in three sends. */
function alertDaily(env) {
  const raw = Number(env?.ALERT_DAILY ?? ALERT_DAILY);
  if (!Number.isFinite(raw)) return ALERT_DAILY;
  return Math.min(1000, Math.max(1, Math.floor(raw)));
}

/**
 * Claim one send against today's budget for a channel.
 *
 * Returns 'send' (under the cap), 'final' (this is the one that trips it, and
 * it carries the notice instead of the alert) or 'silent'.
 *
 * THE CAP TRIPS ONCE AND SAYS SO. Going quiet without a word would leave the
 * owner reading an empty channel as "nothing happened", which is the same
 * failure as the flood and harder to notice. The ceiling passed to the claim is
 * cap + 1 precisely so there is one claim left to spend on saying it.
 *
 * With no DB bound this returns 'send': a courtesy channel must not stop
 * working because the store is missing, and a deployment with no D1 has larger
 * problems than its notification volume.
 */
async function claimAlertBudget(env, channel) {
  const db = env?.DB;
  if (!db) return 'send';
  const cap = alertDaily(env);
  try {
    const used = await claimQuota(db, utcDay(), `alert:${channel}`, cap + 1);
    if (used === null) return 'silent';
    return used <= cap ? 'send' : 'final';
  } catch {
    // The budget is a courtesy on top of a courtesy. If it cannot be read, send.
    return 'send';
  }
}

/** What the channel says as it goes quiet for the day. */
const cappedNotice = (env) =>
  `10x402 alerts: the daily cap of ${alertDaily(env)} has been reached, so no more will be sent ` +
  'today. Nothing is lost — every payment is in the `settlements` table, which is the source of ' +
  'truth. A day that hits this cap is usually one thing repeating: check for a run of ' +
  'verify_ok = 0 rows, which is the paid rail quietly down.';

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
  // Config presence FIRST, before anything that costs — including the budget
  // claim, which is a D1 write. An unconfigured channel must behave exactly as
  // if this file did not exist, and that includes not touching the store.
  if (!env?.TELEGRAM_BOT_TOKEN || !env?.TELEGRAM_CHAT_ID) return;

  const budget = await claimAlertBudget(env, 'telegram');
  if (budget === 'silent') return;
  const message = budget === 'final' ? cappedNotice(env) : text;

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
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message }),
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

  // Its OWN budget, not a share of Telegram's. The two channels have different
  // costs and different tolerances — an inbox absorbs more than a lock screen —
  // and a shared counter would let a Telegram flood silence email as well.
  const budget = await claimAlertBudget(env, 'email');
  if (budget === 'silent') return;
  const capped = budget === 'final';

  try {
    const raw = rawEmail({
      to: env.ALERT_EMAIL_TO,
      subject: capped ? 'alerts capped for today' : subject,
      text: capped ? cappedNotice(env) : text,
    });
    await env.ALERT_EMAIL.send(new EmailMessage(ALERT_FROM, env.ALERT_EMAIL_TO, raw));
  } catch {
    /* an unverified destination or a dead zone costs a ping */
  }
}

